import { describe, expect, it, vi } from "vitest";

/**
 * Fixture account CDNGNL… reported contract debt ~$2,705.60 (XLM + USDC) while
 * the app snapshot sometimes showed only the XLM leg (~$1,684.99). The live
 * drop was a listed USDC debt sim returning empty and being omitted; a zero
 * BLUSDC price would have been a second way to invent $0 of debt. Both must
 * refuse rather than understate.
 *
 * Amounts and oracle prices are from docs/copilot/risk-engine-liquidation-snapshot.json.
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

const { computeMarginSnapshot, priceBorrowedDebts, SnapshotUnavailableError } =
  await import("@/lib/account-snapshot");

const XLM_DEBT = "9406.695567";
const USDC_DEBT = "1020.575911";
const XLM_PRICE = 0.17912700946729;
const USDC_PRICE = 1.00002946101930;

function prices(token: string): number {
  return token === "XLM" ? XLM_PRICE : USDC_PRICE;
}

describe("priceBorrowedDebts — fixture XLM + USDC", () => {
  it("sums both legs and does not double-count the USDC/BLUSDC alias", () => {
    const folded = priceBorrowedDebts({
      XLM: { amount: XLM_DEBT, usdValue: "0" },
      USDC: { amount: USDC_DEBT, usdValue: "0" },
      BLUSDC: { amount: USDC_DEBT, usdValue: "0" },
    }, prices);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.totalBorrowedValue).toBeCloseTo(2705.60, 1);
    expect(Object.keys(folded.value.borrowedBalances).sort()).toEqual(["BLUSDC", "XLM"]);
    expect(parseFloat(folded.value.borrowedBalances.XLM.usdValue)).toBeCloseTo(1684.99, 0);
    expect(parseFloat(folded.value.borrowedBalances.BLUSDC.usdValue)).toBeCloseTo(1020.61, 0);
  });

  it("refuses a missing or zero price on a non-zero debt instead of contributing $0", () => {
    expect(priceBorrowedDebts({
      XLM: { amount: XLM_DEBT, usdValue: "0" },
      USDC: { amount: USDC_DEBT, usdValue: "0" },
    }, (token) => token === "XLM" ? XLM_PRICE : 0).ok).toBe(false);
  });

  it("refuses alias rows whose amounts disagree rather than keeping Math.max", () => {
    const folded = priceBorrowedDebts({
      USDC: { amount: "1000", usdValue: "0" },
      BLUSDC: { amount: "500", usdValue: "0" },
    }, () => 1);
    expect(folded.ok).toBe(false);
    if (folded.ok) return;
    expect(folded.reason).toMatch(/alias amounts disagree/);
  });
});

describe("computeMarginSnapshot — incomplete debt is not a total", () => {
  it("throws when the borrowed scan itself failed", async () => {
    mocks.getCurrentBorrowedBalances.mockResolvedValue({
      success: false, error: "Incomplete debt read: USDC",
    });
    mocks.getCollateralBalances.mockResolvedValue({ success: true, data: {} });
    mocks.fetchTokenPrices.mockResolvedValue({});
    mocks.getCachedTokenPrice.mockImplementation(prices);
    mocks.getPoolStats.mockResolvedValue({ utilizationRate: "0" });
    mocks.mergeFarmTrackingCollateralIntoBalances.mockResolvedValue({});
    mocks.reconcileMarginRawSacCollateral.mockResolvedValue(0);

    await expect(computeMarginSnapshot("CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C"))
      .rejects.toBeInstanceOf(SnapshotUnavailableError);
  });

  it("totals fixture XLM and USDC debt together", async () => {
    mocks.getCurrentBorrowedBalances.mockResolvedValue({
      success: true,
      data: {
        XLM: { amount: XLM_DEBT, usdValue: "0" },
        USDC: { amount: USDC_DEBT, usdValue: "0" },
        BLUSDC: { amount: USDC_DEBT, usdValue: "0" },
      },
    });
    mocks.getCollateralBalances.mockResolvedValue({
      success: true,
      data: { XLM: { amount: "9730.177193", usdValue: "0" } },
    });
    mocks.fetchTokenPrices.mockResolvedValue({});
    mocks.getCachedTokenPrice.mockImplementation(prices);
    mocks.getPoolStats.mockResolvedValue({ utilizationRate: "0" });
    mocks.mergeFarmTrackingCollateralIntoBalances.mockResolvedValue({});
    mocks.reconcileMarginRawSacCollateral.mockResolvedValue(0);

    const snap = await computeMarginSnapshot("CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C");
    expect(snap.totalBorrowedValue).toBeCloseTo(2705.60, 1);
    expect(snap.borrowedBalances.XLM).toBeDefined();
    expect(snap.borrowedBalances.BLUSDC).toBeDefined();
  });
});
