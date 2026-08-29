/**
 * `query_all_positions` must preserve Earn positions alongside Margin/Farm data.
 * Earn is a separate pool: a token can be supplied to Earn while another amount of
 * the same token is margin collateral or an LP input.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return {
    ...actual,
    computeMarginSnapshot: vi.fn().mockResolvedValue({
      collateralBalances: {
        XLM: { amount: "100", usdValue: "10.00" },
        BLEND_XLM: { amount: "2", usdValue: "2.00" },
      },
      borrowedBalances: { BLUSDC: { amount: "5", usdValue: "5.00" } },
      totalBorrowedValue: 5,
      grossCollateralValue: 10,
      totalCollateralValue: 10,
      totalValue: 10,
      avgHealthFactor: 2,
      collateralLeftBeforeLiquidation: 4.5,
      netAvailableCollateral: 5,
      borrowRate: 3.2,
      debtLimit: 9,
    }),
  };
});

import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNY5QUPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

describe("query_all_positions includes Earn supply", () => {
  it("renders Margin and Earn facts as separate sections", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const response = await handleChat({ ...base, message: "what are all my positions" });

      expect(response.kind).toBe("answer");
      expect(response.intent?.template_id).toBe("query_all_positions");
      expect(response.answer?.facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "collateral", value: "$10.00" }),
          expect.objectContaining({ label: "earn · XLM", group: "earn" }),
          expect.objectContaining({ label: "earn · AQUSDC", group: "earn" }),
        ]),
      );
      expect(response.intent?.slots?.farm).toBe(true);
      expect(response.message).not.toMatch(/Farm venues could not be read/i);
      expect(response.message).toMatch(/earn · XLM/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});