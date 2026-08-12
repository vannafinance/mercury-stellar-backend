import { MarginAccountService } from './margin-utils';
import { BlendService } from './blend-utils';
import { SoroswapService } from './soroswap-utils';
import { AquariusService } from './aquarius-utils';
import { appendFarmHistory, buildFarmPoolKey } from './farm-history';
import { CONTRACT_ADDRESSES } from './stellar-utils';

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

/**
 * Live XLM/USDC reserves for the given LP protocol, human-readable. Used to
 * pair a leveraged LP deposit at the pool's CURRENT ratio — Aquarius/Soroswap
 * classic-pool deposits pull the full amounts requested but mint LP shares
 * only for the proportionally smaller side, so an oracle-priced (rather than
 * reserve-ratio-priced) pair donates the mismatched excess to the pool for
 * free. Fetched fresh at execution time rather than trusted from an earlier
 * UI estimate, since the ratio can move between page-load and this call.
 */
async function fetchLpReserves(poolProtocol: string): Promise<{ xlm: number; usdc: number } | null> {
  if (isAquarius(poolProtocol)) {
    const stats = await AquariusService.getAquariusPoolStats(CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL);
    if (!stats) return null;
    const xlm = parseFloat(stats.reserveA);
    const usdc = parseFloat(stats.reserveB);
    return Number.isFinite(xlm) && Number.isFinite(usdc) ? { xlm, usdc } : null;
  }
  const stats = await SoroswapService.getPoolStats();
  if (!stats) return null;
  const xlm = parseFloat(stats.reserveXLM);
  const usdc = parseFloat(stats.reserveUSDC);
  return Number.isFinite(xlm) && Number.isFinite(usdc) ? { xlm, usdc } : null;
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
 * pool. Aquarius and Soroswap each trade their OWN USDC-variant SAC (AQUSDC /
 * SOUSDC) — completely distinct on-chain tokens from generic USDC/BLUSDC, not
 * just aliases. Depositing/borrowing plain "USDC" credits the Blend USDC
 * lending pool, leaving the margin account's real AQUSDC/SOUSDC balance at
 * zero — AddLiquidity then traps with "zero balance is not sufficient to
 * spend" on the pool's actual USDC SAC, even though the deposit/borrow itself
 * succeeded. XLM has no such variant, so it passes through unchanged.
 */
function poolTokenSymbol(asset: TokenAsset, poolProtocol: string, poolType: PoolType): string {
  if (poolType !== 'lp' || asset !== 'USDC') return asset;
  return isAquarius(poolProtocol) ? 'AQUSDC' : 'SOUSDC';
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
  /** Extra same-asset-as-collateral debt from leveraged LP pairing (0 for
   *  Blend / non-leveraged / legacy positions opened before this existed). */
  collateralBorrowAmount?: number;
  poolProtocol: string;       // 'Blend' | 'Soroswap' | 'Aquarius'
  poolType: PoolType;
  poolTokens: string[];
  isSameAsset: boolean;       // collateral == borrow token?
  exitPct: number;            // 1-100
  onStep?: (msg: string) => void;
}

/**
 * Unwind a leveraged-yield position (full or partial via `exitPct`): withdraw
 * from the external pool (Blend single-asset, or Soroswap/Aquarius LP) then
 * repay that fraction of the Vanna loan(s). Same-asset Blend positions deploy
 * collateral+borrow into the pool, so the withdraw covers both. LP positions
 * remove the REAL on-chain LP balance (not an amount-based approximation —
 * LP shares are a different unit from any token amount) and repay BOTH debt
 * legs when the position was leveraged: the paired-asset borrow and the
 * same-asset top-up borrow that scaled the collateral leg (see
 * executeOneClickStrategy's LP branch). Freed collateral is NOT
 * auto-withdrawn — the user pulls it via Pro-mode.
 * Returns `{ success:false, error }` on the first failing leg; never throws.
 */
export async function closePosition(params: ClosePositionParams): Promise<OneClickStrategyResult> {
  const {
    userAddress,
    marginAccountAddress,
    borrowAsset,
    borrowAmount,
    collateralAsset,
    collateralAmount,
    collateralBorrowAmount = 0,
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
  const collateralRepayAmt = collateralBorrowAmount * pct;

  try {
    // ── Step 1: Withdraw from yield pool ──────────────────────────────────
    if (poolType === 'single') {
      // For same-asset: collateral + borrow is all deployed in the external
      // pool. For cross-asset: only the borrowed amount lives in the pool
      // (collateral stays in the margin account as security, freed on repay).
      const withdrawAmt = isSameAsset
        ? (collateralAmount + borrowAmount) * pct
        : borrowAmount * pct;
      const poolToken = poolTokens[0] as TokenAsset;
      step(`Step 1/2: Withdrawing ${withdrawAmt.toFixed(2)} ${poolToken} from ${poolProtocol}`);
      const r = await BlendService.withdrawFromBlendPool(
        userAddress, marginAccountAddress, poolToken, withdrawAmt
      );
      if (!r.success) return { success: false, error: `Withdraw failed: ${r.error}` };
    } else {
      // LP pool — remove the REAL on-chain LP balance, matching how the Farm
      // page's own Remove Liquidity does it. LP shares are not the same unit
      // as any borrowed-token amount, so approximating with borrowAmount (the
      // old behavior) removed the wrong fraction of the real position.
      const otherAsset = (collateralAsset === 'XLM' ? 'USDC' : 'XLM') as TokenAsset;
      const tokenA = collateralAsset === 'XLM' ? collateralAsset : otherAsset;
      const tokenB = collateralAsset === 'XLM' ? otherAsset : collateralAsset;
      const lpBalanceStr = isAquarius(poolProtocol)
        ? await AquariusService.getUserLpBalance(marginAccountAddress, CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL, tokenA, tokenB)
        : await SoroswapService.getLpBalance(marginAccountAddress);
      const realLpBalance = parseFloat(lpBalanceStr) || 0;
      if (realLpBalance <= 0) {
        return { success: false, error: `No ${poolProtocol} LP balance found to remove.` };
      }
      const lpAmt = realLpBalance * pct;
      step(`Step 1/2: Removing ${lpAmt.toFixed(4)} LP from ${poolProtocol} ${poolTokens.join('/')} pool`);
      const r = await removeLpLiquidity(poolProtocol, userAddress, marginAccountAddress, lpAmt);
      if (!r.success) return { success: false, error: `Remove liquidity failed: ${r.error}` };
    }

    // ── Step 2: Repay Vanna loan(s) ─────────────────────────────────────────
    // Leveraged LP positions carry TWO debt legs (paired-asset + same-asset
    // top-up) — both must be repaid, or the top-up leg is left orphaned.
    // Both legs go through poolTokenSymbol() — for an LP position, the real
    // on-chain USDC-side debt is denominated in AQUSDC/SOUSDC (whichever the
    // borrow itself used), not generic USDC/Blend-USDC. Repaying the plain
    // "USDC" symbol here would target the wrong debt entirely.
    const collateralRepaySymbol = poolTokenSymbol(collateralAsset, poolProtocol, poolType);
    const borrowRepaySymbol = poolTokenSymbol(borrowAsset, poolProtocol, poolType);

    // Cap each leg at what's actually spendable in the margin account right
    // now — same reasoning as the Pro-mode Repay tab: the stored debt amount
    // can exceed what's really there (interest, or — for a position whose
    // amounts came from a stale/recovered source — an imprecise estimate).
    // Repaying the raw amount blind risks Error(Contract,#10) "balance is not
    // sufficient to spend" instead of a partial, successful repay.
    const capToSpendable = async (symbol: string, amount: number): Promise<number> => {
      if (amount <= 0) return 0;
      const spendableWad = await MarginAccountService.getMarginAccountTokenBalanceWad(marginAccountAddress, symbol);
      if (spendableWad == null) return amount;
      const spendable = Number(BigInt(spendableWad)) / 1e18;
      return Math.min(amount, spendable);
    };

    if (collateralRepayAmt > 0) {
      const cappedAmt = await capToSpendable(collateralRepaySymbol, collateralRepayAmt);
      if (cappedAmt > 0) {
        step(`Repaying ${cappedAmt.toFixed(4)} ${collateralAsset} to Vanna`);
        const r = await MarginAccountService.repayLoan(marginAccountAddress, collateralRepaySymbol, toWad(cappedAmt));
        if (!r.success) return { success: false, error: `Repay failed: ${r.error}` };
      }
    }

    if (repayAmt > 0) {
      const cappedAmt = await capToSpendable(borrowRepaySymbol, repayAmt);
      if (cappedAmt > 0) {
        step(`Step 2/2: Repaying ${cappedAmt.toFixed(4)} ${borrowAsset} to Vanna`);
        const r = await MarginAccountService.repayLoan(marginAccountAddress, borrowRepaySymbol, toWad(cappedAmt));
        if (!r.success) return { success: false, error: `Repay failed: ${r.error}` };
        return { success: true, hash: r.hash };
      }
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

// The origination fee was set to 0% on all 4 lending pools live on 2026-08-09
// (see deploy/testnet.env's ORIGINATION_FEE_U128 and the `update_origination_fee`
// calls made that day) — the margin account is now credited the FULL requested
// borrow amount, no haircut. This buffer is just a hair under 1.0 to absorb WAD
// rounding drift (mul/div truncation across a few hops), not a fee — it used to
// be 0.9965 to shave the real 0.3%/1% fee that existed before.
const BORROW_ORIGINATION_FEE_BUFFER = 0.9999;
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
      step(`Step 1/2: Depositing ${collateralAmount} ${collateralAsset} as collateral`);
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
        step(`Step 2/3: Swapping ${half.toFixed(2)} ${collateralAsset} → ${otherAsset}`);
        const sw = await swapLpAsset(poolProtocol, userAddress, marginAccountAddress, collateralAsset, half);
        if (!sw.success) return { success: false, error: `Swap failed: ${sw.error}` };
        const xlmAmt = collateralAsset === 'XLM' ? half : other;
        const usdcAmt = collateralAsset === 'USDC' ? half : other;
        step(`Step 3/3: Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool`);
        const r = await addLpLiquidity(poolProtocol, userAddress, marginAccountAddress, xlmAmt, usdcAmt);
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }

      // Single-asset pool. Swap first only when the pool token differs from the
      // deposited asset (cross-asset-swap); otherwise deploy the collateral directly.
      const poolToken = poolTokens[0] as TokenAsset;
      let deployAmount = collateralAmount;
      // Only valid when NO swap runs in between — a swap would bump the
      // account's sequence again, making this stale (see nextSequence's doc
      // comment on BlendTransactionResult).
      let depositToBlendKnownSequence = depositResult.nextSequence;
      if (scenario === 'cross-asset-swap' && poolToken !== collateralAsset) {
        step(`Step 2/3: Swapping ${collateralAmount} ${collateralAsset} → ${poolToken} via Soroswap`);
        const sw = await SoroswapService.swapFromMargin(
          userAddress, marginAccountAddress, collateralAsset, collateralAmount
        );
        if (!sw.success) return { success: false, error: `Swap failed: ${sw.error}` };
        depositToBlendKnownSequence = undefined;
        deployAmount = collateralAmount * (prices[collateralAsset] / (prices[poolToken] || 1)) * 0.99;
        step(`Step 3/3: Deploying ~${deployAmount.toFixed(2)} ${poolToken} to ${poolProtocol}`);
      } else {
        step(`Step 2/2: Deploying ${deployAmount.toFixed(2)} ${poolToken} to ${poolProtocol}`);
      }
      const r = await BlendService.depositToBlendPool(
        userAddress, marginAccountAddress, poolToken, deployAmount, depositToBlendKnownSequence
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
          ? `Step 1/1: Depositing ${collateralAmount} ${collateralAsset}, borrowing ${borrowAmount.toFixed(4)} ${collateralAsset}, and deploying ${total.toFixed(4)} ${collateralAsset} to ${poolProtocol}`
          : `Step 1/1: Depositing ${collateralAmount} ${collateralAsset} and deploying ${total.toFixed(4)} ${collateralAsset} to ${poolProtocol}`
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

    // Carries the last Phase-1 tx's sequence into Phase 2's deploy call(s)
    // below (e.g. depositToBlendPool right after depositAndBorrow) — same
    // same-account race as the LP branch's b1→b2 chaining above.
    let phase1NextSequence: string | undefined;

    if (scenario === 'same-asset') {
      step(
        leverage > 1
          ? `Step 1/2: Depositing ${collateralAmount} ${collateralAsset} and borrowing ${borrowAmount.toFixed(2)} ${collateralAsset}`
          : `Step 1/1: Depositing ${collateralAmount} ${collateralAsset} as collateral`
      );
      const result = await MarginAccountService.depositAndBorrow(
        marginAccountAddress,
        collateralAmount,
        leverage,
        collateralAsset
      );
      if (!result.success) return { success: false, error: result.error };
      phase1NextSequence = result.nextSequence;
    } else if (poolType === 'lp') {
      // LP pools (Aquarius/Soroswap): collateral funds one leg; the paired
      // leg must be sized off the pool's LIVE reserve ratio, not the UI's
      // oracle-price estimate (see fetchLpReserves doc comment above) — so
      // reserves are re-read here, right before borrowing, rather than
      // trusting whatever `borrowAmount`/`borrowAsset` the caller passed in.
      step(`Step 1/4: Depositing ${collateralAmount} ${collateralAsset} as collateral`);
      const depositResult = await MarginAccountService.depositCollateralTokens(
        marginAccountAddress,
        poolTokenSymbol(collateralAsset, poolProtocol, poolType),
        toWad(collateralAmount)
      );
      if (!depositResult.success) {
        return { success: false, error: `Deposit failed: ${depositResult.error}` };
      }

      const otherAsset = (collateralAsset === 'XLM' ? 'USDC' : 'XLM') as TokenAsset;
      let collateralLegBorrowAmount = 0;
      let pairedBorrowAmount = 0;

      if (leverage > 1) {
        step(`Step 2/4: Reading live ${poolProtocol} pool reserves`);
        const reserves = await fetchLpReserves(poolProtocol);
        if (!reserves) {
          return { success: false, error: `Could not read ${poolProtocol} pool reserves — please retry.` };
        }
        const collateralReserve = collateralAsset === 'XLM' ? reserves.xlm : reserves.usdc;
        const otherReserve = collateralAsset === 'XLM' ? reserves.usdc : reserves.xlm;
        if (collateralReserve <= 0 || otherReserve <= 0) {
          return { success: false, error: `${poolProtocol} pool has no liquidity to price the pair against.` };
        }
        const ratio = otherReserve / collateralReserve;

        // Solve for the collateral-leg borrow that makes BOTH true at once:
        //  1. total borrowed USD == depositUsd × (leverage − 1), so the
        //     position lands at exactly the selected leverage instead of
        //     overshooting it — pairedBorrowAmount used to be tacked on TOP
        //     of a full (leverage−1)× collateral-leg borrow, silently adding
        //     extra exposure beyond the chosen multiplier.
        //  2. (collateralAmount + collateralLegBorrowAmount) : pairedBorrowAmount
        //     still matches the pool's live reserve ratio, so nothing is
        //     donated to the pool for free (see fetchLpReserves' doc comment) —
        //     a flat 50/50 USD split would do exactly that on an imbalanced
        //     pool like this one.
        //
        // pairedBorrowAmount = (collateralAmount + x) × ratio, and
        // x·Pc + pairedBorrowAmount·Po = depositUsd·(leverage−1) together give:
        //   x = [depositUsd·(leverage−1) − collateralAmount·ratio·Po] / (Pc + ratio·Po)
        const collateralPrice = prices[collateralAsset] ?? 1;
        const otherPrice = prices[otherAsset] ?? 1;
        const depositUsd = collateralAmount * collateralPrice;
        const totalBorrowUsdTarget = depositUsd * (leverage - 1);
        const denom = collateralPrice + ratio * otherPrice;
        collateralLegBorrowAmount = denom > 0
          ? Math.max(0, (totalBorrowUsdTarget - collateralAmount * ratio * otherPrice) / denom)
          : 0;
        pairedBorrowAmount = (collateralAmount + collateralLegBorrowAmount) * ratio;

        // b1 and b2 are both submitted from the SAME wallet account right
        // after the Step 1/4 deposit confirms (Step 2/4 is a pure read, no
        // tx) — a fresh `getAccount()` read for either is not reliably
        // caught up with the prior tx's sequence bump yet — confirmed live
        // hitting `txBadSeq` on every retry regardless of backoff — so chain
        // each leg the exact next sequence the previous one just consumed
        // instead of re-reading it over RPC.
        let nextSequence: string | undefined = depositResult.nextSequence;

        if (collateralLegBorrowAmount > 0) {
          step(`Step 3/4: Borrowing ${collateralLegBorrowAmount.toFixed(2)} ${collateralAsset} from Vanna`);
          const b1 = await MarginAccountService.borrowTokens(
            marginAccountAddress,
            poolTokenSymbol(collateralAsset, poolProtocol, poolType),
            toWad(collateralLegBorrowAmount),
            nextSequence
          );
          if (!b1.success) return { success: false, error: `Borrow failed: ${b1.error}` };
          nextSequence = b1.nextSequence;
        }

        step(`Step 4/4: Borrowing ${pairedBorrowAmount.toFixed(2)} ${otherAsset} from Vanna to pair into the pool`);
        const b2 = await MarginAccountService.borrowTokens(
          marginAccountAddress,
          poolTokenSymbol(otherAsset, poolProtocol, poolType),
          toWad(pairedBorrowAmount),
          nextSequence
        );
        if (!b2.success) return { success: false, error: `Borrow failed: ${b2.error}` };
      }

      // Both borrowed legs are shaved by the origination fee — the account
      // is only ever credited the net amount, and asking AddLiquidity for
      // the full gross borrow traps with "balance is not sufficient to spend".
      const netCollateralLeg = collateralAmount + netOfOriginationFee(collateralLegBorrowAmount);
      const netPairedLeg = netOfOriginationFee(pairedBorrowAmount);
      const xlmAmt = collateralAsset === 'XLM' ? netCollateralLeg : netPairedLeg;
      const usdcAmt = collateralAsset === 'USDC' ? netCollateralLeg : netPairedLeg;

      step(`Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool`);
      const r = await addLpLiquidity(poolProtocol, userAddress, marginAccountAddress, xlmAmt, usdcAmt);
      return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
    } else {
      // cross-asset for single-asset (Blend) pools: deposit collateral first,
      // then borrow the other token.
      const totalSteps = borrowAmount > 0 ? 4 : 2;
      step(`Step 1/${totalSteps}: Depositing ${collateralAmount} ${collateralAsset} as collateral`);
      const depositResult = await MarginAccountService.depositCollateralTokens(
        marginAccountAddress,
        poolTokenSymbol(collateralAsset, poolProtocol, poolType),
        toWad(collateralAmount)
      );
      if (!depositResult.success) {
        return { success: false, error: `Deposit failed: ${depositResult.error}` };
      }
      phase1NextSequence = depositResult.nextSequence;

      if (leverage > 1 && borrowAmount > 0) {
        step(`Step 2/${totalSteps}: Borrowing ${borrowAmount.toFixed(2)} ${borrowAsset} from Vanna`);
        const borrowResult = await MarginAccountService.borrowTokens(
          marginAccountAddress,
          poolTokenSymbol(borrowAsset, poolProtocol, poolType),
          toWad(borrowAmount),
          phase1NextSequence
        );
        if (!borrowResult.success) {
          return { success: false, error: `Borrow failed: ${borrowResult.error}` };
        }
        phase1NextSequence = borrowResult.nextSequence;
      }
    }

    // ── Phase 2: Deploy to yield pool ────────────────────────────────────────

    if (poolType === 'single') {
      const poolToken = poolTokens[0] as TokenAsset;

      if (scenario === 'same-asset') {
        const total = collateralAmount + borrowAmount;
        const stepLabel = leverage > 1 ? '2/2' : '1/1';
        step(`Step ${stepLabel}: Deploying ${total.toFixed(2)} ${poolToken} to ${poolProtocol}`);
        console.log(`[OneClick] calling depositToBlendPool with phase1NextSequence=${phase1NextSequence} (userAddress=${userAddress})`);
        const r = await BlendService.depositToBlendPool(
          userAddress, marginAccountAddress, poolToken, total, phase1NextSequence
        );
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }

      if (scenario === 'cross-asset-keep') {
        const totalSteps = borrowAmount > 0 ? 4 : 2;
        let nextSequence = phase1NextSequence;
        if (borrowAmount > 0) {
          step(`Step 3/${totalSteps}: Deploying ${borrowAmount.toFixed(2)} ${borrowAsset} to ${poolProtocol} ${borrowAsset} pool`);
          const r1 = await BlendService.depositToBlendPool(
            userAddress, marginAccountAddress, borrowAsset, borrowAmount, nextSequence
          );
          if (!r1.success) return { success: false, error: `Deploy ${borrowAsset} failed: ${r1.error}` };
          nextSequence = r1.nextSequence;
        }
        step(`Step ${totalSteps}/${totalSteps}: Deploying ${collateralAmount.toFixed(2)} ${collateralAsset} to ${poolProtocol} ${collateralAsset} pool`);
        const r2 = await BlendService.depositToBlendPool(
          userAddress, marginAccountAddress, collateralAsset, collateralAmount, nextSequence
        );
        return r2.success ? { success: true, hash: r2.hash } : { success: false, error: r2.error };
      }

      if (scenario === 'cross-asset-swap') {
        step(`Step 3/4: Swapping ${collateralAmount.toFixed(2)} ${collateralAsset} → ${poolToken} via Soroswap`);
        const swapResult = await SoroswapService.swapFromMargin(
          userAddress, marginAccountAddress, collateralAsset, collateralAmount
        );
        if (!swapResult.success) return { success: false, error: `Swap failed: ${swapResult.error}` };

        // Estimate output (0.99 factor to account for Soroswap slippage/fee)
        const swappedTokens =
          collateralAmount * (prices[collateralAsset] / (prices[poolToken] || 1)) * 0.99;
        const totalPoolToken = borrowAmount + swappedTokens;

        step(`Step 4/4: Deploying ~${totalPoolToken.toFixed(2)} ${poolToken} to ${poolProtocol}`);
        const r = await BlendService.depositToBlendPool(
          userAddress, marginAccountAddress, poolToken, totalPoolToken
        );
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }
    }

    // LP pools (Aquarius/Soroswap) already returned above, in the ratio-aware
    // branch of Phase 1 — only single-asset (Blend) pools reach here.

    return { success: false, error: 'Unknown pool type' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Strategy execution failed' };
  }
}
