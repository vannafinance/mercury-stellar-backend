import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the phantom-AQUSDC-collateral bug.
 *
 * The on-chain collateral ledger (CollateralBalanceWAD) never updates when a
 * deposited AQUSDC/SOUSDC balance gets deployed into an Aquarius/Soroswap LP
 * (e.g. via the Lite one-click flow) — it keeps reporting the original
 * deposit as still-free collateral. positions-table.tsx nets that stale
 * figure against same-token debt to hide it, which only works while debt
 * stays >= the stale collateral value; once a repay drops debt below it, the
 * stale amount surfaces as a real (but fake) "Collateral Deposited" row.
 *
 * The fix: reconcileMarginRawSacCollateral must overlay AQUSDC/SOUSDC with
 * their LIVE raw SAC balance too — same as it already did for XLM/USDC —
 * so the stale ledger figure never reaches the collateral display at all.
 */
const mocks = vi.hoisted(() => ({
  getMarginAccountTokenBalance: vi.fn(),
}));

vi.mock("@/lib/blend-utils", () => ({
  BlendService: {
    getMarginAccountTokenBalance: mocks.getMarginAccountTokenBalance,
  },
}));
vi.mock("@/lib/aquarius-utils", () => ({
  AquariusService: {
    getLpBalance: vi.fn().mockResolvedValue("0"),
    getAquariusPoolStats: vi.fn().mockResolvedValue(null),
  },
  AQUARIUS_POOLS: [],
  aquariusLpUnderlyingAmounts: vi.fn(),
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    getLpBalance: vi.fn().mockResolvedValue("0"),
    getPoolStats: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("@/lib/oracle-price", () => ({
  fetchTokenPrice: vi.fn().mockResolvedValue(1),
}));

import { reconcileMarginRawSacCollateral } from "@/lib/analytics/stellar/farmTrackingCollateral";

describe("reconcileMarginRawSacCollateral — AQUSDC/SOUSDC live-balance overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("overwrites a stale AQUSDC collateral-ledger figure with the real (near-zero) live balance", async () => {
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      // XLM/USDC untouched; AQUSDC mostly deployed into the LP — only 0.76 left raw.
      if (sac === "XLM") return Promise.resolve("1000.0000000");
      if (sac === "USDC") return Promise.resolve("0.0000000");
      if (sac === "AQUSDC") return Promise.resolve("0.7598883");
      if (sac === "SOUSDC") return Promise.resolve("0.0000000");
      return Promise.resolve("0.0000000");
    });

    // Stale on-chain ledger value from before the AQUSDC was deployed into Aquarius.
    const balances: Record<string, { amount: string; usdValue: string }> = {
      AQUSDC: { amount: "161.8700000", usdValue: "161.87" },
    };

    await reconcileMarginRawSacCollateral("CACCT", balances, () => 1);

    expect(mocks.getMarginAccountTokenBalance).toHaveBeenCalledWith("CACCT", "AQUSDC");
    expect(mocks.getMarginAccountTokenBalance).toHaveBeenCalledWith("CACCT", "SOUSDC");
    // The stale 161.87 must be gone — replaced by the real live balance.
    expect(parseFloat(balances.AQUSDC.amount)).toBeCloseTo(0.7598883, 6);
    expect(parseFloat(balances.AQUSDC.usdValue)).toBeCloseTo(0.76, 2);
  });

  it("leaves a genuinely-held AQUSDC balance untouched (not deployed to any LP)", async () => {
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      if (sac === "AQUSDC") return Promise.resolve("50.0000000");
      return Promise.resolve("0.0000000");
    });

    const balances: Record<string, { amount: string; usdValue: string }> = {};
    await reconcileMarginRawSacCollateral("CACCT", balances, () => 1);

    expect(parseFloat(balances.AQUSDC.amount)).toBeCloseTo(50, 6);
  });

  it("nets same-asset debt from a raw SAC balance when the debt map is provided", async () => {
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      if (sac === "AQUSDC") return Promise.resolve("75.0000000");
      return Promise.resolve("0.0000000");
    });

    const balances: Record<string, { amount: string; usdValue: string }> = {};
    const borrowed = {
      AQUSDC: { amount: "50.0000000", usdValue: "50.00" },
    };

    const netUsd = await reconcileMarginRawSacCollateral("CACCT", balances, () => 1, borrowed);

    expect(parseFloat(balances.AQUSDC.amount)).toBeCloseTo(25, 6);
    expect(parseFloat(balances.AQUSDC.usdValue)).toBeCloseTo(25, 2);
    expect(netUsd).toBeCloseTo(25, 2);
  });
});
