import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserLpBalance: vi.fn(),
  getAquariusPoolStats: vi.fn(),
  getLpBalance: vi.fn(),
  getPoolStats: vi.fn(),
  getBlendBalance: vi.fn(),
  getDebts: vi.fn(),
  fetchTokenPrices: vi.fn(),
  getCachedTokenPrice: vi.fn(),
}));

vi.mock("@/lib/aquarius-utils", () => ({
  AquariusService: {
    getUserLpBalance: mocks.getUserLpBalance,
    getAquariusPoolStats: mocks.getAquariusPoolStats,
  },
  AQUARIUS_POOLS: [{ id: "aquarius-xlm-usdc", poolAddress: "CPOOLAQ", tokens: ["XLM", "USDC"] }],
  aquariusLpUnderlyingAmounts: (
    lp: number,
    stats: { totalShares: string; reserveA: string; reserveB: string },
  ) => {
    const ratio = lp / parseFloat(stats.totalShares);
    return { amountA: ratio * parseFloat(stats.reserveA), amountB: ratio * parseFloat(stats.reserveB) };
  },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    getLpBalance: mocks.getLpBalance,
    getPoolStats: mocks.getPoolStats,
  },
}));
vi.mock("@/lib/blend-utils", () => ({
  BlendService: { getUserBlendBalance: mocks.getBlendBalance },
}));
vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: { getCurrentBorrowedBalances: mocks.getDebts },
}));
vi.mock("@/lib/oracle-price", () => ({
  fetchTokenPrices: mocks.fetchTokenPrices,
  getCachedTokenPrice: mocks.getCachedTokenPrice,
}));

import { getLitePositionsFromChain } from "@/lib/lite-positions";

describe("getLitePositionsFromChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchTokenPrices.mockResolvedValue({ XLM: 0.2, USDC: 1 });
    mocks.getCachedTokenPrice.mockImplementation((symbol: string) => symbol === "XLM" ? 0.2 : 1);
    mocks.getDebts.mockResolvedValue({ success: true, data: {} });
    mocks.getBlendBalance.mockResolvedValue({ underlyingBalance: "0" });
    mocks.getLpBalance.mockResolvedValue("0");
    mocks.getPoolStats.mockResolvedValue(null);
    mocks.getUserLpBalance.mockResolvedValue("0");
    mocks.getAquariusPoolStats.mockResolvedValue(null);
  });

  it("returns no positions without an account or on-chain balances", async () => {
    await expect(getLitePositionsFromChain(null)).resolves.toEqual([]);
    await expect(getLitePositionsFromChain("CACCT")).resolves.toEqual([]);
  });

  it("reconstructs an Aquarius LP position from LP shares and reserves", async () => {
    mocks.getUserLpBalance.mockResolvedValue("10");
    mocks.getAquariusPoolStats.mockResolvedValue({
      totalShares: "100",
      reserveA: "1000",
      reserveB: "200",
    });
    mocks.getDebts.mockResolvedValue({
      success: true,
      data: { AQUSDC: { amount: "10", usdValue: "10" } },
    });

    const positions = await getLitePositionsFromChain("CACCT");

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      id: "chain-aquarius-xlm-usdc",
      recovered: true,
      collateralAmount: 100,
      borrowAsset: "USDC",
      borrowAmount: 10,
    });
  });

  it("derives a Blend position and debt from tracking-token state", async () => {
    mocks.getBlendBalance
      .mockResolvedValueOnce({ underlyingBalance: "25" })
      .mockResolvedValueOnce({ underlyingBalance: "0" });
    mocks.getDebts.mockResolvedValue({
      success: true,
      data: { XLM: { amount: "5", usdValue: "1" } },
    });

    const [position] = await getLitePositionsFromChain("CACCT");

    expect(position).toMatchObject({
      protocol: "Blend",
      collateralAsset: "XLM",
      collateralAmount: 20,
      borrowAmount: 5,
      leverage: 1.25,
      recovered: true,
    });
  });
});
