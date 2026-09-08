import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for two related gross-collateral bugs.
 *
 * computeMarginSnapshot builds grossCollateralValue from THREE disjoint
 * buckets: farmPositionValue (tracking symbols), rawAssetValue (the
 * MARGIN_SAC_BALANCE_KEYS overlay written by reconcileMarginRawSacCollateral),
 * and nonSacCollateralValue (everything else). nonSacCollateralValue's
 * exclusion filter used to hardcode only "XLM"/"BLUSDC" — stale from before
 * reconcileMarginRawSacCollateral was extended to also overlay AQUSDC/SOUSDC.
 * That let a margin account's own AQUSDC balance get summed into gross
 * collateral a second time.
 *
 * Separately, a since-reverted change made reconcileMarginRawSacCollateral net
 * same-asset debt out of the raw SAC balance, on the theory that a raw balance
 * matching current debt is un-deposited borrowed cash. That is wrong for Vanna's
 * leverage/dual-borrow flow: borrowed proceeds are credited straight into the
 * smart account's own CollateralBalanceWAD by the contract itself
 * (record_borrow_and_credit / apply_deposit_borrow_ledger in
 * SmartAccountContract), and RiskEngine's real health factor is computed
 * against that same balance — so netting it out at display time only cratered
 * the shown HF/collateral figures without matching on-chain reality.
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
  it("still counts a borrowed AQUSDC balance sitting in the account as collateral — dual-borrow leverage relies on this", async () => {
    // On a leveraged/dual-borrow position, borrowed proceeds are credited straight
    // into the smart account's own CollateralBalanceWAD by the contract
    // (record_borrow_and_credit / apply_deposit_borrow_ledger in
    // SmartAccountContract), and RiskEngine's real health factor is computed
    // against that same balance. The display must match — netting the debt back
    // out of the raw SAC balance previously cratered HF for every dual-borrow
    // account.
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
    // freshly-borrowed 50, reported as-is (no debt netting).
    mocks.reconcileMarginRawSacCollateral.mockImplementation(
      async (
        _addr: string,
        balances: Record<string, { amount: string; usdValue: string }>,
        _price: (token: string) => number,
      ) => {
        balances.XLM = { amount: "995.54", usdValue: "100.00" };
        balances.BLUSDC = { amount: "0", usdValue: "0.00" };
        balances.AQUSDC = { amount: "50", usdValue: "50.00" };
        balances.SOUSDC = { amount: "0", usdValue: "0.00" };
        return 150; // 100 XLM + 50 AQUSDC collateral
      },
    );

    const snap = await computeMarginSnapshot("CMARGIN");

    // Debt is $50 (AQUSDC). The raw AQUSDC is legitimate leverage collateral
    // (credited by the contract's own ledger), so gross collateral is $150.
    expect(snap.grossCollateralValue).toBeCloseTo(150, 2);
    expect(snap.totalValue).toBeCloseTo(150, 2);
    expect(snap.avgHealthFactor).toBeCloseTo(150 / 50, 5);
    expect(mocks.reconcileMarginRawSacCollateral).toHaveBeenCalledWith(
      "CMARGIN",
      expect.any(Object),
      expect.any(Function),
    );
  });
});
