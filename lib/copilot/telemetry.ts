/**
 * Copilot traces. OTel GenAI + MCP semantic conventions (development status,
 * semantic-conventions-genai, Sep 2026). Export is OTLP/HTTP from
 * instrumentation.node.ts when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Never put prompts, tool payloads, XDR, tokens, or addresses on spans. Langfuse
 * will store whatever we export; traces contain enough to identify an account
 * if we leak those fields.
 */
import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

const TRACER = "vanna-copilot";

/** Attribute names from the GenAI / MCP specs — not guessed. */
export const ATTR = {
  OPERATION: "gen_ai.operation.name",
  PROVIDER: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  OUTPUT_TYPE: "gen_ai.output.type",
  REASONING: "gen_ai.request.reasoning.level",
  MAX_TOKENS: "gen_ai.request.max_tokens",
  STREAM: "gen_ai.request.stream",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  CACHE_READ: "gen_ai.usage.cache_read.input_tokens",
  REASONING_TOKENS: "gen_ai.usage.reasoning.output_tokens",
  AGENT_NAME: "gen_ai.agent.name",
  PROMPT_NAME: "gen_ai.prompt.name",
  TOOL_NAME: "gen_ai.tool.name",
  MCP_METHOD: "mcp.method.name",
  MCP_PROTOCOL: "mcp.protocol.version",
} as const;

/** Opt-in payload fields we must never set. */
export const FORBIDDEN_SPAN_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.definitions",
] as const;

const SENSITIVE_KEY =
  /^(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|secret|client[_-]?secret|password|assertion|x-vanna-user-assertion|(?:un)?signed[_-]?xdr|session[_-]?id)$/i;

export function isForbiddenSpanKey(key: string): boolean {
  return (FORBIDDEN_SPAN_KEYS as readonly string[]).includes(key) || SENSITIVE_KEY.test(key);
}

/** Safe attributes only — never prompts, payloads, addresses, or tokens. */
export function setSpanAttr(key: string, value: string | number | boolean): void {
  if (isForbiddenSpanKey(key)) return;
  trace.getActiveSpan()?.setAttribute(key, value);
}

function tracer() {
  return trace.getTracer(TRACER, "0.1.0");
}

export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, options, context.active());
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message.slice(0, 200) : "error",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function withInvestigationRun<T>(
  promptName: string | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(
    "invoke_agent investigation",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR.OPERATION]: "invoke_agent",
        [ATTR.PROVIDER]: "gcp.vertex_ai",
        [ATTR.AGENT_NAME]: "investigation",
        ...(promptName ? { [ATTR.PROMPT_NAME]: promptName } : {}),
      },
    },
    fn,
  );
}

export async function withInvestigationPhase<T>(
  phase: "scope" | "position" | "loop",
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(`investigation.${phase}`, { kind: SpanKind.INTERNAL, attributes: { "vanna.investigation.phase": phase } }, fn);
}

export async function withInvestigationTurn<T>(
  turn: number,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(
    "investigation.turn",
    { kind: SpanKind.INTERNAL, attributes: { "vanna.investigation.turn": turn } },
    fn,
  );
}

export async function withModelCall<T>(
  model: string,
  extras: { outputType?: "json" | "text"; reasoningLevel?: string; maxTokens?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `generate_content ${model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR.OPERATION]: "generate_content",
        [ATTR.PROVIDER]: "gcp.vertex_ai",
        [ATTR.REQUEST_MODEL]: model,
        [ATTR.STREAM]: false,
        ...(extras.outputType ? { [ATTR.OUTPUT_TYPE]: extras.outputType } : {}),
        ...(extras.reasoningLevel ? { [ATTR.REASONING]: extras.reasoningLevel } : {}),
        ...(typeof extras.maxTokens === "number" ? { [ATTR.MAX_TOKENS]: extras.maxTokens } : {}),
      },
    },
    fn,
  );
}

export async function withMcpCall<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    `tools/call ${tool}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR.MCP_METHOD]: "tools/call",
        [ATTR.TOOL_NAME]: tool,
        [ATTR.OPERATION]: "execute_tool",
        [ATTR.MCP_PROTOCOL]: "2025-06-18",
      },
    },
    fn,
  );
}

export function recordVertexUsage(parsed: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const envelope = parsed as {
    usageMetadata?: Record<string, unknown>;
    candidates?: Array<{ finishReason?: string }>;
  } | null;
  const meta = envelope?.usageMetadata;
  if (!meta) return;
  const int = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const input = int(meta.promptTokenCount);
  const thoughts = int(meta.thoughtsTokenCount);
  const output = int(meta.candidatesTokenCount) + thoughts;
  const cached =
    int(meta.cachedContentTokenCount) ||
    int(meta.cachedTokenCount) ||
    int(meta.totalCachedTokens) ||
    int((meta.promptTokensDetails as Record<string, unknown> | undefined)?.cachedTokenCount);
  if (input > 0) span.setAttribute(ATTR.INPUT_TOKENS, input);
  if (output > 0) span.setAttribute(ATTR.OUTPUT_TOKENS, output);
  if (cached > 0) span.setAttribute(ATTR.CACHE_READ, cached);
  if (thoughts > 0) span.setAttribute(ATTR.REASONING_TOKENS, thoughts);
  const finish = envelope?.candidates?.[0]?.finishReason;
  if (typeof finish === "string" && finish) span.setAttribute(ATTR.FINISH_REASONS, [finish]);
}
