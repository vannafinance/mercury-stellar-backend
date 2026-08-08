import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  calculateSupplyAPY,
  calculateExchangeRateFromPool,
} from "@/lib/pool-stats";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";
import { ContractService } from "@/lib/stellar-utils";

/**
 * Verifies the lending-pool stat math behind /api/pools (the Earn page source).
 *
 * Regression guard: Supply APY and Borrow APY used to come from two
 * independent, uncoupled formulas (a linear "2% + util×10" placeholder for
 * supply vs. a synthetic kinked curve for borrow) — mathematically capable of
 * showing supply HIGHER than borrow, which is impossible under a real lending
 * model (supplier yield is funded by a fraction of borrower interest).
 * calculateBorrowAPY now reads the REAL per-second rate straight from the
 * deployed RateModelContract (the same curve the lending-pool contract itself
 * accrues interest with); calculateSupplyAPY derives from THAT real borrow
 * rate scaled by utilization, guaranteeing supply <= borrow by construction.
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

describe("calculateBorrowAPY (reads the real on-chain RateModelContract curve)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("annualizes the contract's per-second WAD rate correctly", async () => {
    const { calculateBorrowAPY } = await import("@/lib/pool-stats");
    // 2.61% APR ⇒ per-second rate = 0.0261e18 / 31_556_952 (matches the
    // contract's own SECS_PER_YEAR constant), rounded to a whole bigint.
    const ratePerSecWad = BigInt(Math.floor((0.0261 * 1e18) / 31_556_952));
    vi.spyOn(ContractService, "getBorrowRatePerSecWad").mockResolvedValue(ratePerSecWad);

    const apy = await calculateBorrowAPY("87.9", "12.1", "12.10");
    expect(parseFloat(apy)).toBeCloseTo(2.61, 1);
  });

  it("falls back to the synthetic curve when the on-chain read fails", async () => {
    const { calculateBorrowAPY } = await import("@/lib/pool-stats");
    vi.spyOn(ContractService, "getBorrowRatePerSecWad").mockResolvedValue(null);

    const apy = await calculateBorrowAPY("50", "50", "50.00");
    expect(apy).toBe(computeBorrowApr(50).toFixed(2));
  });

  it("is monotonic in the contract-reported rate", async () => {
    const { calculateBorrowAPY } = await import("@/lib/pool-stats");
    const spy = vi.spyOn(ContractService, "getBorrowRatePerSecWad");

    spy.mockResolvedValueOnce(BigInt(Math.floor((0.05 * 1e18) / 31_556_952)));
    const low = await calculateBorrowAPY("80", "20", "20.00");
    spy.mockResolvedValueOnce(BigInt(Math.floor((0.40 * 1e18) / 31_556_952)));
    const high = await calculateBorrowAPY("20", "80", "80.00");

    expect(parseFloat(high)).toBeGreaterThan(parseFloat(low));
  });
});

describe("calculateSupplyAPY (utilization-scaled fraction of the real borrow APY — never exceeds it)", () => {
  it("is borrowApy × utilization", () => {
    expect(calculateSupplyAPY(10, "50.00")).toBe("5.00");
    expect(calculateSupplyAPY(8, "0")).toBe("0.00");
    expect(calculateSupplyAPY(8, "100.00")).toBe("8.00");
  });

  it("never exceeds the borrow APY it's derived from, at any utilization", () => {
    for (const util of ["0", "12.10", "40.30", "68.20", "97.00", "100.00"]) {
      const borrowApy = 25; // arbitrary fixed borrow rate
      const supplyApy = parseFloat(calculateSupplyAPY(borrowApy, util));
      expect(supplyApy).toBeLessThanOrEqual(borrowApy);
    }
  });

  it("reproduces the reported live mismatch case correctly once fixed: XLM at ~12.1% utilization", () => {
    // Previously the independent placeholder formulas produced supply
    // (3.21%) > borrow (2.61%) at this utilization. With supply correctly
    // derived from borrow, it must now be the smaller number.
    const borrowApy = 2.61;
    const supplyApy = parseFloat(calculateSupplyAPY(borrowApy, "12.10"));
    expect(supplyApy).toBeLessThan(borrowApy);
  });
});
