import { MarginAccountService } from './margin-utils';
import { BlendService } from './blend-utils';
import { SoroswapService } from './soroswap-utils';

/* ─────────────────────────────────────────────────────────────────────────
   Close Position
   ─────────────────────────────────────────────────────────────────────────
   Reverse of executeOneClickStrategy:
     1. Withdraw from the external yield pool (Blend / Soroswap)
     2. Repay the Vanna loan
   The collateral in the margin account is freed and stays there for the
   user to withdraw manually via the Pro-mode withdraw flow.
   ───────────────────────────────────────────────────────────────────────── */

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
    console.log('[ClosePosition]', msg);
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
      const r = await SoroswapService.removeLiquidity(
        userAddress, marginAccountAddress, approxLpAmt
      );
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

export type TokenAsset = 'XLM' | 'USDC';
export type Scenario = 'same-asset' | 'cross-asset-keep' | 'cross-asset-swap';
export type PoolType = 'single' | 'lp';

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

export interface OneClickStrategyResult {
  success: boolean;
  hash?: string;
  error?: string;
}

function toWad(amount: number): string {
  return (BigInt(Math.floor(amount * 1_000_000)) * BigInt(1_000_000_000_000)).toString();
}

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
    console.log('[OneClick]', msg);
    onStep?.(msg);
  };

  try {
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
        collateralAsset,
        toWad(collateralAmount)
      );
      if (!depositResult.success) {
        return { success: false, error: `Deposit failed: ${depositResult.error}` };
      }

      if (leverage > 1 && borrowAmount > 0) {
        step(`Step 2/${totalSteps}: Borrowing ${borrowAmount.toFixed(2)} ${borrowAsset} from Vanna...`);
        const borrowResult = await MarginAccountService.borrowTokens(
          marginAccountAddress,
          borrowAsset,
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
        const swapResult = await SoroswapService.swapFromMargin(
          userAddress, marginAccountAddress, collateralAsset, halfNative
        );
        if (!swapResult.success) return { success: false, error: `Swap failed: ${swapResult.error}` };

        const xlmAmt = collateralAsset === 'XLM' ? halfNative : otherNative;
        const usdcAmt = collateralAsset === 'USDC' ? halfNative : otherNative;

        step(`Step 3/3: Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool...`);
        const r = await SoroswapService.addLiquidity(
          userAddress, marginAccountAddress, xlmAmt, usdcAmt
        );
        return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
      }

      // cross-asset: collateral is one token, borrowed is the other
      const xlmAmt = collateralAsset === 'XLM' ? collateralAmount : borrowAmount;
      const usdcAmt = collateralAsset === 'USDC' ? collateralAmount : borrowAmount;
      const stepNum = borrowAmount > 0 ? 3 : 2;
      const totalSteps = stepNum;

      step(`Step ${stepNum}/${totalSteps}: Adding liquidity to ${poolProtocol} ${poolTokens.join('/')} pool...`);
      const r = await SoroswapService.addLiquidity(
        userAddress, marginAccountAddress, xlmAmt, usdcAmt
      );
      return r.success ? { success: true, hash: r.hash } : { success: false, error: r.error };
    }

    return { success: false, error: 'Unknown pool type' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Strategy execution failed' };
  }
}
