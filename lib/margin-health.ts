// Pure margin health/solvency math, extracted from computeMarginSnapshot so the
// formulas have a single source of truth and can be unit-verified against the
// protocol math reference (https://vannafinance.mintlify.app/developers).
//
//   health factor      = gross_collateral_usd / debt_usd        (∞ when no debt)
//   liquidatable when  = HF <= 1.1   (collateralLeftBeforeLiquidation reaches 0)
//   debt limit         = gross_collateral_usd / 1.1
//   net available      = gross_collateral_usd − debt_usd

// Liquidation threshold (the Risk Engine liquidates at HF <= 1.1).
export const LIQUIDATION_THRESHOLD = 1.1;

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
