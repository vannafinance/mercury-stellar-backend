import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the one-click deposit-only decoupling.
 *
 * A 1x position (borrowAmount = 0) must NOT route through any borrow-path
 * contract call — `deposit_and_borrow`, `deposit_borrow_and_deploy_blend`, or
 * `borrowTokens` all invoke the contract's internal `lend_to` even at 0 borrow,
 * so a plain deposit would otherwise inherit the borrow bug. It must use the
 * standalone `depositCollateralTokens` + pool deploy instead. Leverage > 1 still
 * uses the borrow path (unchanged).
 */
const mocks = vi.hoisted(() => ({
  depositCollateralTokens: vi.fn(),
  depositAndBorrow: vi.fn(),
  depositBorrowAndDeployBlendAtomic: vi.fn(),
  borrowTokens: vi.fn(),
  depositToBlendPool: vi.fn(),
  swapFromMargin: vi.fn(),
  addLiquidity: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: {
    depositCollateralTokens: mocks.depositCollateralTokens,
    depositAndBorrow: mocks.depositAndBorrow,
    depositBorrowAndDeployBlendAtomic: mocks.depositBorrowAndDeployBlendAtomic,
    borrowTokens: mocks.borrowTokens,
    repayLoan: vi.fn(),
  },
}));
vi.mock("@/lib/blend-utils", () => ({
  BlendService: { depositToBlendPool: mocks.depositToBlendPool },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    swapFromMargin: mocks.swapFromMargin,
    addLiquidity: mocks.addLiquidity,
    removeLiquidity: vi.fn(),
  },
}));

import { executeOneClickStrategy } from "@/lib/one-click-strategy";

const baseParams = {
  userAddress: "GUSER",
  marginAccountAddress: "CACCT",
  collateralAsset: "XLM" as const,
  borrowAsset: "XLM" as const,
  poolProtocol: "Blend",
  poolType: "single" as const,
  poolTokens: ["XLM"],
  scenario: "same-asset" as const,
};

describe("executeOneClickStrategy — deposit-only (1x) borrow-path decoupling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.depositCollateralTokens.mockResolvedValue({ success: true, hash: "deposit-hash" });
    mocks.depositToBlendPool.mockResolvedValue({ success: true, hash: "deploy-hash" });
    mocks.depositBorrowAndDeployBlendAtomic.mockResolvedValue({ success: true, hash: "atomic-hash" });
  });

  it("1x deposit uses depositCollateralTokens + depositToBlendPool, never the borrow path", async () => {
    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 100,
      borrowAmount: 0,
      leverage: 1,
    });

    expect(res.success).toBe(true);
    expect(mocks.depositCollateralTokens).toHaveBeenCalledTimes(1);
    expect(mocks.depositToBlendPool).toHaveBeenCalledTimes(1);

    // The whole point: no borrow-coupled contract call is reached.
    expect(mocks.depositAndBorrow).not.toHaveBeenCalled();
    expect(mocks.depositBorrowAndDeployBlendAtomic).not.toHaveBeenCalled();
    expect(mocks.borrowTokens).not.toHaveBeenCalled();
  });

  it("passes the deposit as WAD and the deploy as a human amount", async () => {
    await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 100,
      borrowAmount: 0,
      leverage: 1,
    });

    // depositCollateralTokens(marginAccount, asset, WAD-string)
    const [, asset, wad] = mocks.depositCollateralTokens.mock.calls[0];
    expect(asset).toBe("XLM");
    expect(wad).toBe("100000000000000000000"); // 100 * 1e18

    // depositToBlendPool(user, marginAccount, token, humanAmount)
    const deployArgs = mocks.depositToBlendPool.mock.calls[0];
    expect(deployArgs[3]).toBe(100); // human number, not WAD
  });

  it("surfaces a deploy failure without having borrowed", async () => {
    mocks.depositToBlendPool.mockResolvedValueOnce({ success: false, error: "pool full" });
    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 100,
      borrowAmount: 0,
      leverage: 1,
    });
    expect(res.success).toBe(false);
    expect(mocks.borrowTokens).not.toHaveBeenCalled();
    expect(mocks.depositAndBorrow).not.toHaveBeenCalled();
  });

  it("leverage > 1 (borrow > 0) still routes through the borrow path (unchanged)", async () => {
    const res = await executeOneClickStrategy({
      ...baseParams,
      collateralAmount: 100,
      borrowAmount: 50,
      leverage: 2,
    });

    expect(res.success).toBe(true);
    // same-asset Blend + borrow → atomic borrow-coupled path
    expect(mocks.depositBorrowAndDeployBlendAtomic).toHaveBeenCalledTimes(1);
    // and NOT the pure deposit-only path
    expect(mocks.depositCollateralTokens).not.toHaveBeenCalled();
  });
});
