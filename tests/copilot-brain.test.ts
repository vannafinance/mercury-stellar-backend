import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutedIntent } from "@/lib/copilot/types";

const selectTool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/copilot/vertex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/copilot/vertex")>()),
  vertexSelectTool: selectTool,
  vertexExplain: vi.fn().mockRejectedValue(new Error("Provider unavailable in offline test")),
  vertexExplainStructured: vi.fn().mockResolvedValue(null),
}));

beforeAll(async () => {
  // Set the transport before loading the brain. No .env.local, credentials, or
  // external service is necessary to assert the handler's strict outcomes.
  vi.stubEnv("MCP_MODE", "mock");
  await import("@/lib/copilot");
}, 120_000);
beforeEach(() => selectTool.mockReset());
afterAll(() => vi.unstubAllEnvs());

describe("in-process copilot brain", () => {
  it("reports healthy in-process status with the selected transport", async () => {
    const { getBrainHealth } = await import("@/lib/copilot");
    expect(getBrainHealth()).toMatchObject({ status: "ok", in_process: true, llm_provider: "vertex", mcp_mode: "mock" });
  });

  it("answers a routed price read with MCP data without provider credentials", async () => {
    selectTool.mockResolvedValue({ kind: "read", tool: "vanna_get_price", args: { symbol: "XLM" }, template_id: "query_price" } satisfies RoutedIntent);
    const { handleChat } = await import("@/lib/copilot");
    const response = await handleChat({ user_id: "guest", message: "price of XLM" });
    expect(response.kind).toBe("answer");
    expect(response.message).toMatch(/XLM/i);
    expect(response.message).toContain("0.11");
    expect(response.answer ?? response.data).toBeTruthy();
    expect(response.request_id).toBeTruthy();
  });

  it("blocks a restricted model intent without calling a signing tool", async () => {
    selectTool.mockResolvedValue({ kind: "restricted", reason: "Liquidation is not available through this assistant.", template_id: "restricted_liquidation" } satisfies RoutedIntent);
    const { handleChat } = await import("@/lib/copilot");
    const { getMcpClient } = await import("@/lib/copilot/mcp-client");
    const call = vi.spyOn(getMcpClient(), "call");
    const response = await handleChat({ user_id: "guest", message: "liquidate GC6VYQ..." });
    expect(response.kind).toBe("blocked");
    expect(response.intent?.template_id).toBe("restricted_liquidation");
    expect(response.unsigned_xdr).toBeFalsy();
    expect(response.execution).toBeFalsy();
    expect(call).not.toHaveBeenCalled();
    call.mockRestore();
  });
});
