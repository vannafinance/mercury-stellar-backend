/* ═══════════════════════════════════════════════════════════════════════
 * Vanna Lite — Leveraged Yield Math
 *
 * Convention
 * ----------
 *   collateral  = user's own capital (deposited)
 *   borrow      = credit drawn from Vanna
 *   total       = collateral + borrow   (amount supplied to the external pool)
 *   leverage    = total / collateral    (e.g. deposit 1 ETH + borrow 5 ETH → 6×)
 *
 * Rate model (simple APR, denominated in the pool asset)
 * ------------------------------------------------------
 *   supplyApr   = pool's supply APR (e.g. Aave USDC = 3%, Aave ETH = 5%)
 *   vannaFeeApr = Vanna's borrow rate (e.g. 6%)
 *
 * Yields per year on the user's capital
 * -------------------------------------
 *   grossYield   = leverage        × supplyApr
 *   borrowCost   = (leverage − 1)  × vannaFeeApr
 *   NET APR      = grossYield − borrowCost
 *                = leverage × supplyApr − (leverage − 1) × vannaFeeApr
 *
 * Earnings after time t (in years)
 * --------------------------------
 *   earningsUsd  = collateralUsd × netApr × t
 *
 * Exit math (atomic repay + proportional withdraw)
 * ------------------------------------------------
 *   At exit time t, each $1 of collateral has grown to (1 + netApr · t).
 *   For a partial exit of pct%:
 *     repayUsd     = borrowUsd_now     × pct / 100
 *     withdrawUsd  = currentSupplyUsd  × pct / 100
 *     userNetUsd   = withdrawUsd − repayUsd
 *                  = collateralUsd × (1 + netApr · t) × pct / 100
 *
 *   Because repay and withdraw scale by the SAME ratio, HF is preserved for
 *   any partial exit. A 100% exit closes the debt entirely → HF → ∞ ("Safe").
 * ═══════════════════════════════════════════════════════════════════════ */

export interface YieldRates {
  supplyApr: number;    // e.g. 5 for 5%
  vannaFeeApr: number;  // e.g. 6 for 6%
  leverage: number;     // e.g. 6 for 6×
}

export interface LeveragePreview {
  leverage: number;
  collateralUsd: number;
  borrowUsd: number;
  totalExposureUsd: number;
  grossSupplyApr: number;   // supplied on user capital
  borrowCostApr: number;    // borrow drag on user capital
  netApr: number;
  projectedEarnings1y: number;
}

export const calcNetApr = ({ supplyApr, vannaFeeApr, leverage }: YieldRates): number =>
  leverage * supplyApr - (leverage - 1) * vannaFeeApr;

export const calcLeveragePreview = (
  collateralUsd: number,
  rates: YieldRates
): LeveragePreview => {
  const { leverage, supplyApr, vannaFeeApr } = rates;
  const totalExposureUsd = collateralUsd * leverage;
  const borrowUsd = collateralUsd * (leverage - 1);
  const grossSupplyApr = leverage * supplyApr;
  const borrowCostApr = (leverage - 1) * vannaFeeApr;
  const netApr = grossSupplyApr - borrowCostApr;
  const projectedEarnings1y = collateralUsd * (netApr / 100);
  return {
    leverage,
    collateralUsd,
    borrowUsd,
    totalExposureUsd,
    grossSupplyApr,
    borrowCostApr,
    netApr,
    projectedEarnings1y,
  };
};

/** Earnings (USD) accrued since opening — simple APR. tYears = elapsed years. */
export const calcEarningsUsd = (
  collateralUsd: number,
  netApr: number,
  tYears: number
): number => collateralUsd * (netApr / 100) * tYears;

/* ─── Exit preview ────────────────────────────────────────────────────── */

export interface ExitPreview {
  exitPct: number;
  repayUsd: number;
  withdrawUsd: number;
  userReceivesUsd: number;       // withdraw − repay
  remainingCollateralUsd: number;
  remainingBorrowUsd: number;
  projectedHf: number | null;    // null == full exit (HF becomes ∞)
}

/**
 * Calculate the effect of a partial or full exit at the current on-chain state.
 *
 * @param currentSuppliedUsd  TOTAL supplied balance in pool = collateral + borrow + accrued earnings
 *                            (this is what leaves the pool on withdraw — NOT just user equity)
 * @param currentBorrowUsd    debt owed (principal + accrued borrow interest)
 * @param currentHf           health factor right now
 * @param exitPct             1 .. 100
 */
export const calcExitPreview = (
  currentSuppliedUsd: number,
  currentBorrowUsd: number,
  currentHf: number,
  exitPct: number
): ExitPreview => {
  const pct = Math.max(1, Math.min(100, exitPct)) / 100;
  const repayUsd = currentBorrowUsd * pct;
  const withdrawUsd = currentSuppliedUsd * pct;
  const userReceivesUsd = withdrawUsd - repayUsd;
  const remainingCollateralUsd = currentSuppliedUsd - withdrawUsd;
  const remainingBorrowUsd = currentBorrowUsd - repayUsd;

  /* Atomic proportional exit preserves the collateral/debt ratio, so HF is
     invariant under partial exits. A 100% exit zeroes the debt → HF → ∞. */
  const projectedHf = pct >= 1 ? null : currentHf;

  return {
    exitPct: pct * 100,
    repayUsd,
    withdrawUsd,
    userReceivesUsd,
    remainingCollateralUsd,
    remainingBorrowUsd,
    projectedHf,
  };
};

/* ─── Pool aggregation (collapse same-pool deposits into one row) ─────── */

/* Keep this import-light so the util stays tree-shakeable for the Stellar
   integration. Callers pass in a minimal record shape that mirrors LitePosition. */
export interface AggregatablePosition {
  id: string;
  poolId: string;
  poolLabel: string;
  protocol: string;
  poolVersion: string;
  collateralAsset: string;
  collateralAmount: number;
  collateralUsd: number;
  borrowAsset: string;
  borrowAmount: number;
  borrowUsd: number;
  leverage: number;
  supplyApr: number;
  vannaFeeApr: number;
  netApr: number;
  earningsUsd: number;
  healthFactor: number;
  liquidationLtv: number;
  status: "active" | "risky" | "liquidation";
  openedAt: string;
}

/**
 * Collapse every position that targets the same pool into a single row.
 *
 * Rules (one position per vault, Morpho-style):
 *   • sums  — collateral, borrow, earnings (USD + asset units)
 *   • ratios — leverage is recomputed from the aggregate totals
 *   • rates  — supplyApr / vannaFeeApr / netApr taken from the pool (same for all
 *              deposits into that pool), LTV preserved
 *   • risk   — HF is recomputed from the aggregate collateral/debt ratio
 *   • status — worst of the merged set (liquidation > risky > active)
 *   • openedAt — earliest open time wins (we keep the string as-is)
 */
export const aggregateByPool = <T extends AggregatablePosition>(positions: T[]): T[] => {
  if (positions.length <= 1) return positions;

  const buckets = new Map<string, T[]>();
  for (const p of positions) {
    const bucket = buckets.get(p.poolId);
    if (bucket) bucket.push(p);
    else buckets.set(p.poolId, [p]);
  }

  const statusRank = { active: 0, risky: 1, liquidation: 2 } as const;
  const merged: T[] = [];

  for (const [, group] of buckets) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const first = group[0];
    const collateralAmount = group.reduce((s, g) => s + g.collateralAmount, 0);
    const collateralUsd = group.reduce((s, g) => s + g.collateralUsd, 0);
    const borrowAmount = group.reduce((s, g) => s + g.borrowAmount, 0);
    const borrowUsd = group.reduce((s, g) => s + g.borrowUsd, 0);
    const earningsUsd = group.reduce((s, g) => s + g.earningsUsd, 0);
    const leverage = collateralUsd > 0 ? (collateralUsd + borrowUsd) / collateralUsd : first.leverage;
    const netApr = leverage * first.supplyApr - (leverage - 1) * first.vannaFeeApr;
    const worstStatus = group.reduce<T["status"]>(
      (w, g) => (statusRank[g.status] > statusRank[w] ? g.status : w),
      "active"
    );
    /* Rough HF aggregate: weight each row's HF by its borrowUsd. Better than a
       naive mean because a tiny risky position shouldn't drag down a large safe one. */
    const weightedHf =
      borrowUsd > 0
        ? group.reduce((s, g) => s + g.healthFactor * g.borrowUsd, 0) / borrowUsd
        : first.healthFactor;

    merged.push({
      ...first,
      id: first.poolId,           // stable id = poolId when aggregated
      collateralAmount,
      collateralUsd,
      borrowAmount,
      borrowUsd,
      earningsUsd,
      leverage,
      netApr,
      healthFactor: weightedHf,
      status: worstStatus,
    } as T);
  }

  /* Preserve a stable, deterministic order: largest exposure first. */
  return merged.sort((a, b) => (b.collateralUsd + b.borrowUsd) - (a.collateralUsd + a.borrowUsd));
};

/* ─── Per-asset net-value math (ETH vs USDC exit scenarios) ───────────── */

export interface AssetExitBreakdown {
  asset: string;
  collateralAmount: number;   // asset units user deposited
  borrowAmount: number;       // asset units borrowed
  earnedAmount: number;       // asset units gained from yield
  priceUsd: number;
  grossWithdrawAmount: number;   // collateral + earned
  repayAmount: number;           // debt owed in asset
  netReceivedAmount: number;     // grossWithdraw − repay
  netReceivedUsd: number;
}

/**
 * Same-asset leveraged yield (collateralAsset == borrowAsset).
 *
 * Example (user's scenario): deposit 1 ETH, borrow 5 ETH, supply 6 ETH to Aave,
 * ETH supply 5%, Vanna borrow 6%, t = 1 year.
 *    totalSupplied at t = 6 × (1 + 0.05) = 6.30 ETH
 *    debt at t          = 5 × (1 + 0.06) = 5.30 ETH
 *    user receives      = 6.30 − 5.30    = 1.00 ETH  (break-even — netApr = 0%)
 *
 * Example: deposit 1000 USDC, borrow 4000 USDC, supply USDC @ 10%,
 * borrow @ 6%, leverage = 5×, t = 1 year.
 *    supplied at t = 5000 × 1.10 = 5500 USDC
 *    debt at t     = 4000 × 1.06 = 4240 USDC
 *    user gets     = 1260 USDC   (= 1000 × (1 + 26%) ✓)
 */
export const calcSameAssetExit = (
  asset: string,
  collateralAmount: number,
  rates: YieldRates,
  priceUsd: number,
  tYears: number
): AssetExitBreakdown => {
  const { supplyApr, vannaFeeApr, leverage } = rates;
  const borrowAmount = collateralAmount * (leverage - 1);
  const totalSupplied = collateralAmount * leverage;

  const suppliedAtT = totalSupplied * (1 + (supplyApr / 100) * tYears);
  const debtAtT = borrowAmount * (1 + (vannaFeeApr / 100) * tYears);
  const netReceivedAmount = suppliedAtT - debtAtT;   // in asset units
  const earnedAmount = netReceivedAmount - collateralAmount;

  return {
    asset,
    collateralAmount,
    borrowAmount,
    earnedAmount,
    priceUsd,
    grossWithdrawAmount: suppliedAtT,
    repayAmount: debtAtT,
    netReceivedAmount,
    netReceivedUsd: netReceivedAmount * priceUsd,
  };
};
