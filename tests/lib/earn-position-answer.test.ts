/**
 * Reported live: "Can you provide my Earn positions" answered with a card explicitly
 * badged "MARGIN ACCOUNT", showing the margin account's collateral/debt — a different
 * pool from Earn supply, even when the same token (e.g. XLM) sits in both at once. This
 * exercises the actual handler (`earnPositionsAnswer`, dispatched via `handleChat`), not
 * just the router's classification — the classification-only tests are in
 * supply-position-read.test.ts.
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

describe("'my Earn positions' answers with Earn's own numbers, not the margin account", () => {
  it("is never badged as the margin account", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({ ...base, message: "can you provide my earn positions" });
      expect(res.intent?.template_id).toBe("query_earn_position");
      expect(res.answer?.venue).toBe("earn");
      expect(res.answer?.venue).not.toBe("margin");
      // The reported failure mode named collateral/debt/MARGIN ACCOUNT — this answer
      // must never mention them at all.
      expect(res.message).not.toMatch(/margin account/i);
      expect(res.message).not.toMatch(/borrowed/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });

  it("reports every Earn asset with a non-zero supplied balance, not just one", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({ ...base, message: "what's my earn balance" });
      // The mock MCP client returns a fixed 50-unit vToken balance for every symbol
      // queried, so all 4 Earn assets should show up as supplied.
      const facts = (res.answer?.facts ?? []).map((f) => f.label);
      expect(facts).toContain("earn · XLM");
      expect(facts).toContain("earn · BLUSDC");
      expect(facts).toContain("earn · AQUSDC");
      expect(facts).toContain("earn · SOUSDC");
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});
