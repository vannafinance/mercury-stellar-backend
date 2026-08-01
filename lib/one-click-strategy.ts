import { MarginAccountService } from './margin-utils';
import { BlendService } from './blend-utils';
import { SoroswapService } from './soroswap-utils';
import { AquariusService } from './aquarius-utils';
import { appendFarmHistory, buildFarmPoolKey } from './farm-history';

/** True when `poolProtocol` names the Aquarius AMM (case-insensitive). Every
 * LP call site below branches on this — Aquarius and Soroswap are different
 * contracts with different call shapes, so routing both through one service
 * silently added liquidity to the wrong pool. */
const isAquarius = (poolProtocol: string): boolean => poolProtocol.toLowerCase().includes('aquarius');

/** Protocol-aware "add liquidity from the margin account" — both pools here
 * are the XLM/USDC pair, so tokenA/tokenB are fixed for the Aquarius call. */
async function addLpLiquidity(
  poolProtocol: string,
  userAddress: string,
  marginAccountAddress: string,
  xlmAmt: number,
  usdcAmt: number,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const result = isAquarius(poolProtocol)
    ? await AquariusService.addLiquidity(userAddress, marginAccountAddress, 'XLM', 'USDC', xlmAmt, usdcAmt)
    : await SoroswapService.addLiquidity(userAddress, marginAccountAddress, xlmAmt, usdcAmt);

  // Record locally so the Farm pool detail page and Portfolio's Farm tab have
  // a Position History entry for this action even when it was opened through
  // Lite mode rather than the Farm page's own Add Liquidity form — this
  // helper is the single chokepoint both paths route through. (Farm's direct
  // Add Liquidity form already does this itself; see components/farm/add-liquidity.tsx.)
  if (result.success) {
    appendFarmHistory({
      protocol: isAquarius(poolProtocol) ? 'aquarius' : 'soroswap',
      poolKey: buildFarmPoolKey('XLM', 'USDC'),
      marginAccountAddress,
      action: 'add',
      amountDisplay: `${xlmAmt.toFixed(2)} XLM + ${usdcAmt.toFixed(2)} USDC`,
      txHash: result.hash ?? '',
    });
  }

  return result;
}

/** Protocol-aware "swap from the margin account" — used only for the 1x
 * (deposit-only) LP path, which must split a single deposited asset in half
 * before it has both tokens to pair into the pool. */
async function swapLpAsset(
  poolProtocol: string,
  userAddress: string,
  marginAccountAddress: string,
  tokenIn: TokenAsset,
  amountIn: number,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  if (isAquarius(poolProtocol)) {
    return AquariusService.aquariusSwapFromMargin(userAddress, marginAccountAddress, tokenIn, amountIn);
  }
  return SoroswapService.swapFromMargin(userAddress, marginAccountAddress, tokenIn, amountIn);
}

/**
 * Contract-level token symbol for a Vanna deposit/borrow call feeding an LP
 * pool. Mainnet uses a single Circle USDC for Aquarius and Soroswap (no
 * AQUSDC/SOUSDC variants). XLM passes through unchanged.
 */
function poolTokenSymbol(asset: TokenAsset, _poolProtocol: string, poolType: PoolType): string {
  if (poolType !== 'lp' || asset !== 'USDC') return asset;
  return 'USDC';
}

/** Protocol-aware "remove liquidity" for {@link closePosition}. */
async function removeLpLiquidity(
  poolProtocol: string,
  userAddress: string,
  marginAccountAddress: string,
  lpAmount: number,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const result = isAquarius(poolProtocol)
    ? await AquariusService.removeLiquidity(userAddress, marginAccountAddress, 'XLM', 'USDC', lpAmount)
    : await SoroswapService.removeLiquidity(userAddress, marginAccountAddress, lpAmount);

  if (result.success) {
    appendFarmHistory({
      protocol: isAquarius(poolProtocol) ? 'aquarius' : 'soroswap',
      poolKey: buildFarmPoolKey('XLM', 'USDC'),
      marginAccountAddress,
      action: 'remove',
      amountDisplay: `${lpAmount.toFixed(2)} LP`,
      txHash: result.hash ?? '',
    });
  }

  return result;
}

/* ─────────────────────────────────────────────────────────────────────────
   Close Position
   ─────────────────────────────────────────────────────────────────────────
   Reverse of executeOneClickStrategy:
     1. Withdraw from the external yield pool (Blend / Soroswap)
     2. Repay the Vanna loan
   The collateral in the margin account is freed and stays there for the
   user to withdraw manually via the Pro-mode withdraw flow.
   ───────────────────────────────────────────────────────────────────────── */

/** Inputs to {@link closePosition}. `exitPct` (1–100) scales how much to unwind. */
export interface ClosePositionParams {
  userAddress: string;
  marginAccountAddress: string;
  borrowAsset: TokenAsset;
  borrowAmount: number;       // total borrowed (human-readable)
  collateralAsset: TokenAsset;
  collateralAmount: number;   // user's deposited collateral
  poolProtocol: string;       // 'Blend' | 'Soroswap' | 'Aquarius'
  poolType: PoolType;
  poolTokens: string[];
  isSameAsset: boolean;       // collateral == borrow token?
  exitPct: number;            // 1-100
  onStep?: (msg: string) => void;
}

/**
 * Unwind a leveraged-yield position (full or partial via `exitPct`): withdraw
 * from the external pool (Blend single-asset, or Soroswap LP) then repay that
 * fraction of the Vanna loan. Same-asset positions deploy collateral+borrow into
 * the pool, so the withdraw covers both; cross-asset positions leave collateral
 * in the margin account (freed on repay) and only the borrow lives in the pool.
 * Freed collateral is NOT auto-withdrawn — the user pulls it via Pro-mode.
 * Returns `{ success:false, error }` on the first failing leg; never throws.
 */
export async function closePosition(params: ClosePositionParams): Promise<OneClickStrategyResult> {
  const {
    userAddress,
    marginAccountAddress,
    borrowAsset,
    borrowAmount,
    collateralAmount,
    poolProtocol,
    poolType,
    poolTokens,
    isSameAsset,
    exitPct,
    onStep,
  } = params;

  const step = (msg: string) => {
    onStep?.(msg);
  };

  const pct = Math.max(1, Math.min(100, exitPct)) / 100;
  const repayAmt = borrowAmount * pct;

  // For same-asset: collateral + borrow is all deployed in the external pool.
  // For cross-asset: only the borrowed amount lives in the pool (collateral
  //   stays in the margin account as security and is freed after repay).
  const withdrawAmt = isSameAsset
    ? (collateralAmount + borrowAmount) * pct
    : borrowAmount * pct;

  try {
    // ── Step 1: Withdraw from yield pool ──────────────────────────────────
    if (poolType === 'single') {
      const poolToken = poolTokens[0] as TokenAsset;
      step(`Step 1/2: Withdrawing ${withdrawAmt.toFixed(2)} ${poolToken} from ${poolProtocol}...`);
      const r = await BlendService.withdrawFromBlendPool(
        userAddress, marginAccountAddress, poolToken, withdrawAmt
      );
      if (!r.success) return { success: false, error: `Withdraw failed: ${r.error}` };
    } else {
      // LP pool — remove proportional liquidity (approx. borrowAmount as LP units)
      step(`Step 1/2: Removing liquidity from ${poolProtocol} ${poolTokens.join('/')} pool...`);
      const approxLpAmt = borrowAmount * pct;
      const r = await removeLpLiquidity(poolProtocol, userAddress, marginAccountAddress, approxLpAmt);
      if (!r.success) return { success: false, error: `Remove liquidity failed: ${r.error}` };
    }

    // ── Step 2: Repay Vanna loan ──────────────────────────────────────────
    if (repayAmt > 0) {
      step(`Step 2/2: Repaying ${repayAmt.toFixed(2)} ${borrowAsset} to Vanna...`);
      const repayWad = toWad(repayAmt);
      const r = await MarginAccountService.repayLoan(marginAccountAddress, borrowAsset, repayWad);
      if (!r.success) return { success: false, error: `Repay failed: ${r.error}` };
      return { success: true, hash: r.hash };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Close position failed' };
  }
}

/** Assets supported by the one-click flows. */
export type TokenAsset = 'XLM' | 'USDC';
/**
 * Relationship between the deposited collateral and what gets deployed:
 * - `same-asset`: collateral and pool token are identical (deploy directly).
 * - `cross-asset-keep`: deploy collateral and borrow into their own pools.
 * - `cross-asset-swap`: swap collateral to the pool token before deploying.
 */
export type Scenario = 'same-asset' | 'cross-asset-keep' | 'cross-asset-swap';
/** `single` = one-sided lending pool (Blend); `lp` = two-token AMM pool. */
export type PoolType = 'single' | 'lp';

/** Inputs to {@link executeOneClickStrategy}. `leverage` of 1 means deposit-only. */
export interface OneClickStrategyParams {
  userAddress: string;
  marginAccountAddress: string;
  collateralAsset: TokenAsset;
  collateralAmount: number;
  borrowAsset: TokenAsset;
  borrowAmount: number;
  leverage: number;
  poolProtocol: string;
  poolType: PoolType;
  poolTokens: string[];
  scenario: Scenario;
  prices?: Record<string, number>;
  onStep?: (msg: string) => void;
}

/** Result of a one-click open/close: success plus the final tx hash or an error. */
export interface OneClickStrategyResult {
  success: boolean;
  hash?: string;
  error?: string;
}

function toWad(amount: number): string {
  return (BigInt(Math.floor(amount * 1_000_000)) * BigInt(1_000_000_000_000)).toString();
}

// SmartAccountContract deducts a 0.3% origination fee from every borrow — the
// margin account is only ever credited `borrowAmount × (1 - fee)`, not the
// full requested amount (see ORIGINATION_FEE_WAD in smart_account.rs). Using
// the gross borrow amount for the AddLiquidity call overshoots the real
// credited balance and traps with "balance is not sufficient to spend". A
// slightly larger shave (0.35%) leaves a small buffer for WAD rounding.
const BORROW_ORIGINATION_FEE_BUFFER = 0.9965;
const netOfOriginationFee = (grossAmount: number): number => grossAmount * BORROW_ORIGINATION_FEE_BUFFER;

/**
 * Open a leveraged-yield position in one user-facing action, branching on
 * leverage / pool type / scenario:
 *  - `leverage <= 1` (deposit-only): deposit collateral, then deploy/LP it
 *    WITHOUT touching the borrow-coupled contract calls (those invoke the
 *    internal borrow even at amount 0 and would inherit borrow-path failures).
 *  - Blend single-asset + same-asset: tries the atomic
 *    `deposit_borrow_and_deploy_blend` (one signature), falling back to the
 *    split deposit/borrow/deploy path when the per-tx CPU budget is too tight.
 *  - Otherwise: deposit (+ borrow), then deploy — swapping first for
 *    cross-asset-swap, or splitting across two pools for cross-asset-keep.
 * Amounts are human-readable; `prices` drives swap-output estimates (×0.99 for
 * fee/slippage). Reports progress via `onStep`. Returns the final deploy/repay
 * tx result; never throws (errors are captured into the result).
 */
export async function executeOneClickStrategy(
  params: OneClickStrategyParams
): Promise<OneClickStrategyResult> {
  const {
    userAddress,
    marginAccountAddress,
    collateralAsset,
    collateralAmount,
    borrowAsset,
    borrowAmount,
    leverage,
    poolProtocol,
    poolType,
    poolTokens,
    scenario,
    prices = { XLM: 1.0, USDC: 1.0 },
    onStep,
  } = params;

  const step = (msg: string) => {
    onStep?.(msg);
  };

  try {
    // ── Deposit-only (1x, no borrow): pure deposit + deploy ──────────────────
    // A 1x position borrows nothing, so it must NOT route through the borrow-
    // coupled contract calls. Both `deposit_and_borrow` and the atomic
    // `deposit_borrow_and_deploy_blend` invoke the contract's internal borrow
    // (lend_to) even when the borrow amount is 0, so a plain deposit otherwise
    // inherits any borrow-path failure. The standalone `deposit_collateral_tokens`
    // path below never touches borrow, so a deposit works independently of it.
    if (borrowAmount <= 0) {
      step(`Step 1/2: Depositing ${collateralAmount} ${collateralAsset} as collateral...`);
      const depositResult = await MarginAccountService.depositCollateralTokens(
        marginAccountAddress,
        poolTokenSymbol(collateralAsset, poolProtocol, poolType),
        toWad(collateralAmount)
      );
      if (!depositResult.success) {
        return { success: false, error: `Deposit failed: ${depositResult.error}` };
      }

      if (poolType === 'lp') {
        // LP: swap half the deposit to the other token, then add liquidity.
        const otherAsset = (collateralAsset === 'XLM' ? 'USDC' : 'XLM') as TokenAsset;
        const half = collateralAmount / 2;
        const other = half * (prices[collateralAsset] / (prices[otherAsset] || 1)) * 0.99;
        step(`Step 2/3: Swapping ${half.toFixed(2)} ${collateralAsset} → ${otherAsset}...`);
        const sw = await swapLpAsset(poolProtocol, userAddress, marginAccountAddress, collateralAsset, half);
        if (!sw.success) return { success: false, error: `Swap failed: ${sw.error}` };
        const xlmAmt = collateralAsset === 'XLM' ? half : other;
        const usdcAmt = collateralAsset === 'USDC' ? half : other;
        step(`Step 3/3: Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool...`);
        const r = await addLpLiquidity(poolProtocol, userAddress, marginAccountAddress, xlmAmt, usdcAmt);
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }

      // Single-asset pool. Swap first only when the pool token differs from the
      // deposited asset (cross-asset-swap); otherwise deploy the collateral directly.
      const poolToken = poolTokens[0] as TokenAsset;
      let deployAmount = collateralAmount;
      if (scenario === 'cross-asset-swap' && poolToken !== collateralAsset) {
        step(`Step 2/3: Swapping ${collateralAmount} ${collateralAsset} → ${poolToken} via Soroswap...`);
        const sw = await SoroswapService.swapFromMargin(
          userAddress, marginAccountAddress, collateralAsset, collateralAmount
        );
        if (!sw.success) return { success: false, error: `Swap failed: ${sw.error}` };
        deployAmount = collateralAmount * (prices[collateralAsset] / (prices[poolToken] || 1)) * 0.99;
        step(`Step 3/3: Deploying ~${deployAmount.toFixed(2)} ${poolToken} to ${poolProtocol}...`);
      } else {
        step(`Step 2/2: Deploying ${deployAmount.toFixed(2)} ${poolToken} to ${poolProtocol}...`);
      }
      const r = await BlendService.depositToBlendPool(
        userAddress, marginAccountAddress, poolToken, deployAmount
      );
      return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
    }

    // ── Atomic path: Blend single-asset + same-asset scenario in one tx ──────
    // Backed by AccountManager::deposit_borrow_and_deploy_blend, which collapses
    // the entire open-position flow into one Soroban op = one wallet signature.
    // Falls back to the split deposit/borrow/deploy path on simulation failure
    // so the user is never blocked.
    if (
      poolType === 'single' &&
      scenario === 'same-asset' &&
      poolProtocol.toLowerCase().includes('blend')
    ) {
      const total = collateralAmount + borrowAmount;
      step(
        leverage > 1
          ? `Step 1/1: Depositing ${collateralAmount} ${collateralAsset}, borrowing ${borrowAmount.toFixed(4)} ${collateralAsset}, and deploying ${total.toFixed(4)} ${collateralAsset} to ${poolProtocol}...`
          : `Step 1/1: Depositing ${collateralAmount} ${collateralAsset} and deploying ${total.toFixed(4)} ${collateralAsset} to ${poolProtocol}...`
      );

      const atomicResult = await MarginAccountService.depositBorrowAndDeployBlendAtomic(
        marginAccountAddress,
        collateralAmount,
        leverage > 1 ? borrowAmount : 0,
        collateralAsset
      );

      if (atomicResult.success) {
        return { success: true, hash: atomicResult.hash };
      }

      // Soroban's per-tx CPU budget (~100M instructions) is sometimes too tight
      // for the full 3-call chain on populated pools. The split deposit/borrow
      // /deploy flow uses ~50M each and reliably fits, so always fall through —
      // the user just signs twice instead of once. Errors are already swallowed
      // and downgraded to console.warn inside depositBorrowAndDeployBlendAtomic.
      console.info('[OneClick] atomic flow not used; falling back to 2-tx split');
    }

    // ── Phase 1: Deposit collateral + borrow ────────────────────────────────

    if (scenario === 'same-asset') {
      step(
        leverage > 1
          ? `Step 1/2: Depositing ${collateralAmount} ${collateralAsset} and borrowing ${borrowAmount.toFixed(2)} ${collateralAsset}...`
          : `Step 1/1: Depositing ${collateralAmount} ${collateralAsset} as collateral...`
      );
      const result = await MarginAccountService.depositAndBorrow(
        marginAccountAddress,
        collateralAmount,
        leverage,
        collateralAsset
      );
      if (!result.success) return { success: false, error: result.error };
    } else {
      // cross-asset: deposit collateral first, then borrow the other token
      const totalSteps = borrowAmount > 0 ? 4 : 2;
      step(`Step 1/${totalSteps}: Depositing ${collateralAmount} ${collateralAsset} as collateral...`);
      const depositResult = await MarginAccountService.depositCollateralTokens(
        marginAccountAddress,
        poolTokenSymbol(collateralAsset, poolProtocol, poolType),
        toWad(collateralAmount)
      );
      if (!depositResult.success) {
        return { success: false, error: `Deposit failed: ${depositResult.error}` };
      }

      if (leverage > 1 && borrowAmount > 0) {
        step(`Step 2/${totalSteps}: Borrowing ${borrowAmount.toFixed(2)} ${borrowAsset} from Vanna...`);
        const borrowResult = await MarginAccountService.borrowTokens(
          marginAccountAddress,
          poolTokenSymbol(borrowAsset, poolProtocol, poolType),
          toWad(borrowAmount)
        );
        if (!borrowResult.success) {
          return { success: false, error: `Borrow failed: ${borrowResult.error}` };
        }
      }
    }

    // ── Phase 2: Deploy to yield pool ────────────────────────────────────────

    if (poolType === 'single') {
      const poolToken = poolTokens[0] as TokenAsset;

      if (scenario === 'same-asset') {
        const total = collateralAmount + borrowAmount;
        const stepLabel = leverage > 1 ? '2/2' : '1/1';
        step(`Step ${stepLabel}: Deploying ${total.toFixed(2)} ${poolToken} to ${poolProtocol}...`);
        const r = await BlendService.depositToBlendPool(
          userAddress, marginAccountAddress, poolToken, total
        );
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }

      if (scenario === 'cross-asset-keep') {
        const totalSteps = borrowAmount > 0 ? 4 : 2;
        if (borrowAmount > 0) {
          step(`Step 3/${totalSteps}: Deploying ${borrowAmount.toFixed(2)} ${borrowAsset} to ${poolProtocol} ${borrowAsset} pool...`);
          const r1 = await BlendService.depositToBlendPool(
            userAddress, marginAccountAddress, borrowAsset, borrowAmount
          );
          if (!r1.success) return { success: false, error: `Deploy ${borrowAsset} failed: ${r1.error}` };
        }
        step(`Step ${totalSteps}/${totalSteps}: Deploying ${collateralAmount.toFixed(2)} ${collateralAsset} to ${poolProtocol} ${collateralAsset} pool...`);
        const r2 = await BlendService.depositToBlendPool(
          userAddress, marginAccountAddress, collateralAsset, collateralAmount
        );
        return r2.success ? { success: true, hash: r2.hash } : { success: false, error: r2.error };
      }

      if (scenario === 'cross-asset-swap') {
        step(`Step 3/4: Swapping ${collateralAmount.toFixed(2)} ${collateralAsset} → ${poolToken} via Soroswap...`);
        const swapResult = await SoroswapService.swapFromMargin(
          userAddress, marginAccountAddress, collateralAsset, collateralAmount
        );
        if (!swapResult.success) return { success: false, error: `Swap failed: ${swapResult.error}` };

        // Estimate output (0.99 factor to account for Soroswap slippage/fee)
        const swappedTokens =
          collateralAmount * (prices[collateralAsset] / (prices[poolToken] || 1)) * 0.99;
        const totalPoolToken = borrowAmount + swappedTokens;

        step(`Step 4/4: Deploying ~${totalPoolToken.toFixed(2)} ${poolToken} to ${poolProtocol}...`);
        const r = await BlendService.depositToBlendPool(
          userAddress, marginAccountAddress, poolToken, totalPoolToken
        );
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }
    }

    if (poolType === 'lp') {
      // LP pools (Soroswap / Aquarius).
      // For same-asset: we only have one token → swap half to get the other, then addLiquidity.
      // For cross-asset: we already have both tokens → addLiquidity directly.

      if (scenario === 'same-asset') {
        const totalAmount = collateralAmount + borrowAmount;
        const otherAsset = (collateralAsset === 'XLM' ? 'USDC' : 'XLM') as TokenAsset;
        const halfNative = totalAmount / 2;
        // Estimate how much otherAsset we get after swapping half (0.99 for fee/slippage)
        const otherNative =
          halfNative * (prices[collateralAsset] / (prices[otherAsset] || 1)) * 0.99;

        step(`Step 2/3: Swapping ${halfNative.toFixed(2)} ${collateralAsset} → ${otherAsset}...`);
        const swapResult = await swapLpAsset(poolProtocol, userAddress, marginAccountAddress, collateralAsset, halfNative);
        if (!swapResult.success) return { success: false, error: `Swap failed: ${swapResult.error}` };

        const xlmAmt = collateralAsset === 'XLM' ? halfNative : otherNative;
        const usdcAmt = collateralAsset === 'USDC' ? halfNative : otherNative;

        step(`Step 3/3: Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool...`);
        const r = await addLpLiquidity(poolProtocol, userAddress, marginAccountAddress, xlmAmt, usdcAmt);
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }

      // cross-asset: collateral is one token, borrowed is the other (the
      // normal path once leverage > 1 — deposit and borrow already left the
      // margin account holding both LP tokens, so no swap is needed here).
      // The borrowed leg must be shaved by the origination fee — the account
      // was only ever credited the net amount, and asking AddLiquidity for
      // the full gross borrow traps with "balance is not sufficient to spend".
      const netBorrowAmount = netOfOriginationFee(borrowAmount);
      const xlmAmt = collateralAsset === 'XLM' ? collateralAmount : netBorrowAmount;
      const usdcAmt = collateralAsset === 'USDC' ? collateralAmount : netBorrowAmount;
      const stepNum = borrowAmount > 0 ? 3 : 2;
      const totalSteps = stepNum;

      step(`Step ${stepNum}/${totalSteps}: Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool...`);
      const r = await addLpLiquidity(poolProtocol, userAddress, marginAccountAddress, xlmAmt, usdcAmt);
      return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
    }

    return { success: false, error: 'Unknown pool type' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Strategy execution failed' };
  }
}
