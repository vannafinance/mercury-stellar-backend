import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for closing a leveraged Aquarius/Soroswap LP position.
 *
 * Bugs fixed here:
 *   1. The old `approxLpAmt = borrowAmount * pct` heuristic used the
 *      borrowed-USDC amount as if it were an LP share count — a different
 *      unit entirely — so it removed the wrong fraction of the real
 *      position. Must instead read the REAL on-chain LP balance (same as
 *      the Farm page's own Remove Liquidity) and scale THAT by exitPct.
 *   2. A leveraged LP position carries a SECOND debt leg (a same-asset-as-
 *      collateral top-up borrowed alongside the paired-asset borrow — see
 *      executeOneClickStrategy's LP branch). The old closePosition only
 *      repaid the paired-asset leg, leaving the top-up leg orphaned forever.
 *   3. The repay calls passed the generic `borrowAsset` ("USDC") straight to
 *      repayLoan — but an Aquarius/Soroswap LP's real on-chain debt is
 *      denominated in AQUSDC/SOUSDC (whatever the borrow itself used, via
 *      poolTokenSymbol()). Repaying plain "USDC" targets Blend's USDC debt
 *      instead — the wrong debt entirely.
 *   4. Repay amounts weren't capped at what's actually spendable in the
 *      margin account, unlike the Pro-mode Repay tab — risking
 *      Error(Contract,#10) "balance is not sufficient to spend" instead of a
 *      partial, successful repay.
 */
const mocks = vi.hoisted(() => ({
  repayLoan: vi.fn(),
  getUserLpBalance: vi.fn(),
  getMarginAccountTokenBalanceWad: vi.fn(),
  aquariusRemoveLiquidity: vi.fn(),
  getLpBalance: vi.fn(),
  soroswapRemoveLiquidity: vi.fn(),
}));

vi.mock("@/lib/margin-utils", () => ({
  MarginAccountService: {
    repayLoan: mocks.repayLoan,
    depositCollateralTokens: vi.fn(),
    borrowTokens: vi.fn(),
    getMarginAccountTokenBalanceWad: mocks.getMarginAccountTokenBalanceWad,
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

const toWad = (n: number) => (BigInt(Math.floor(n * 1_000_000)) * BigInt(1_000_000_000_000)).toString();

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
    // Plenty spendable for both legs by default — tests that want the cap to
    // bite override this per-call.
    mocks.getMarginAccountTokenBalanceWad.mockResolvedValue(toWad(1_000_000));
  });

  it("removes the REAL LP balance (not borrowAmount) and repays BOTH debt legs, in the correct on-chain symbols", async () => {
    const res = await closePosition({ ...baseParams, exitPct: 100 });

    expect(res.success).toBe(true);
    expect(mocks.getUserLpBalance).toHaveBeenCalledWith("CACCT", expect.any(String), "XLM", "USDC");

    // Removed the full real LP balance, not 0.53.
    const removeCall = mocks.aquariusRemoveLiquidity.mock.calls[0];
    expect(removeCall[4]).toBeCloseTo(6.8712, 4);

    // Both debt legs repaid — and the paired leg uses AQUSDC (Aquarius's own
    // USDC), NOT generic "USDC" (which would hit Blend's debt instead).
    expect(mocks.repayLoan).toHaveBeenCalledTimes(2);
    const xlmRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "XLM");
    const aqUsdcRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "AQUSDC");
    expect(xlmRepay).toBeTruthy();
    expect(aqUsdcRepay).toBeTruthy();
    expect(mocks.repayLoan.mock.calls.some((c) => c[1] === "USDC")).toBe(false);
    expect(Number(BigInt(xlmRepay![2])) / 1e18).toBeCloseTo(20, 4);
    expect(Number(BigInt(aqUsdcRepay![2])) / 1e18).toBeCloseTo(0.53, 4);
  });

  it("scales the LP removal and BOTH repay legs by exitPct on a partial exit", async () => {
    await closePosition({ ...baseParams, exitPct: 50 });

    const removeCall = mocks.aquariusRemoveLiquidity.mock.calls[0];
    expect(removeCall[4]).toBeCloseTo(6.8712 * 0.5, 4);

    const xlmRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "XLM");
    const aqUsdcRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "AQUSDC");
    expect(Number(BigInt(xlmRepay![2])) / 1e18).toBeCloseTo(10, 4);
    expect(Number(BigInt(aqUsdcRepay![2])) / 1e18).toBeCloseTo(0.265, 4);
  });

  it("skips the second repay leg entirely for a non-leveraged (1x) LP position", async () => {
    await closePosition({ ...baseParams, collateralBorrowAmount: 0, exitPct: 100 });

    expect(mocks.repayLoan).toHaveBeenCalledTimes(1);
    expect(mocks.repayLoan.mock.calls[0][1]).toBe("AQUSDC");
  });

  it("caps each repay leg at what's actually spendable in the margin account", async () => {
    // Only 0.1 AQUSDC and 5 XLM are really sitting in the account — far less
    // than the stored debt figures (0.53 AQUSDC, 20 XLM top-up).
    mocks.getMarginAccountTokenBalanceWad.mockImplementation((_addr: string, symbol: string) => {
      if (symbol === "AQUSDC") return Promise.resolve(toWad(0.1));
      if (symbol === "XLM") return Promise.resolve(toWad(5));
      return Promise.resolve(toWad(1_000_000));
    });

    const res = await closePosition({ ...baseParams, exitPct: 100 });

    expect(res.success).toBe(true);
    const xlmRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "XLM");
    const aqUsdcRepay = mocks.repayLoan.mock.calls.find((c) => c[1] === "AQUSDC");
    // Capped to the spendable balance, not the (larger) stored debt amount.
    expect(Number(BigInt(xlmRepay![2])) / 1e18).toBeCloseTo(5, 4);
    expect(Number(BigInt(aqUsdcRepay![2])) / 1e18).toBeCloseTo(0.1, 4);
  });

  it("fails loudly instead of removing nothing when the real LP balance can't be read", async () => {
    mocks.getUserLpBalance.mockResolvedValue("0");

    const res = await closePosition({ ...baseParams, exitPct: 100 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/LP balance/i);
    expect(mocks.aquariusRemoveLiquidity).not.toHaveBeenCalled();
    expect(mocks.repayLoan).not.toHaveBeenCalled();
  });

  it("routes a Soroswap LP position through SoroswapService and repays SOUSDC, not Aquarius/generic USDC", async () => {
    mocks.getLpBalance.mockResolvedValue("4.0");
    mocks.soroswapRemoveLiquidity.mockResolvedValue({ success: true, hash: "sw-remove" });

    const res = await closePosition({ ...baseParams, poolProtocol: "Soroswap", exitPct: 100 });

    expect(res.success).toBe(true);
    expect(mocks.getLpBalance).toHaveBeenCalledWith("CACCT");
    expect(mocks.aquariusRemoveLiquidity).not.toHaveBeenCalled();
    expect(mocks.soroswapRemoveLiquidity).toHaveBeenCalled();
    expect(mocks.repayLoan.mock.calls.some((c) => c[1] === "SOUSDC")).toBe(true);
    expect(mocks.repayLoan.mock.calls.some((c) => c[1] === "USDC" || c[1] === "AQUSDC")).toBe(false);
  });
});
