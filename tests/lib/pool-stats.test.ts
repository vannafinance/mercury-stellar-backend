import { describe, it, expect } from "vitest";

import {
  calculateSupplyAPY,
  calculateBorrowAPY,
  calculateExchangeRateFromPool,
} from "@/lib/pool-stats";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";

/**
 * Verifies the lending-pool stat math behind /api/pools (the Earn page source).
 *
 * Two of the three values are chain-derived and checked exactly. The third —
 * supply APY — is a HARDCODED PLACEHOLDER, and these tests pin + flag that so it
 * shows up in the pre-main verification pass.
 */

describe("calculateExchangeRateFromPool (chain-derived: totalAssets / vTokenSupply)", () => {
  it("computes assets / supply", () => {
    expect(calculateExchangeRateFromPool("100", "95")).toBe("1.0526316");
    expect(calculateExchangeRateFromPool("210", "200")).toBe("1.0500000");
  });

  it("is >= 1 once interest has accrued (assets grow vs vToken supply)", () => {
    expect(parseFloat(calculateExchangeRateFromPool("110", "100"))).toBeGreaterThan(1);
  });

  it("falls back to 1 on empty/zero pools (no divide-by-zero)", () => {
    expect(calculateExchangeRateFromPool("0", "95")).toBe("1");
    expect(calculateExchangeRateFromPool("100", "0")).toBe("1");
    expect(calculateExchangeRateFromPool("0", "0")).toBe("1");
  });
});

describe("calculateBorrowAPY (delegates to the on-chain rate model)", () => {
  it("matches computeBorrowApr for the given utilization", () => {
    for (const util of ["0", "25.00", "50.00", "82.97", "97.00"]) {
      expect(calculateBorrowAPY(util)).toBe(computeBorrowApr(parseFloat(util)).toFixed(2));
    }
  });

  it("is monotonic in utilization (higher util ⇒ higher borrow APY)", () => {
    expect(parseFloat(calculateBorrowAPY("80"))).toBeGreaterThan(
      parseFloat(calculateBorrowAPY("20")),
    );
  });
});

describe("⚠️ calculateSupplyAPY — PLACEHOLDER, NOT on-chain (flagged for pre-main)", () => {
  // Earn supply APY is `2.0 + utilization × 10`, a hardcoded linear stand-in —
  // it is NOT derived from the Blend reserve / rate model. This is the root of
  // the Earn-vs-Farm APY mismatch: Earn shows ~6.70% at 47% util while the Farm
  // page shows the real IR-curve APY (triple digits at high util). These tests
  // document the placeholder; resolving it = route Earn through the same
  // reserve math as Farm (or compute supply APY = borrow APR × util × (1 −
  // backstop), compounded), then update these expectations.
  it("is the linear placeholder 2.0 + util×10, not the rate model", () => {
    expect(calculateSupplyAPY("0")).toBe("2.00");
    expect(calculateSupplyAPY("50.00")).toBe("7.00");
    expect(calculateSupplyAPY("100.00")).toBe("12.00");
  });

  it("reproduces the exact Earn screen value at ~47% utilization", () => {
    // 2.0 + 0.4696 × 10 = 6.696 → "6.70"
    expect(calculateSupplyAPY("46.96")).toBe("6.70");
  });

  it("DIVERGES from the rate model (placeholder ≠ chain-derived borrow-based APY)", () => {
    // At high utilization the real borrow APR is large; the placeholder supply
    // APY stays ~12%. This inequality is the bug, asserted so it can't silently
    // pass once supply APY is correctly wired to the reserve math.
    const util = "97.00";
    const placeholder = parseFloat(calculateSupplyAPY(util)); // ~11.7%
    const realBorrowApr = computeBorrowApr(parseFloat(util)); // large
    expect(realBorrowApr).toBeGreaterThan(placeholder);
  });
});
