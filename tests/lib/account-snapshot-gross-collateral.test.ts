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
      async (
        _addr: string,
        balances: Record<string, { amount: string; usdValue: string }>,
      ) => {
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
    expect(snap.netAvailableCollateral).toBeCloseTo(100, 2);
    expect(snap.collateralLeftBeforeLiquidation).toBeCloseTo(150 - 50 * 1.1, 2);
    expect(mocks.reconcileMarginRawSacCollateral).toHaveBeenCalledWith(
      "CMARGIN",
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ AQUSDC: { amount: "50", usdValue: "50.00" } }),
    );
  });

  it("correctly models 2.0x leverage on a fresh wallet without liquidation warning or zeroed collateral", async () => {
    // Fresh wallet deposits $15 XLM and borrows $15 BLUSDC (2.0x leverage)
    mocks.getCollateralBalances.mockResolvedValue({
      success: true,
      data: { XLM: { amount: "100", usdValue: "15.00" } },
    });
    mocks.getCurrentBorrowedBalances.mockResolvedValue({
      success: true,
      data: { BLUSDC: { amount: "15", usdValue: "15.00" } },
    });
    mocks.fetchTokenPrices.mockResolvedValue({});
    mocks.getCachedTokenPrice.mockImplementation((token: string) => {
      if (token === "XLM") return 0.15;
      return 1.0;
    });
    mocks.getPoolStats.mockResolvedValue({ utilizationRate: "0" });
    mocks.mergeFarmTrackingCollateralIntoBalances.mockResolvedValue({});

    // Smart margin account physically holds 100 XLM ($15) + 15 BLUSDC ($15)
    mocks.reconcileMarginRawSacCollateral.mockImplementation(
      async (
        _addr: string,
        balances: Record<string, { amount: string; usdValue: string }>,
      ) => {
        balances.XLM = { amount: "100", usdValue: "15.00" };
        balances.BLUSDC = { amount: "15", usdValue: "15.00" };
        balances.AQUSDC = { amount: "0", usdValue: "0.00" };
        balances.SOUSDC = { amount: "0", usdValue: "0.00" };
        return 30.00; // $15 XLM + $15 BLUSDC gross assets
      },
    );

    const snap = await computeMarginSnapshot("CFRESH");

    // Solvency accounting: Gross assets = $30, Debt = $15 -> HF = 2.00
    expect(snap.grossCollateralValue).toBeCloseTo(30.00, 2);
    expect(snap.totalBorrowedValue).toBeCloseTo(15.00, 2);
    expect(snap.avgHealthFactor).toBeCloseTo(2.0, 4);
    // Buffer = 30 - 1.1 * 15 = $13.50 (well above 0, liquidation banner will NOT fire)
    expect(snap.collateralLeftBeforeLiquidation).toBeCloseTo(13.50, 2);
    // Net available equity = 30 - 15 = $15.00 (user's pure initial deposit)
    expect(snap.netAvailableCollateral).toBeCloseTo(15.00, 2);
    expect(snap.totalValue).toBeCloseTo(30.00, 2);
  });
});
