import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUserBlendBalance = vi.hoisted(() => vi.fn());

vi.mock("@/lib/blend-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blend-utils")>();
  return {
    ...actual,
    BlendService: {
      getUserBlendBalance,
    },
  };
});

vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return {
    ...actual,
    vertexSelectTool: vi.fn().mockRejectedValue(new Error("offline in test")),
  };
});

vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return {
    ...actual,
    computeMarginSnapshot: vi.fn().mockResolvedValue({
      collateralBalances: { XLM: { amount: "1000", usdValue: "180" } },
      borrowedBalances: {},
      totalBorrowedValue: 0,
      grossCollateralValue: 180,
      totalValue: 180,
      avgHealthFactor: 999,
      collateralLeftBeforeLiquidation: 180,
      netAvailableCollateral: 180,
    }),
  };
});

import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const request = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "paid" as const,
  surface: "copilot" as const,
  session_signing: false,
  message: "Remove my XLM position from Blend farm.",
};

describe("direct full-position Blend withdrawal", () => {
  beforeEach(() => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    getUserBlendBalance.mockReset();
  });

  afterEach(() => {
    delete process.env.MCP_MODE;
    resetMcpClient();
  });

  it("sizes the write from the live underlying XLM position", async () => {
    getUserBlendBalance.mockResolvedValue({
      bTokenBalance: "324.06",
      bRate: "2.075",
      underlyingBalance: "672.4341",
    });

    const response = await handleChat(request);

    expect(response.intent?.template_id).toBe("withdraw_from_blend");
    expect(response.mcp?.tool).toBe("vanna_blend_withdraw");
    expect(response.preview?.action).toMatchObject({
      op: "withdraw_from_blend",
      asset: "XLM",
      amount: 672.4341,
    });
  });

  it("distinguishes a confirmed zero balance from a failed read", async () => {
    getUserBlendBalance.mockResolvedValue({
      bTokenBalance: "0",
      bRate: "2.075",
      underlyingBalance: "0",
    });
    const zero = await handleChat(request);
    expect(zero.kind).toBe("blocked");
    expect(zero.message).toBe("You have no XLM supplied to Blend.");

    getUserBlendBalance.mockRejectedValue(new Error("RPC unavailable"));
    const unreadable = await handleChat(request);
    expect(unreadable.kind).toBe("blocked");
    expect(unreadable.message).toMatch(/couldn't read your live XLM Blend position/i);
    expect(unreadable.message).not.toMatch(/no XLM supplied/i);
  });
});
