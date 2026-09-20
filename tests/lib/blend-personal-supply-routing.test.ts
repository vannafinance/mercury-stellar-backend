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

describe("personal Blend supply routing", () => {
  it("routes the exact reported prompt to the user's XLM position", () => {
    const routed = routeMessage("What is my current XLM Blend supply?");
    expect(routed).toMatchObject({
      kind: "read",
      tool: "vanna_get_farm_overview",
      template_id: "query_farm_position",
      args: { venue: "blend", asset: "XLM" },
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
      tool: "vanna_get_farm_overview",
      template_id: "query_farm_position",
      args: { venue: "blend", asset: "XLM" },
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
