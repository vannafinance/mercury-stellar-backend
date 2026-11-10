import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the phantom-AQUSDC-collateral bug.
 *
 * (Historical: the old SmartAccount collateral ledger (CollateralBalanceWAD) never
 * updated when a deposited AQUSDC/SOUSDC balance got deployed into an LP.) The credit
 * layer has no such ledger; collateral IS the live token balance, which this pins.
 *
 * Original description: a deposited AQUSDC/SOUSDC balance gets deployed into an Aquarius/Soroswap LP
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

// The credit layer reads SAC balances straight from the token contract
// (tokenBalance(token, margin), native 7-dp units). The mock keeps the old
// per-symbol shape: map the token address back to its symbol, and the human
// amount to native units.
vi.mock("@/lib/credit-layer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credit-layer")>();
  return {
    ...actual,
    tokenBalance: async (token: string, holder: string) => {
      const asset = actual.creditAssetForToken(token);
      const sac = asset === "BLUSDC" ? "USDC" : asset ?? token;
      const human = await mocks.getMarginAccountTokenBalance(holder, sac);
      return BigInt(Math.round(parseFloat(human) * 1e7));
    },
  };
});
vi.mock("@/lib/margin-credit-reads", () => ({
  AQUARIUS_LP_KEY: "AQ_XLM_USDC",
  SOROSWAP_LP_KEY: "SS_XLM_USDC",
  BLEND_KEYS: { XLM: "BLEND_XLM", USDC: "BLEND_USDC" },
  blendPositions: vi.fn().mockResolvedValue([]),
  priceUsd: vi.fn().mockResolvedValue(1),
}));
vi.mock("@/lib/oracle-price", () => ({
  fetchTokenPrice: vi.fn().mockResolvedValue(1),
}));

import { reconcileMarginRawSacCollateral } from "@/lib/analytics/stellar/farmTrackingCollateral";

describe("reconcileMarginRawSacCollateral — BLUSDC/SOUSDC live-balance overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("overwrites a stale SOUSDC collateral-ledger figure with the real (near-zero) live balance", async () => {
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      // XLM/USDC untouched; SOUSDC mostly deployed into the LP — only 0.76 left raw.
      if (sac === "XLM") return Promise.resolve("1000.0000000");
      if (sac === "USDC") return Promise.resolve("0.0000000");
      if (sac === "SOUSDC") return Promise.resolve("0.7598883");
      return Promise.resolve("0.0000000");
    });

    // Stale on-chain ledger value from before the SOUSDC was deployed into Soroswap.
    const balances: Record<string, { amount: string; usdValue: string }> = {
      SOUSDC: { amount: "161.8700000", usdValue: "161.87" },
    };

    await reconcileMarginRawSacCollateral("CACCT", balances, () => 1);

    // Three credit assets since mainnet-credit-layer (no AQUSDC): XLM, BLUSDC (read as "USDC"), SOUSDC.
    expect(mocks.getMarginAccountTokenBalance).toHaveBeenCalledWith("CACCT", "USDC");
    expect(mocks.getMarginAccountTokenBalance).toHaveBeenCalledWith("CACCT", "SOUSDC");
    expect(mocks.getMarginAccountTokenBalance).not.toHaveBeenCalledWith("CACCT", "AQUSDC");
    // The stale 161.87 must be gone — replaced by the real live balance.
    expect(parseFloat(balances.SOUSDC.amount)).toBeCloseTo(0.7598883, 6);
    expect(parseFloat(balances.SOUSDC.usdValue)).toBeCloseTo(0.76, 2);
  });

  it("leaves a genuinely-held SOUSDC balance untouched (not deployed to any LP)", async () => {
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      if (sac === "SOUSDC") return Promise.resolve("50.0000000");
      return Promise.resolve("0.0000000");
    });

    const balances: Record<string, { amount: string; usdValue: string }> = {};
    await reconcileMarginRawSacCollateral("CACCT", balances, () => 1);

    expect(parseFloat(balances.SOUSDC.amount)).toBeCloseTo(50, 6);
  });

  it("does not net same-asset debt out of the raw SAC balance — borrowed proceeds are legitimate leverage collateral", async () => {
    // A dual-borrow/leverage account: 75 SOUSDC raw balance, 50 of which was just
    // borrowed. The contract's own ledger (record_borrow_and_credit /
    // apply_deposit_borrow_ledger in SmartAccountContract) credits borrowed proceeds
    // straight into CollateralBalanceWAD, and RiskEngine's real health factor is
    // computed against that same balance — so the display must not strip it back out.
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      if (sac === "SOUSDC") return Promise.resolve("75.0000000");
      return Promise.resolve("0.0000000");
    });

    const balances: Record<string, { amount: string; usdValue: string }> = {};
    const usd = await reconcileMarginRawSacCollateral("CACCT", balances, () => 1);

    expect(parseFloat(balances.SOUSDC.amount)).toBeCloseTo(75, 6);
    expect(parseFloat(balances.SOUSDC.usdValue)).toBeCloseTo(75, 2);
    expect(usd).toBeCloseTo(75, 2);
  });

  it("preserves raw SAC balances across multiple tokens at their own prices", async () => {
    // Guards the multi-token path: every MARGIN_SAC token is overlaid at its own
    // price, and a borrowed asset's balance survives intact alongside a deposited
    // one. Regression cover for the per-symbol loop, not just the single-token case.
    //
    // Note the asymmetry this also pins down: the Blend USDC entry is READ as sac
    // "USDC" but WRITTEN under balanceKey "BLUSDC", and the price is looked up by
    // the balanceKey. Mocking the balanceKey side returns 0 and silently drops the
    // token out of the total.
    mocks.getMarginAccountTokenBalance.mockImplementation((_addr: string, sac: string) => {
      if (sac === "XLM") return Promise.resolve("100.0000000");
      if (sac === "USDC") return Promise.resolve("50.0000000");
      return Promise.resolve("0.0000000");
    });

    const balances: Record<string, { amount: string; usdValue: string }> = {};
    const priceMap: Record<string, number> = { XLM: 0.15, BLUSDC: 1.0, SOUSDC: 1.0 };

    const grossUsd = await reconcileMarginRawSacCollateral(
      "CACCT",
      balances,
      (t) => priceMap[t] ?? 1,
    );

    expect(parseFloat(balances.XLM.amount)).toBeCloseTo(100, 6);
    expect(parseFloat(balances.XLM.usdValue)).toBeCloseTo(15.0, 2);
    expect(parseFloat(balances.BLUSDC.amount)).toBeCloseTo(50, 6);
    expect(parseFloat(balances.BLUSDC.usdValue)).toBeCloseTo(50.0, 2);
    // 100 XLM * $0.15 + 50 BLUSDC * $1.00 = $65.00
    expect(grossUsd).toBeCloseTo(65.0, 2);
  });
});
