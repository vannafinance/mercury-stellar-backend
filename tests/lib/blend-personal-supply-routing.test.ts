import { describe, expect, it, vi } from "vitest";

const vertexSelectTool = vi.hoisted(() => vi.fn(async () => ({
  kind: "read" as const,
  tool: "vanna_get_blend_reserve_stats",
  args: { symbol: "XLM" },
  template_id: "query_blend",
})));

vi.mock("@/lib/copilot/vertex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/copilot/vertex")>()),
  vertexSelectTool,
}));

import { resolveUnnamedIntent } from "@/lib/copilot/unnamed-intent";
import { routeMessage } from "@/lib/copilot/router";

/**
 * One venue plus one asset is one position, and it has its own read.
 *
 * This used to assert the whole-farm overview. That answer is headlined with the Farm
 * page's Deposit TVL and lists every venue's holdings, so the reported prompt came back
 * "Your Blend Deposit TVL is $0.00" with a dust row under it — the right venue, the wrong
 * question. `vanna_get_blend_position` answers the reserve that was actually named.
 */
describe("personal Blend supply routing", () => {
  it("does not steal an instruction to remove the complete XLM position", () => {
    const routed = routeMessage("Remove my XLM position from Blend farm.");
    expect(routed).toMatchObject({
      kind: "write",
      op: "withdraw_from_blend",
      asset: "XLM",
      amount: null,
      fraction: 1,
      requires_amount: false,
    });
  });

  it("routes the exact reported prompt to the user's XLM position", () => {
    const routed = routeMessage("What is my current XLM Blend supply?");
    expect(routed).toMatchObject({
      kind: "read",
      tool: "vanna_get_blend_position",
      template_id: "query_blend_position",
      args: { symbol: "XLM" },
    });
  });

  it("corrects a model reserve-stat selection to the personal position", async () => {
    const result = await resolveUnnamedIntent({
      message: "What is my current XLM Blend supply?",
      smartAccount: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      trader: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      pageContext: null,
      request_id: "personal-blend-supply",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.routed).toMatchObject({
      kind: "read",
      tool: "vanna_get_blend_position",
      template_id: "query_blend_position",
      args: { symbol: "XLM" },
    });
  });

  it.each([
    "What is the Blend XLM supply APY?",
    "What is the current bXLM rate?",
    "Show Blend reserve statistics.",
  ])("keeps market data as reserve statistics: %s", (message) => {
    const routed = routeMessage(message);
    expect(routed.kind).toBe("read");
    if (routed.kind === "read") expect(routed.template_id).toBe("query_blend");
  });
});
