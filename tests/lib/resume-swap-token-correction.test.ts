/**
 * Reported live: "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC" correctly
 * paused on the swap leg (BLUSDC can't be swapped into) with the real refusal message.
 * But answering it — sending back `resume_multi_leg` with the swap leg's `token_out`
 * corrected to SOUSDC — silently replayed the ORIGINAL (blocked) BLUSDC destination,
 * because the `resume_multi_leg` handler only ever carried `op`/`asset`/`amount`/
 * `leverage` through, dropping `token_in`/`token_out` entirely. A swap resumed with a
 * corrected destination must actually USE that correction, not the one it paused on.
 */
import { describe, expect, it } from "vitest";
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
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
  });
});
