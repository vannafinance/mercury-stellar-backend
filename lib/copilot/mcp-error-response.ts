import { MCPAuthError, MCPCallError, MCPError } from "./mcp-client";
import type { ChatResponse } from "./types";
import { VertexError } from "./vertex";
import { humanizeLegError } from "./multi-leg-agent";

/**
 * A serialized payload is a diagnostic, never user copy.
 *
 * `MCPCallError` carries the response body so the server log has it, and that whole
 * string was interpolated into the turn — a rate-limited Blend withdraw showed the user
 * `MCP call 'vanna_blend_withdraw' failed (429): {"error":"rate_limited",...}`. Dropping
 * a trailing JSON object here removes every such body at once, whatever tool produced it,
 * instead of each one being noticed and stripped after it ships.
 */
function withoutSerializedBody(raw: string): string {
  return raw.replace(/[:\s-]*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/, "").trim() || raw.trim();
}

function copilotErrorMessage(raw: string): string {
  const clean = withoutSerializedBody(raw);
  const human = humanizeLegError(clean);
  return human && human !== clean ? human : clean;
}

/**
 * What an HTTP status means for the person who asked, when the body says nothing they can
 * act on. Read off the status itself — the transport's own contract — so a tool that has
 * never been rate-limited before still gets the right sentence the first time it is.
 */
function transportMessage(status: number | null): string | null {
  if (status === 429) {
    return "Vanna's tools are rate-limiting requests right now, so this one was refused before it ran. Nothing was submitted — send it again in a moment.";
  }
  if (status === 408 || status === 504) {
    return "That request timed out before the tools answered. Nothing was submitted — try it again.";
  }
  if (status != null && status >= 500) {
    return "Vanna's tools are not responding right now. Nothing was submitted — try again in a moment.";
  }
  return null;
}

export function mcpErrorResponse(e: unknown, request_id: string, template_id?: string): ChatResponse {
  const code = e instanceof MCPError ? e.code : null;
  const diagnostic =
    code || (e instanceof MCPError && e.httpStatus != null)
      ? {
          mcp_error_code: code,
          http_status: e instanceof MCPError ? e.httpStatus : null,
          retryable: e instanceof MCPError ? e.retryable : false,
        }
      : undefined;
  if (e instanceof MCPAuthError) {
    const authMessage =
      code === "invalid_user_assertion"
        ? "MCP could not verify your user session. Sign in again, then retry."
        : code === "missing_user_assertion"
          ? "This write needs an authenticated user session. Sign in, then retry."
          : "MCP authentication failed. Check the current wallet session and try again.";
    return {
      kind: "error",
      message: `${authMessage}${code ? ` Code: ${code}.` : ""}`,
      data: diagnostic,
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  if (e instanceof MCPCallError || e instanceof MCPError) {
    // A transport refusal (rate limit, timeout, server fault) never reached the tool, so
    // the status is the whole story and the body is for the log.
    const transport = transportMessage(e.httpStatus ?? null);
    if (transport) {
      return {
        kind: "error",
        message: transport,
        data: diagnostic,
        intent: { template_id: template_id ?? null },
        request_id,
      };
    }
    const codeMessage =
      code === "wallet_not_bound"
        ? "Authorize Vanna as an additional signer for this wallet, then retry."
        : code === "over_per_tx_cap" || code === "over_per_day_cap"
          ? "The configured auto-sign spend cap rejected this request. Reduce the amount or change the cap."
          : code === "simulation_failed" || code === "budget_exceeded"
            ? "MCP could not simulate this transaction. Check the amount and account state, then retry."
            : null;
    return {
      kind: "error",
      message: `${codeMessage ?? copilotErrorMessage(`MCP error: ${e.message}`)}${code ? ` Code: ${code}.` : ""}`,
      data: diagnostic,
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  if (e instanceof VertexError) {
    return {
      kind: "error",
      message: copilotErrorMessage(`Vertex error: ${e.message}`),
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  return {
    kind: "error",
    message: copilotErrorMessage(e instanceof Error ? e.message : "Copilot failed"),
    intent: { template_id: template_id ?? null },
    request_id,
  };
}
