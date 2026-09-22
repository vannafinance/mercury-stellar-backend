/**
 * Reported live: "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC" correctly
 * paused on the swap leg (BLUSDC can't be swapped into) with the real refusal message.
 * But answering it — sending back `resume_multi_leg` with the swap leg's `token_out`
 * corrected to SOUSDC — silently replayed the ORIGINAL (blocked) BLUSDC destination,
 * because the `resume_multi_leg` handler only ever carried `op`/`asset`/`amount`/
 * `leverage` through, dropping `token_in`/`token_out` entirely. A swap resumed with a
 * corrected destination must actually USE that correction, not the one it paused on.
 */
import { describe, expect, it, vi } from "vitest";
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return {
    ...actual,
    computeMarginSnapshot: vi.fn().mockResolvedValue({
      collateralBalances: {},
      borrowedBalances: {},
      totalBorrowedValue: 0,
      grossCollateralValue: 0,
      totalValue: 0,
      avgHealthFactor: 0,
      collateralLeftBeforeLiquidation: 0,
      netAvailableCollateral: 0,
    }),
  };
});

vi.mock("@/lib/copilot/llm-planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/llm-planner")>();
  return { ...actual, shouldLlmPlan: () => false, llmPlanStrategy: async () => null };
});

vi.mock("@/lib/copilot/lp-pair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/lp-pair")>();
  return { ...actual, readAmmOtherPerXlm: vi.fn().mockResolvedValue(0.12) };
});

vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vi.fn().mockResolvedValue(null) };
});

vi.mock("@/lib/copilot/swap-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/swap-quote")>();
  return {
    ...actual,
    quoteDexSwap: vi.fn().mockResolvedValue({ expected: 2.6, rate: 0.26 }),
  };
});

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
};

describe("resuming a paused swap leg uses the CORRECTED destination, not the original", () => {
  it("carries token_out through resume_multi_leg", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        message: "SOUSDC",
        resume_multi_leg: {
          summary: "Swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC",
          legs: [
            {
              op: "swap",
              asset: "XLM",
              amount: 10,
              token_in: "XLM",
              token_out: "SOUSDC",
              label: "Swap 10 XLM → SOUSDC",
            },
          ],
        },
      });
      // The resumed swap must execute (or stage) against SOUSDC — never fall through to
      // the generic "I can help with..." blurb, and never silently swap to BLUSDC again.
      expect(res.intent?.template_id).not.toBe("clarify_capabilities");
      const stepsText = JSON.stringify(res.execution?.steps ?? res.data ?? {});
      expect(stepsText).toMatch(/SOUSDC/);
      expect(stepsText).not.toMatch(/BLUSDC/);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 15000);
});
