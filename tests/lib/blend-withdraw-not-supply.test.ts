/**
 * Reported live, safety-critical — "Can You Remove 50 BLUSDC fom Farm's Blend Pool"
 * (typo "fom" for "from") staged "Supply 50 BLUSDC to Blend" instead of a withdrawal.
 * Root cause: the Blend-write matcher fires on venue signals alone ("blend pool" is a
 * literal substring, "farm's" contains "farm" as a whole word under the router's `any()`
 * boundary rule) with no check for which DIRECTION the money should move — every verb in
 * its allowlist (supply/deposit/deploy/farm/leverage) means "put money in", and nothing
 * excluded a removal verb. Had this been approved, real funds would have moved the wrong
 * way. Fixed by adding a `withdraw_from_blend` op, checked ahead of the supply route
 * whenever a removal verb (remove/withdraw/take out/pull out/unwind) is present.
 */
import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { mapOpToMcpStep } from "@/lib/copilot/mcp-write";
// The write pipeline's risk/simulation step reads the live margin snapshot regardless of
// MCP_MODE (a real Soroban RPC call, not routed through the mocked MCP client) — mocked
// here the same way other write-execution tests do, so this test never touches the
// network.
vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return {
    ...actual,
    computeMarginSnapshot: vi.fn().mockResolvedValue({
      collateralBalances: { XLM: { amount: "1000", usdValue: "110" } },
      borrowedBalances: {},
      totalBorrowedValue: 0,
      grossCollateralValue: 110,
      totalValue: 110,
      avgHealthFactor: 999,
      collateralLeftBeforeLiquidation: 110,
      netAvailableCollateral: 110,
    }),
  };
});
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

describe("a Blend removal verb never routes to the supply op", () => {
  const removalPhrasings = [
    "Can You Remove 50 BLUSDC fom Farm's Blend Pool",
    "withdraw 20 XLM from Blend",
    "take out 10 BLUSDC from my Blend pool",
    "unwind 5 XLM from Blend",
    "pull out 15 BLUSDC from Blend",
  ];

  for (const message of removalPhrasings) {
    it(`"${message}" routes to withdraw_from_blend, never deploy_to_blend`, () => {
      const r = routeMessage(message);
      expect(r.kind, message).toBe("write");
      if (r.kind !== "write") return;
      expect(r.op, message).toBe("withdraw_from_blend");
    });
  }

  it("a genuine supply is unaffected by the new carve-out", () => {
    const r = routeMessage("supply 50 BLUSDC to Blend");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("deploy_to_blend");
  });

  it("farm Blend at leverage (a supply, not a removal) is still unaffected", () => {
    const r = routeMessage("farm Blend at 2x with 10 BLUSDC");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("deploy_to_blend");
  });
});

describe("withdraw_from_blend builds a real MCP step, not a supply", () => {
  it("emits vanna_blend_withdraw with the withdrawn amount, not vanna_blend_supply", () => {
    const result = mapOpToMcpStep(
      "withdraw_from_blend",
      { asset: "BLUSDC", amount: 50 },
      { smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C", trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5" },
    );
    expect(result.blocker).toBeUndefined();
    if (!result.step) throw new Error("expected a step, got a blocker");
    expect(result.step.tool).toBe("vanna_blend_withdraw");
    expect(result.step.label).toMatch(/Withdraw 50 .*from Blend/i);
    expect(result.step.label).not.toMatch(/Supply/i);
  });

  it("refuses a non-Blend asset instead of guessing what to withdraw", () => {
    const result = mapOpToMcpStep(
      "withdraw_from_blend",
      { asset: "AQUSDC", amount: 10 },
      { smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C", trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5" },
    );
    expect("blocker" in result).toBe(true);
  });
});

/**
 * THE LIVE BUG, end-to-end. `routeMessage` alone was already correct — a SEPARATE,
 * independent regex inside `handleChat` (`blendWrite`, lib/copilot/handle.ts) re-derives
 * "is this a Blend write" from the raw message and unconditionally overrides `routed` to
 * `deploy_to_blend` whenever it fires, clobbering a correctly-routed withdrawal. Live-
 * reproduced: this exact sentence executed a REAL "Supply 50 BLUSDC to Blend" via
 * `vanna_blend_supply` (auto-sign on) when the user asked to remove funds. Only a full
 * `handleChat` run exercises the overriding code, which the router-only tests above do
 * not reach.
 */
const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

describe("THE LIVE BUG: handleChat never overrides a Blend withdrawal back to a supply", () => {
  it("'Can You Remove 50 BLUSDC fom Farm's Blend Pool' never calls vanna_blend_supply", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        message: "Can You Remove 50 BLUSDC fom Farm's Blend Pool",
      });
      expect(res.intent?.template_id).not.toBe("deploy_to_blend");
      expect(res.mcp?.tool).not.toBe("vanna_blend_supply");
      expect(JSON.stringify(res)).not.toMatch(/vanna_blend_supply/);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 30_000);
});
