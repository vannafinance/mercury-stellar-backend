import { describe, it, expect } from "vitest";

import {
  deriveMarginHealth,
  healthFactorFromUsd,
  isOnChainLiquidatable,
  LIQUIDATION_THRESHOLD,
  maxBorrowForProtocolUsd,
  xlmLiquidationPriceUsd,
  HEALTH_FACTOR_INFINITY_SENTINEL,
} from "@/lib/margin-health";

/**
 * Verifies the margin health/solvency math against the protocol reference:
 *   HF = gross_collateral_usd / debt_usd  (healthy while HF > 1.1)
 *   collateralLeftBeforeLiquidation = gross − debt × 1.1   (clamped ≥ 0)
 *   netAvailableCollateral          = gross − debt          (clamped ≥ 0)
 *   debtLimit                       = gross / 1.1
 */
const derive = (gross: number, debt: number, borrowed = debt) =>
  deriveMarginHealth({
    grossCollateralValue: gross,
    effectiveDebtValue: debt,
    totalBorrowedValue: borrowed,
  });

describe("deriveMarginHealth", () => {
  it("collateral, no debt → HF sentinel (∞), full headroom", () => {
    const h = derive(1000, 0, 0);
    expect(h.avgHealthFactor).toBe(HEALTH_FACTOR_INFINITY_SENTINEL);
    expect(h.netAvailableCollateral).toBe(1000);
    expect(h.collateralLeftBeforeLiquidation).toBe(1000);
    expect(h.debtLimit).toBeCloseTo(1000 / 1.1, 6); // 909.09…
    expect(h.totalValue).toBe(1000);
  });

  it("empty account (no collateral, no debt) → HF 0", () => {
    expect(derive(0, 0, 0).avgHealthFactor).toBe(0);
  });

  it("healthy position: HF = collateral / debt", () => {
    const h = derive(1000, 500);
    expect(h.avgHealthFactor).toBeCloseTo(2.0, 6);
    expect(h.collateralLeftBeforeLiquidation).toBeCloseTo(1000 - 500 * 1.1, 6); // 450
    expect(h.netAvailableCollateral).toBeCloseTo(500, 6);
    expect(h.totalValue).toBeCloseTo(1000, 6); // netAvail 500 + borrowed 500
  });

  it("at the liquidation boundary (HF = 1.1) collateral-left hits 0", () => {
    const h = derive(550, 500);
    expect(h.avgHealthFactor).toBeCloseTo(LIQUIDATION_THRESHOLD, 6);
    expect(h.collateralLeftBeforeLiquidation).toBeCloseTo(0, 6);
  });

  it("underwater position clamps headroom to 0 (never negative)", () => {
    const h = derive(400, 500);
    expect(h.avgHealthFactor).toBeCloseTo(0.8, 6);
    expect(h.collateralLeftBeforeLiquidation).toBe(0);
    expect(h.netAvailableCollateral).toBe(0);
  });

  it("INVARIANT: collateral-left > 0  ⟺  HF > 1.1 (liquidation threshold)", () => {
    for (const [gross, debt] of [[1000, 500], [550, 500], [560, 500], [400, 500]] as const) {
      const h = derive(gross, debt);
      if (h.collateralLeftBeforeLiquidation > 0) {
        expect(h.avgHealthFactor).toBeGreaterThan(LIQUIDATION_THRESHOLD);
      } else {
        expect(h.avgHealthFactor).toBeLessThanOrEqual(LIQUIDATION_THRESHOLD);
      }
    }
  });

  it("INVARIANT: borrowing exactly debtLimit lands HF at the 1.1 threshold", () => {
    const gross = 1000;
    const { debtLimit } = derive(gross, 0, 0);
    const atLimit = derive(gross, debtLimit, debtLimit);
    expect(atLimit.avgHealthFactor).toBeCloseTo(LIQUIDATION_THRESHOLD, 6);
  });
});

describe("protocol helpers match RiskEngine testnet", () => {
  it("healthFactorFromUsd is collateral/debt with no haircut", () => {
    expect(healthFactorFromUsd(1400, 1000)).toBeCloseTo(1.4, 10);
    expect(healthFactorFromUsd(1400, 1000)).not.toBeCloseTo(1.4 * 0.909, 3);
    expect(healthFactorFromUsd(1000, 0)).toBeNull();
  });

  it("isOnChainLiquidatable is HF <= 1.1 with debt (strict gate is HF > 1.1)", () => {
    expect(isOnChainLiquidatable(1.1, 1000)).toBe(true);
    expect(isOnChainLiquidatable(1.08, 1000)).toBe(true);
    expect(isOnChainLiquidatable(1.100001, 1000)).toBe(false);
    expect(isOnChainLiquidatable(0, 0)).toBe(false);
  });

  it("xlmLiquidationPriceUsd solves (stables + xlmQty*P)/debt = 1.1", () => {
    // 2000 XLM + $200 stables, $400 debt → P = (1.1*400 - 200)/2000 = 0.12
    expect(xlmLiquidationPriceUsd({ debtUsd: 400, xlmQty: 2000, stableCollateralUsd: 200 })).toBeCloseTo(0.12, 10);
  });

  it("maxBorrowForProtocolUsd is exclusive of the 1.1 gate", () => {
    // At-gate closed form for G=100, D=0: 100/0.1 = 1000 → HF = 1.1 (unhealthy).
    // Protocol max shrinks so HF > 1.1.
    const max = maxBorrowForProtocolUsd(100, 0);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(1000);
    expect((100 + max) / max).toBeGreaterThan(1.1);
  });
});
