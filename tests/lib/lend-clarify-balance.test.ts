/**
 * "Supply Liquidity in XLM Lending Pool" asked how much XLM the user WANTS to
 * supply, with no figure to decide against — the real Earn page shows "Bal:
 * 3134.68 XLM" right next to the same input for exactly this reason (reported
 * live, issue #4). The clarify now includes the wallet's own balance for the
 * named asset, best-effort — a failed balance read still falls through to the
 * plain question rather than blocking the clarify.
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

describe("the amount-less lend/supply clarify shows the wallet's own balance", () => {
  it("includes the wallet's XLM balance so the user can decide against it", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({ ...base, message: "supply liquidity in XLM lending pool" });
      expect(res.kind).toBe("clarification");
      expect(res.message).toMatch(/you have 3,?134\.68 xlm in your wallet/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });

  it("omits the balance note (not blocks the clarify) for a zero wallet balance", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({ ...base, message: "supply BLUSDC to earn" });
      expect(res.kind).toBe("clarification");
      expect(res.message).not.toMatch(/you have/i);
      expect(res.message).toMatch(/how much (blusdc|usdc) do you want to supply/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});
