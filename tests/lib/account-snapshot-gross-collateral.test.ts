import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for the AQUSDC/SOUSDC double-counted-collateral bug.
 *
 * computeMarginSnapshot builds grossCollateralValue from THREE disjoint
 * buckets: farmPositionValue (tracking symbols), rawAssetValue (the
 * MARGIN_SAC_BALANCE_KEYS overlay written by reconcileMarginRawSacCollateral),
 * and nonSacCollateralValue (everything else). nonSacCollateralValue's
 * exclusion filter used to hardcode only "XLM"/"BLUSDC" — stale from before
 * reconcileMarginRawSacCollateral was extended to also overlay AQUSDC/SOUSDC.
 * That let a margin account's own AQUSDC balance (including freshly-borrowed
 * debt sitting in the account, exactly what happens mid a rapid borrow
 * sequence) get summed into gross collateral — and, before the SAC-key filter,
 * sometimes twice — silently propping up the displayed Net Health Factor as
 * more was borrowed instead of it degrading.
 */
const mocks = vi.hoisted(() => ({
  getCurrentBorrowedBalances: vi.fn(),
  getCollateralBalances: vi.fn(),
  getPoolStats: vi.fn(),
  fetchTokenPrices: vi.fn(),
  getCachedTokenPrice: vi.fn(),
  mergeFarmTrackingCollateralIntoBalances: vi.fn(),
  reconcileMarginRawSacCollateral: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: {
    getCurrentBorrowedBalances: mocks.getCurrentBorrowedBalances,
    getCollateralBalances: mocks.getCollateralBalances,
  },
}));
vi.mock("@/lib/oracle-price", () => ({
  fetchTokenPrices: mocks.fetchTokenPrices,
  getCachedTokenPrice: mocks.getCachedTokenPrice,
}));
vi.mock("@/lib/stellar-utils", () => ({
  ContractService: { getPoolStats: mocks.getPoolStats },
  ASSET_TYPES: { XLM: "XLM", USDC: "USDC", AQUARIUS_USDC: "AQUSDC", SOROSWAP_USDC: "SOUSDC" },
  CONTRACT_ADDRESSES: { ORACLE: "CORACLE" },
}));
vi.mock("@/lib/analytics/stellar/farmTrackingCollateral", () => ({
  mergeFarmTrackingCollateralIntoBalances: mocks.mergeFarmTrackingCollateralIntoBalances,
  reconcileMarginRawSacCollateral: mocks.reconcileMarginRawSacCollateral,
  sumCollateralBalancesUsd: (balances: Record<string, { usdValue: string }>) =>
    Object.values(balances).reduce((sum, b) => sum + (parseFloat(b.usdValue) || 0), 0),
  MARGIN_SAC_BALANCE_KEYS: ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"],
}));

import { computeMarginSnapshot } from "@/lib/account-snapshot";

describe("computeMarginSnapshot — gross collateral must not double-count SAC-reconciled tokens", () => {
  it("does not treat a borrowed AQUSDC balance sitting in the account as collateral", async () => {
    mocks.getCollateralBalances.mockResolvedValue({
      success: true,
      data: { XLM: { amount: "995.54", usdValue: "0" } },
    });
    mocks.getCurrentBorrowedBalances.mockResolvedValue({
      success: true,
      data: { AQUSDC: { amount: "50", usdValue: "0" } },
    });
    mocks.fetchTokenPrices.mockResolvedValue({});
    mocks.getCachedTokenPrice.mockReturnValue(1);
    mocks.getPoolStats.mockResolvedValue({ utilizationRate: "0" });
    mocks.mergeFarmTrackingCollateralIntoBalances.mockResolvedValue({});

    // Mirrors the real reconcileMarginRawSacCollateral: raw AQUSDC includes the
    // freshly-borrowed debt, but the snapshot passes the debt map so that cash is
    // removed before it contributes to collateral.
    mocks.reconcileMarginRawSacCollateral.mockImplementation(
      async (
        _addr: string,
        balances: Record<string, { amount: string; usdValue: string }>,
        _price: (token: string) => number,
        borrowed: Record<string, { amount: string; usdValue: string }>,
      ) => {
        balances.XLM = { amount: "995.54", usdValue: "100.00" };
        balances.BLUSDC = { amount: "0", usdValue: "0.00" };
        const rawAq = 50;
        const netAq = Math.max(0, rawAq - parseFloat(borrowed.AQUSDC?.amount || "0"));
        balances.AQUSDC = { amount: String(netAq), usdValue: netAq.toFixed(2) };
        balances.SOUSDC = { amount: "0", usdValue: "0.00" };
        return 100 + netAq; // 100 XLM + 0 net AQUSDC collateral
      },
    );

    const snap = await computeMarginSnapshot("CMARGIN");

    // Debt is $50 (AQUSDC). The raw AQUSDC is entirely borrowed cash, so only
    // the $100 XLM remains as collateral — not $150 or $200.
    expect(snap.grossCollateralValue).toBeCloseTo(100, 2);
    expect(snap.totalValue).toBeCloseTo(100, 2);
    expect(snap.avgHealthFactor).toBeCloseTo(100 / 50, 5);
    expect(mocks.reconcileMarginRawSacCollateral).toHaveBeenCalledWith(
      "CMARGIN",
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ AQUSDC: { amount: "50", usdValue: "50.00" } }),
    );
  });
});
