/**
 * A plan whose first step is STATICALLY impossible (never depends on amount, balance,
 * or live chain state — e.g. swapping into BLUSDC, which trades on no AMM) should be
 * refused before it is ever shown as a multi-step "Approve & run" card, not after the
 * user approves it and it pauses one signature in.
 *
 * Reported live: "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC" showed
 * the full 4-step plan, the user approved it, and only then did leg 1 turn out to be
 * impossible. The fix must say so upfront instead.
 */
import { describe, expect, it, vi } from "vitest";
// A multi-goal plan isn't on handleChat's "keywordConfident" allowlist, so a real run
// also asks Vertex to independently confirm the route — a live network call this test
// environment can't make. Rejecting it exercises the documented keyword fallback.
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vi.fn().mockRejectedValue(new Error("no network in test")) };
});
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

describe("a plan with a statically impossible first step is refused upfront", () => {
  it("refuses 'swap to BLUSDC then farm Blend' before ever showing the plan preview", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        message: "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC",
      });
      expect(res.kind).toBe("blocked");
      expect(res.message).toMatch(/BLUSDC is Blend USDC/i);
      // Never a plan_preview / approve-plan card for a doomed first step.
      expect(res.intent?.template_id).not.toBe("plan_preview");
      expect(res.plan).toBeUndefined();
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });

  it("still shows a normal plan preview for a valid multi-leg strategy", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        message: "swap 10 XLM to AQUSDC then farm Blend at 2x with 10 BLUSDC",
      });
      expect(res.kind).toBe("plan_preview");
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});
