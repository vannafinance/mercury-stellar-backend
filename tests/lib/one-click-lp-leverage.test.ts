import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for leveraged Aquarius/Soroswap LP positions.
 *
 * AddLiquidity pulls the FULL amounts requested for both legs but mints LP
 * shares only for the proportionally smaller side — so pairing at a flat
 * 50/50 USD split (or an oracle-price split) donates the mismatched excess to
 * the pool for free instead of failing loudly. The paired leg must instead be
 * sized off the pool's live reserve ratio.
 *
 * Separately, the two legs' borrow amounts must SUM to exactly
 * depositUsd × (leverage − 1) — an earlier version borrowed a full
 * (leverage−1)× top-up in the collateral asset AND THEN added the
 * ratio-correct paired leg on top, silently overshooting the selected
 * leverage (e.g. a chosen 2x landed closer to ~2.2x). Both legs must now
 * split that fixed borrow budget while staying on the pool's live ratio.
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

  it("splits the borrow budget across both legs so total leverage lands exactly on target, while staying on the pool's live ratio", async () => {
    const collateralAmount = 10;
    const leverage = 2;
    const xlmPrice = baseParams.prices.XLM;
    const usdcPrice = baseParams.prices.USDC;
    const poolRatio = parseFloat(RESERVES.reserveB) / parseFloat(RESERVES.reserveA); // USDC per XLM

    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount,
      // Old oracle-price formula would have asked for ~1.62 USDC — must be ignored.
      borrowAmount: 1.62,
      leverage,
    });

    expect(res.success).toBe(true);
    expect(mocks.depositCollateralTokens).toHaveBeenCalledTimes(1);
    expect(mocks.getAquariusPoolStats).toHaveBeenCalled();
    expect(mocks.borrowTokens).toHaveBeenCalledTimes(2);

    const xlmCall = mocks.borrowTokens.mock.calls.find((c) => c[1] === "XLM");
    const usdcCall = mocks.borrowTokens.mock.calls.find((c) => c[1] === "AQUSDC");
    expect(xlmCall).toBeTruthy();
    expect(usdcCall).toBeTruthy();

    const xlmBorrowed = Number(BigInt(xlmCall![2])) / 1e18;
    const usdcBorrowed = Number(BigInt(usdcCall![2])) / 1e18;

    // Old oracle-priced estimate (1.62) would have been way off-ratio and way
    // over budget — must not appear anywhere near the actual borrow.
    expect(usdcBorrowed).toBeLessThan(1.62);

    // Invariant 1: total borrow lands exactly at depositUsd × (leverage − 1),
    // not more — this is the overshoot bug itself (previously ~2.2x for a
    // chosen 2x).
    const depositUsd = collateralAmount * xlmPrice;
    const totalBorrowUsd = xlmBorrowed * xlmPrice + usdcBorrowed * usdcPrice;
    expect(totalBorrowUsd).toBeCloseTo(depositUsd * (leverage - 1), 3);

    // Invariant 2: the combined collateral-side vs. paired-side amounts stay
    // on the pool's live reserve ratio — nothing donated to the pool.
    const impliedRatio = usdcBorrowed / (collateralAmount + xlmBorrowed);
    expect(impliedRatio).toBeCloseTo(poolRatio, 5);

    // AddLiquidity gets the (WAD-rounding-buffered, no-fee) amounts for both
    // legs, still on-ratio — not the raw 10 XLM + 1.62 USDC mismatch. Origination
    // fee is 0% now, so this buffer is just under 1.0 (rounding only).
    const [, , , , xlmAmt, usdcAmt] = mocks.aquariusAddLiquidity.mock.calls[0];
    expect(xlmAmt).toBeCloseTo(collateralAmount + xlmBorrowed * 0.9999, 3);
    expect(usdcAmt).toBeCloseTo(usdcBorrowed * 0.9999, 4);
    expect(usdcAmt).toBeLessThan(1.62);
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
