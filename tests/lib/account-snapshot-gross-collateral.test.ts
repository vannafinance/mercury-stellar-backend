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
 * sequence) get summed into gross collateral TWICE — once via rawAssetValue,
 * once via nonSacCollateralValue — silently propping up the displayed Net
 * Health Factor as more was borrowed instead of it degrading.
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
  it("does not sum a borrowed AQUSDC balance sitting in the account as collateral twice", async () => {
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

    // Mirrors the real reconcileMarginRawSacCollateral: overlays the margin
    // account's live SAC balances (XLM untouched, plus the freshly-borrowed
    // AQUSDC sitting in the account) into the shared `balances` object.
    mocks.reconcileMarginRawSacCollateral.mockImplementation(
      async (_addr: string, balances: Record<string, { amount: string; usdValue: string }>) => {
        balances.XLM = { amount: "995.54", usdValue: "100.00" };
        balances.BLUSDC = { amount: "0", usdValue: "0.00" };
        balances.AQUSDC = { amount: "50", usdValue: "50.00" };
        balances.SOUSDC = { amount: "0", usdValue: "0.00" };
        return 150; // 100 (XLM) + 0 (BLUSDC) + 50 (AQUSDC) + 0 (SOUSDC)
      },
    );

    const snap = await computeMarginSnapshot("CMARGIN");

    // Debt is $50 (AQUSDC). Collateral is $100 XLM + $50 AQUSDC = $150 total —
    // NOT $200, which is what you get if AQUSDC's $50 is summed twice.
    expect(snap.grossCollateralValue).toBeCloseTo(150, 2);
    expect(snap.totalValue).toBeCloseTo(150, 2);
    expect(snap.avgHealthFactor).toBeCloseTo(150 / 50, 5);
  });
});
