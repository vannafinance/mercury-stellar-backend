import { MCPAuthError, MCPCallError, MCPError } from "./mcp-client";
import type { ChatResponse } from "./types";
import { VertexError } from "./vertex";

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
      message: `${codeMessage ?? `MCP error: ${e.message}`}${code ? ` Code: ${code}.` : ""}`,
      data: diagnostic,
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  if (e instanceof VertexError) {
    return {
      kind: "error",
      message: `Vertex error: ${e.message}`,
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  return {
    kind: "error",
    message: e instanceof Error ? e.message : "Copilot failed",
    intent: { template_id: template_id ?? null },
    request_id,
  };
}
