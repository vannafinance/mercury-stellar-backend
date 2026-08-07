import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for closing a leveraged Aquarius/Soroswap LP position.
 *
 * Two bugs fixed here:
 *   1. The old `approxLpAmt = borrowAmount * pct` heuristic used the
 *      borrowed-USDC amount as if it were an LP share count — a different
 *      unit entirely — so it removed the wrong fraction of the real
 *      position. Must instead read the REAL on-chain LP balance (same as
 *      the Farm page's own Remove Liquidity) and scale THAT by exitPct.
 *   2. A leveraged LP position carries a SECOND debt leg (a same-asset-as-
 *      collateral top-up borrowed alongside the paired-asset borrow — see
 *      executeOneClickStrategy's LP branch). The old closePosition only
 *      repaid the paired-asset leg, leaving the top-up leg orphaned forever.
 */
const mocks = vi.hoisted(() => ({
  repayLoan: vi.fn(),
  getUserLpBalance: vi.fn(),
  aquariusRemoveLiquidity: vi.fn(),
  getLpBalance: vi.fn(),
  soroswapRemoveLiquidity: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: {
    repayLoan: mocks.repayLoan,
    depositCollateralTokens: vi.fn(),
    borrowTokens: vi.fn(),
  },
}));
vi.mock("@/lib/blend-utils", () => ({
  BlendService: { depositToBlendPool: vi.fn(), withdrawFromBlendPool: vi.fn() },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    swapFromMargin: vi.fn(),
    addLiquidity: vi.fn(),
    removeLiquidity: mocks.soroswapRemoveLiquidity,
    getLpBalance: mocks.getLpBalance,
    getPoolStats: vi.fn(),
  },
}));
vi.mock("@/lib/aquarius-utils", () => ({
  AquariusService: {
    getUserLpBalance: mocks.getUserLpBalance,
    addLiquidity: vi.fn(),
    removeLiquidity: mocks.aquariusRemoveLiquidity,
    getAquariusPoolStats: vi.fn(),
    aquariusSwapFromMargin: vi.fn(),
  },
}));

import { closePosition } from "@/lib/one-click-strategy";

const baseParams = {
  userAddress: "GUSER",
  marginAccountAddress: "CACCT",
  collateralAsset: "XLM" as const,
  collateralAmount: 20,        // raw deposit
  collateralBorrowAmount: 20,  // same-asset top-up leg (2x leverage)
  borrowAsset: "USDC" as const,
  borrowAmount: 0.53,          // paired leg
  poolProtocol: "Aquarius",
  poolType: "lp" as const,
  poolTokens: ["XLM", "USDC"],
  isSameAsset: false,
};

describe("closePosition — leveraged Aquarius LP exit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repayLoan.mockResolvedValue({ success: true, hash: "repay-hash" });
    mocks.aquariusRemoveLiquidity.mockResolvedValue({ success: true, hash: "remove-hash" });
    // Real on-chain LP balance — deliberately NOT equal to borrowAmount (0.53),
    // proving the fix reads the real balance rather than reusing that number.
    mocks.getUserLpBalance.mockResolvedValue("6.8712");
  });

  it("removes the REAL LP balance (not borrowAmount) and repays BOTH debt legs on a full exit", async () => {
    const res = await closePosition({ ...baseParams, exitPct: 100 });

    expect(res.success).toBe(true);
    expect(mocks.getUserLpBalance).toHaveBeenCalledWith("CACCT", expect.any(String), "XLM", "USDC");

    // Removed the full real LP balance, not 0.53.
    const removeCall = mocks.aquariusRemoveLiquidity.mock.calls[0];
    expect(removeCall[4]).toBeCloseTo(6.8712, 4);

    // Both debt legs repaid: the collateral-asset top-up AND the paired asset.
    expect(mocks.repayLoan).toHaveBeenCalledTimes(2);
    const xlmRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "XLM");
    const usdcRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "USDC");
    expect(xlmRepay).toBeTruthy();
    expect(usdcRepay).toBeTruthy();
    expect(Number(BigInt(xlmRepay![2])) / 1e18).toBeCloseTo(20, 4);
    expect(Number(BigInt(usdcRepay![2])) / 1e18).toBeCloseTo(0.53, 4);
  });

  it("scales the LP removal and BOTH repay legs by exitPct on a partial exit", async () => {
    await closePosition({ ...baseParams, exitPct: 50 });

    const removeCall = mocks.aquariusRemoveLiquidity.mock.calls[0];
    expect(removeCall[4]).toBeCloseTo(6.8712 * 0.5, 4);

    const xlmRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "XLM");
    const usdcRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "USDC");
    expect(Number(BigInt(xlmRepay![2])) / 1e18).toBeCloseTo(10, 4);
    expect(Number(BigInt(usdcRepay![2])) / 1e18).toBeCloseTo(0.265, 4);
  });

  it("skips the second repay leg entirely for a non-leveraged (1x) LP position", async () => {
    await closePosition({ ...baseParams, collateralBorrowAmount: 0, exitPct: 100 });

    expect(mocks.repayLoan).toHaveBeenCalledTimes(1);
    expect(mocks.repayLoan.mock.calls[0][1]).toBe("USDC");
  });

  it("fails loudly instead of removing nothing when the real LP balance can't be read", async () => {
    mocks.getUserLpBalance.mockResolvedValue("0");

    const res = await closePosition({ ...baseParams, exitPct: 100 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/LP balance/i);
    expect(mocks.aquariusRemoveLiquidity).not.toHaveBeenCalled();
    expect(mocks.repayLoan).not.toHaveBeenCalled();
  });

  it("routes a Soroswap LP position through SoroswapService, not Aquarius", async () => {
    mocks.getLpBalance.mockResolvedValue("4.0");
    mocks.soroswapRemoveLiquidity.mockResolvedValue({ success: true, hash: "sw-remove" });

    const res = await closePosition({ ...baseParams, poolProtocol: "Soroswap", exitPct: 100 });

    expect(res.success).toBe(true);
    expect(mocks.getLpBalance).toHaveBeenCalledWith("CACCT");
    expect(mocks.aquariusRemoveLiquidity).not.toHaveBeenCalled();
    expect(mocks.soroswapRemoveLiquidity).toHaveBeenCalled();
  });
});
