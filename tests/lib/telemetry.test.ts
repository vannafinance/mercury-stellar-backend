/**
 * Copilot traces: GenAI + MCP spans, no payloads. Uses an in-memory exporter so
 * CI does not need Langfuse. Production export is OTLP/HTTP from instrumentation.node.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  ATTR,
  FORBIDDEN_SPAN_KEYS,
  isForbiddenSpanKey,
  recordVertexUsage,
  setSpanAttr,
  withInvestigationRun,
  withInvestigationTurn,
  withMcpCall,
  withModelCall,
} from "@/lib/copilot/telemetry";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

afterEach(() => exporter.reset());

function ended() {
  return exporter.getFinishedSpans();
}

function allKeys() {
  return ended().flatMap((span) => Object.keys(span.attributes));
}

describe("copilot telemetry", () => {
  it("nests model and MCP spans under an investigation run with token usage", async () => {
    await withInvestigationRun("withdraw-100-xlm", async () => {
      await withInvestigationTurn(1, async () => {
        await withModelCall("gemini-3.7-flash", { outputType: "json", reasoningLevel: "MEDIUM" }, async () => {
          recordVertexUsage({
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 1200,
              candidatesTokenCount: 80,
              thoughtsTokenCount: 40,
              cachedContentTokenCount: 100,
            },
          });
          return { kind: "inspect" };
        });
        await withMcpCall("vanna_can_withdraw", async () => ({ allowed: true }));
      });
    });

    const spans = ended();
    const names = spans.map((span) => span.name);
    expect(names).toContain("invoke_agent investigation");
    expect(names).toContain("investigation.turn");
    expect(names).toContain("generate_content gemini-3.7-flash");
    expect(names).toContain("tools/call vanna_can_withdraw");

    const agent = spans.find((span) => span.name === "invoke_agent investigation");
    expect(agent?.attributes[ATTR.OPERATION]).toBe("invoke_agent");
    expect(agent?.attributes[ATTR.PROVIDER]).toBe("gcp.vertex_ai");
    expect(agent?.attributes[ATTR.AGENT_NAME]).toBe("investigation");
    expect(agent?.attributes[ATTR.PROMPT_NAME]).toBe("withdraw-100-xlm");

    const model = spans.find((span) => span.name.startsWith("generate_content"));
    expect(model?.attributes[ATTR.INPUT_TOKENS]).toBe(1200);
    expect(model?.attributes[ATTR.OUTPUT_TOKENS]).toBe(120);
    expect(model?.attributes[ATTR.CACHE_READ]).toBe(100);
    expect(model?.attributes[ATTR.REASONING_TOKENS]).toBe(40);
    expect(model?.attributes[ATTR.FINISH_REASONS]).toEqual(["STOP"]);
    expect(model?.attributes[ATTR.REASONING]).toBe("MEDIUM");

    const mcp = spans.find((span) => span.name.startsWith("tools/call"));
    expect(mcp?.attributes[ATTR.MCP_METHOD]).toBe("tools/call");
    expect(mcp?.attributes[ATTR.TOOL_NAME]).toBe("vanna_can_withdraw");
    expect(mcp?.attributes[ATTR.OPERATION]).toBe("execute_tool");

    const turn = spans.find((span) => span.name === "investigation.turn");
    expect(turn?.attributes["vanna.investigation.turn"]).toBe(1);
    expect(model?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
    expect(mcp?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
  });

  it("never records prompts, tool payloads, or secrets on spans", async () => {
    await withMcpCall("vanna_margin_trade", async () => ({
      unsigned_xdr: "AAAA...secret",
      access_token: "leak",
    }));
    const keys = allKeys();
    for (const forbidden of FORBIDDEN_SPAN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.some((key) => isForbiddenSpanKey(key))).toBe(false);
    const mcp = ended()[0];
    expect(JSON.stringify(mcp.attributes)).not.toMatch(/AAAA|leak|unsigned_xdr/);
  });

  it("marks failed MCP calls as errors without copying the argument object", async () => {
    await expect(withMcpCall("vanna_repay", async () => {
      throw new Error("session_user_mismatch");
    })).rejects.toThrow("session_user_mismatch");
    const span = ended()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(span.attributes)).not.toContain("gen_ai.tool.call.arguments");
  });

  it("refuses to set forbidden payload keys on the active span", async () => {
    await withInvestigationRun("withdraw-100-xlm", async () => {
      setSpanAttr("gen_ai.input.messages", "secret prompt");
      setSpanAttr("vanna.scope.cache", "hit");
    });
    const span = ended().find((item) => item.name.startsWith("invoke_agent"));
    expect(span?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(span?.attributes["vanna.scope.cache"]).toBe("hit");
  });
});
