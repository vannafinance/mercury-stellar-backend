import { describe, expect, it } from "vitest";
import { unwrapToolData } from "@/lib/copilot/mcp-client";

describe("unwrapToolData", () => {
  it("returns structuredContent when present", () => {
    expect(unwrapToolData({ structuredContent: { allowed: true, symbol: "XLM" } })).toEqual({
      allowed: true, symbol: "XLM",
    });
  });

  it("unwraps a JSON-RPC result envelope that hides allowed", () => {
    expect(unwrapToolData({ result: { allowed: true, symbol: "XLM", amount: "100" } })).toEqual({
      allowed: true, symbol: "XLM", amount: "100",
    });
  });

  it("parses JSON text content when structuredContent is missing", () => {
    expect(unwrapToolData({
      content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "hf" }) }],
    })).toEqual({ allowed: false, reason: "hf" });
  });

  it("unwraps a JSON string sitting under result", () => {
    expect(unwrapToolData({ result: JSON.stringify({ allowed: true, amount: "100" }) })).toEqual({
      allowed: true, amount: "100",
    });
  });

  it("leaves a financial object with allowed at the top level alone", () => {
    const live = { allowed: true, smart_account: "C", symbol: "XLM", amount: "100", reason: "ok" };
    expect(unwrapToolData(live)).toEqual(live);
  });
});
