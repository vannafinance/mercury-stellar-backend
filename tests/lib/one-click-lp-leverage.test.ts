import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for leveraged Aquarius/Soroswap LP positions.
 *
 * AddLiquidity pulls the FULL amounts requested for both legs but mints LP
 * shares only for the proportionally smaller side — so pairing at an
 * oracle-price split (the old behavior) donates the mismatched excess to the
 * pool for free instead of failing loudly. The paired leg must instead be
 * sized off the pool's live reserve ratio, and leverage must scale BOTH legs
 * together (extra same-asset borrow + ratio-correct paired borrow) so the
 * pair stays on-ratio at any leverage, not just 1x.
 */
const mocks = vi.hoisted(() => ({
  depositCollateralTokens: vi.fn(),
  borrowTokens: vi.fn(),
  getAquariusPoolStats: vi.fn(),
  aquariusAddLiquidity: vi.fn(),
  getPoolStats: vi.fn(),
  soroswapAddLiquidity: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: {
    depositCollateralTokens: mocks.depositCollateralTokens,
    borrowTokens: mocks.borrowTokens,
    depositAndBorrow: vi.fn(),
    depositBorrowAndDeployBlendAtomic: vi.fn(),
  },
}));
vi.mock("@/lib/blend-utils", () => ({
  BlendService: { depositToBlendPool: vi.fn() },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    swapFromMargin: vi.fn(),
    addLiquidity: mocks.soroswapAddLiquidity,
    removeLiquidity: vi.fn(),
    getPoolStats: mocks.getPoolStats,
  },
}));
vi.mock("@/lib/aquarius-utils", () => ({
  AquariusService: {
    getAquariusPoolStats: mocks.getAquariusPoolStats,
    addLiquidity: mocks.aquariusAddLiquidity,
    removeLiquidity: vi.fn(),
    aquariusSwapFromMargin: vi.fn(),
  },
}));

import { executeOneClickStrategy } from "@/lib/one-click-strategy";

// Real testnet-observed reserves: pool-implied price is ~$0.0132/XLM, wildly
// different from a ~$0.16/XLM oracle price — the gap this fix closes.
const RESERVES = { reserveA: "107341.13", reserveB: "1413.34" };

const baseParams = {
  userAddress: "GUSER",
  marginAccountAddress: "CACCT",
  collateralAsset: "XLM" as const,
  borrowAsset: "USDC" as const,
  poolProtocol: "Aquarius",
  poolType: "lp" as const,
  poolTokens: ["XLM", "USDC"],
  scenario: "cross-asset-keep" as const,
  prices: { XLM: 0.16, USDC: 1.0 },
};

describe("executeOneClickStrategy — leveraged Aquarius LP pairs at the live pool ratio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.depositCollateralTokens.mockResolvedValue({ success: true, hash: "deposit-hash" });
    mocks.borrowTokens.mockResolvedValue({ success: true, hash: "borrow-hash" });
    mocks.aquariusAddLiquidity.mockResolvedValue({ success: true, hash: "lp-hash" });
    mocks.getAquariusPoolStats.mockResolvedValue({
      ...RESERVES,
      totalShares: "12263.08",
      feeFraction: "0.30%",
      feeRaw: 30,
    });
  });

  it("borrows a same-asset top-up plus a ratio-correct paired amount, ignoring the oracle-priced UI estimate", async () => {
    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 10,
      // Old oracle-price formula would have asked for ~1.62 USDC — must be ignored.
      borrowAmount: 1.62,
      leverage: 2,
    });

    expect(res.success).toBe(true);
    expect(mocks.depositCollateralTokens).toHaveBeenCalledTimes(1);
    expect(mocks.getAquariusPoolStats).toHaveBeenCalled();
    expect(mocks.borrowTokens).toHaveBeenCalledTimes(2);

    const xlmCall = mocks.borrowTokens.mock.calls.find((c) => c[1] === "XLM");
    const usdcCall = mocks.borrowTokens.mock.calls.find((c) => c[1] === "AQUSDC");
    expect(xlmCall).toBeTruthy();
    expect(usdcCall).toBeTruthy();

    // Same-asset top-up: 10 * (2 - 1) = 10 XLM.
    const xlmBorrowedWad = BigInt(xlmCall![2]);
    expect(Number(xlmBorrowedWad) / 1e18).toBeCloseTo(10, 4);

    // Paired leg: (10 + 10) * (1413.34 / 107341.13) ≈ 0.2633 USDC — not 1.62.
    const usdcBorrowedWad = BigInt(usdcCall![2]);
    const usdcBorrowed = Number(usdcBorrowedWad) / 1e18;
    expect(usdcBorrowed).toBeCloseTo(0.2633, 3);
    expect(usdcBorrowed).toBeLessThan(1.62);

    // AddLiquidity gets the net (post-origination-fee) amounts for both legs,
    // in the pool's ratio — not the raw 10 XLM + 1.62 USDC mismatch.
    const [, , , , xlmAmt, usdcAmt] = mocks.aquariusAddLiquidity.mock.calls[0];
    expect(xlmAmt).toBeCloseTo(19.965, 3);
    expect(usdcAmt).toBeCloseTo(0.26241, 4);
  });

  it("1x LP deposit never fetches pool reserves or borrows (swap-half path, unchanged)", async () => {
    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 10,
      borrowAmount: 0,
      leverage: 1,
    });

    expect(res.success).toBe(false); // swapLpAsset isn't mocked to succeed here; irrelevant to this assertion
    expect(mocks.getAquariusPoolStats).not.toHaveBeenCalled();
    expect(mocks.borrowTokens).not.toHaveBeenCalled();
  });

  it("fails loudly instead of falling back to an oracle-priced pair when reserves can't be read", async () => {
    mocks.getAquariusPoolStats.mockResolvedValueOnce(null);

    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 10,
      borrowAmount: 1.62,
      leverage: 2,
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/reserves/i);
    expect(mocks.borrowTokens).not.toHaveBeenCalled();
    expect(mocks.aquariusAddLiquidity).not.toHaveBeenCalled();
  });
});
