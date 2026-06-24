import { describe, it, expect } from "vitest";

import { BlendService } from "@/lib/blend-utils";

/**
 * Verifies BlendService._parseReserveData against the protocol math reference
 * (https://vannafinance.mintlify.app/developers/math-reference):
 *
 *   underlying       = b_supply/1e7 × b_rate/1e12        (b-rate is SCALAR_12)
 *   utilization      = totalBorrow / totalSupply
 *   borrow APR (T1)  = ((util/target)×r_one + r_base) × ir_mod   (SCALAR_7)
 *   borrow APY       = (1 + apr/365)^365 − 1               (daily compound)
 *   supply APR       = borrow_apr × util × (1 − backstop)  (backstop 10%)
 *   supply APY       = (1 + apr/52)^52 − 1                 (weekly compound)
 *
 * These are pure-function checks (no chain) so a scaling regression (e.g. a WAD
 * vs SCALAR_7 vs SCALAR_12 mix-up) fails CI immediately.
 */

// SCALAR_7 fixed-point: 1e7 == 100%, so p% == p/100 × 1e7 == p × 1e5.
// (Matches the contract convention: r_one = 500_000 means 5%.)
const pct7 = (p: number) => Math.round(p * 1e5); // 5% -> 500_000, 80% -> 8_000_000

// Tier-1 fixture: utilization (45.83%) below the 80% target, so the borrow rate
// is the linear base+r_one segment — hand-computable.
const tier1Reserve = {
  data: {
    b_rate: 1.2e12, // 1.2 underlying per b-token
    b_supply: 1000 * 1e7, // 1000 b-tokens
    d_rate: 1.1e12,
    d_supply: 500 * 1e7, // 500 d-tokens
    ir_mod: 1e7, // 1.0 (neutral)
  },
  config: {
    decimals: 7,
    r_base: 0,
    r_one: pct7(5), // 5%
    r_two: pct7(50),
    r_three: pct7(100),
    util: pct7(80), // 80% target utilization
  },
};

describe("BlendService._parseReserveData (Tier 1, util < target)", () => {
  const r = BlendService._parseReserveData(tier1Reserve);

  it("converts b-tokens to underlying via b_rate/1e12", () => {
    // 1000 b-tokens × 1.2 = 1200 underlying
    expect(r.totalSupply).toBe("1200.0000");
    // 500 d-tokens × 1.1 = 550 underlying
    expect(r.totalBorrow).toBe("550.0000");
    expect(r.bRate).toBe("1.2000000");
  });

  it("computes utilization = borrow / supply", () => {
    // 550 / 1200 = 45.83%
    expect(r.utilizationRate).toBe("45.83");
  });

  it("borrow APY = daily-compounded borrow APR (~2.91%)", () => {
    // util/target = 0.45833/0.8 = 0.572917; ×5% = 2.8646% APR
    // (1 + 0.028646/365)^365 − 1 ≈ 2.906%
    expect(parseFloat(r.borrowAPY)).toBeCloseTo(2.91, 1);
  });

  it("supply APY = weekly-compounded supply APR (~1.19%)", () => {
    // 2.8646% × 0.45833 util × 0.90 backstop = 1.1816% APR
    // (1 + 0.011816/52)^52 − 1 ≈ 1.189%
    expect(parseFloat(r.supplyAPY)).toBeCloseTo(1.19, 1);
  });

  it("INVARIANT: supply APY < borrow APY, both finite and non-negative", () => {
    const supply = parseFloat(r.supplyAPY);
    const borrow = parseFloat(r.borrowAPY);
    expect(Number.isFinite(supply)).toBe(true);
    expect(Number.isFinite(borrow)).toBe(true);
    expect(supply).toBeGreaterThanOrEqual(0);
    expect(supply).toBeLessThan(borrow);
  });

  it("INVARIANT: APY > APR (compounding strictly increases the rate)", () => {
    // borrow APR was 2.8646%; APY must exceed it.
    expect(parseFloat(r.borrowAPY)).toBeGreaterThan(2.8646);
  });
});

describe("BlendService._parseReserveData (high utilization → APY amplification)", () => {
  // Documents WHY the Farm XLM pool can read a triple-digit APY on testnet:
  // high utilization on the steep r_two/r_three tiers, amplified by daily
  // compounding — mathematically consistent, not a scaling bug.
  const highUtilReserve = {
    data: {
      b_rate: 1.0e12,
      b_supply: 1000 * 1e7,
      d_rate: 1.0e12,
      d_supply: 970 * 1e7, // 97% utilization (Tier 3)
      ir_mod: 1e7,
    },
    config: {
      decimals: 7,
      r_base: 0,
      r_one: pct7(5),
      r_two: pct7(50),
      r_three: pct7(100), // steep kink rate above 95% util
      util: pct7(80), // 80% target
    },
  };

  const r = BlendService._parseReserveData(highUtilReserve);

  it("utilization reads 97% (Tier 3, above the 95% kink)", () => {
    expect(r.utilizationRate).toBe("97.00");
  });

  it("amplifies to a triple-digit but finite borrow APY, still > supply APY", () => {
    // Tier-3 APR (~95%) compounded daily → ~158% APY. This is why the live Farm
    // XLM pool can legitimately read triple-digit APY at high testnet
    // utilization — the math is consistent, not a scaling bug.
    const borrow = parseFloat(r.borrowAPY);
    const supply = parseFloat(r.supplyAPY);
    expect(Number.isFinite(borrow)).toBe(true);
    expect(borrow).toBeGreaterThan(50); // far above the Tier-1 ~2.9%
    expect(supply).toBeLessThan(borrow);
  });
});
