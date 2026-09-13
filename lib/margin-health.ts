// Pure margin health/solvency math, extracted from computeMarginSnapshot so the
// formulas have a single source of truth and can be unit-verified against
// Protocol_V1_Soroban (testnet) RiskEngineContract:
//
//   health_factor = balance * WAD / debt          (risk_engine.rs is_account_healthy)
//   healthy iff   HF > 1.1   (strict; HF == 1.1 is liquidatable)
//   borrow gate   (C + B) / (D + B) > 1.1         (borrowed proceeds credit collateral)
//   max LTV       1 / 1.1 ≈ 0.909090…
//
// MCP's `liquidation_threshold: "0.909"` is that max LTV, NOT a collateral haircut.

/** On-chain BALANCE_TO_BORROW_THRESHOLD / WAD. Liquidatable when HF <= this. */
export const LIQUIDATION_THRESHOLD = 1.1;

/** 1 / 1.1 — max LTV while still strictly above the HF gate. */
export const MAX_LTV = 1 / LIQUIDATION_THRESHOLD;

// Displayed in place of ∞ when an account has collateral but no debt.
export const HEALTH_FACTOR_INFINITY_SENTINEL = 999;

export interface MarginHealth {
  avgHealthFactor: number;
  collateralLeftBeforeLiquidation: number;
  netAvailableCollateral: number;
  totalValue: number;
  debtLimit: number;
}

/**
 * On-chain health factor: gross collateral / debt.
 * Null when there is no debt (HF is ∞, not a number).
 */
export function healthFactorFromUsd(collateralUsd: number, debtUsd: number): number | null {
  if (!(debtUsd > 0)) return null;
  return collateralUsd / debtUsd;
}

/** True when the RiskEngine would reject is_account_healthy (HF <= 1.1 with debt). */
export function isOnChainLiquidatable(hf: number | null | undefined, debtUsd: number): boolean {
  if (!(debtUsd > 0)) return false;
  if (hf == null || !Number.isFinite(hf)) return false;
  return hf <= LIQUIDATION_THRESHOLD;
}

/**
 * Largest borrow x that still leaves HF >= floor, given that a borrow credits
 * both sides: (G + x) / (D + x) >= F  =>  x <= (G - F*D) / (F - 1).
 * Same closed form as `maxBorrowForFloorWad` in investigation/sizing.ts.
 *
 * F = 1.1 lands exactly on the liquidation gate (unhealthy). Use
 * `maxBorrowForProtocolUsd` for the on-chain exclusive max (HF > 1.1).
 */
export function maxBorrowForFloorUsd(grossUsd: number, debtUsd: number, floor: number): number {
  if (!(floor > 1) || !Number.isFinite(floor)) return 0;
  if (!Number.isFinite(grossUsd) || !Number.isFinite(debtUsd)) return 0;
  const numerator = grossUsd - floor * Math.max(0, debtUsd);
  if (!(numerator > 0)) return 0;
  return numerator / (floor - 1);
}

/**
 * Largest borrow the RiskEngine would still allow: (G+x)/(D+x) > 1.1.
 * The closed form at F=1.1 is exclusive — equality is liquidatable.
 */
export function maxBorrowForProtocolUsd(grossUsd: number, debtUsd: number): number {
  const atGate = maxBorrowForFloorUsd(grossUsd, debtUsd, LIQUIDATION_THRESHOLD);
  if (!(atGate > 0)) return 0;
  return atGate * (1 - 1e-12);
}

/**
 * XLM oracle price at which HF hits the on-chain gate:
 *   (stableUsd + xlmQty * P) / debtUsd = 1.1
 *   P = (1.1 * debtUsd - stableUsd) / xlmQty
 * Null when unreachable (stables already cover 1.1× debt, or no XLM).
 */
export function xlmLiquidationPriceUsd(input: {
  debtUsd: number;
  xlmQty: number;
  stableCollateralUsd: number;
}): number | null {
  const { debtUsd, xlmQty, stableCollateralUsd } = input;
  if (!(debtUsd > 0) || !(xlmQty > 0)) return null;
  const p = (LIQUIDATION_THRESHOLD * debtUsd - stableCollateralUsd) / xlmQty;
  return p > 0 && Number.isFinite(p) ? p : null;
}

/**
 * Derive an account's health/solvency figures from its gross collateral and
 * effective (dust-floored) debt, both already valued in USD. Pure — no chain,
 * no rounding beyond JS float; callers format for display.
 */
export function deriveMarginHealth(input: {
  grossCollateralValue: number;
  effectiveDebtValue: number;
  totalBorrowedValue: number;
}): MarginHealth {
  const { grossCollateralValue, effectiveDebtValue, totalBorrowedValue } = input;

  const avgHealthFactor =
    effectiveDebtValue > 0
      ? grossCollateralValue / effectiveDebtValue
      : grossCollateralValue > 0
        ? HEALTH_FACTOR_INFINITY_SENTINEL
        : 0;

  const collateralLeftBeforeLiquidation = Math.max(
    0,
    grossCollateralValue - effectiveDebtValue * LIQUIDATION_THRESHOLD,
  );
  const netAvailableCollateral = Math.max(0, grossCollateralValue - effectiveDebtValue);
  const totalValue = netAvailableCollateral + totalBorrowedValue;
  const debtLimit = grossCollateralValue > 0 ? grossCollateralValue / LIQUIDATION_THRESHOLD : 0;

  return {
    avgHealthFactor,
    collateralLeftBeforeLiquidation,
    netAvailableCollateral,
    totalValue,
    debtLimit,
  };
}
