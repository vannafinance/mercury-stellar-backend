import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const TRADER = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
const ACCOUNT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

beforeAll(() => {
  process.env.MCP_MODE = "mock";
  resetMcpClient();
});

afterAll(() => {
  delete process.env.MCP_MODE;
  resetMcpClient();
});

describe("Copilot plain actions use the direct capability path", () => {
  it.each([
    ["margin deposit", "deposit 101 XLM as collateral"],
    ["explicit multi-action", "deposit 100 XLM as collateral and borrow 20 XLM"],
    ["repay", "repay 12 XLM"],
    ["Earn lend", "lend 13 XLM"],
    ["Blend withdrawal", "withdraw 100 XLM from Blend"],
    ["liquidity", "add liquidity 15 XLM in Aquarius"],
    ["account read", "what is my health factor?"],
  ])("does not strategy-block %s", async (_name, message) => {
    const response = await handleChat({
      user_id: TRADER,
      tier: "paid",
      smart_account: ACCOUNT,
      surface: "copilot",
      session_signing: false,
      message,
    });

    expect(response.intent?.template_id).not.toBe("investigation_owns_planning");
    expect(response.kind).not.toBe("plan_preview");
  });

  it.each([
    "build me a strategy that keeps health factor above 1.3",
    "swap 14 XLM to AQUSDC",
  ])("keeps strategy/Swap on investigation: %s", async (message) => {
    const response = await handleChat({
      user_id: TRADER,
      tier: "paid",
      smart_account: ACCOUNT,
      surface: "copilot",
      message,
    });
    expect(response.intent?.template_id).toBe("investigation_owns_planning");
  });
});
