import { describe, expect, it } from "vitest";
import { MCPAuthError, MCPCallError } from "@/lib/copilot/mcp-client";
import { mcpErrorResponse } from "@/lib/copilot/mcp-error-response";

describe("MCP errors preserve actionable structured metadata", () => {
  it("keeps the exact user assertion code on auth failures", () => {
    const error = new MCPAuthError("provider text", {
      code: "invalid_user_assertion",
      httpStatus: 401,
      retryable: true,
    });

    expect(error.code).toBe("invalid_user_assertion");
    expect(error.httpStatus).toBe(401);
    expect(error.retryable).toBe(true);
  });

  it("keeps policy codes separate from generic call failures", () => {
    const error = new MCPCallError("policy text", { code: "over_per_tx_cap" });

    expect(error.code).toBe("over_per_tx_cap");
    expect(error.name).toBe("MCPCallError");
    expect(error.retryable).toBe(false);
  });
});

describe("mcpErrorResponse does not leak transport noise", () => {
  it("humanizes Node fetch failed", () => {
    const response = mcpErrorResponse(new TypeError("fetch failed"), "req-1", "query_price");
    expect(response.kind).toBe("error");
    expect(response.message).not.toMatch(/fetch failed/i);
    expect(response.message).toMatch(/could not reach/i);
    expect(response.intent?.template_id).toBe("query_price");
  });

  it("humanizes MCP-wrapped connection resets", () => {
    const error = new MCPCallError("read ECONNRESET");
    const response = mcpErrorResponse(error, "req-2");
    expect(response.message).not.toMatch(/ECONNRESET/i);
    expect(response.message).toMatch(/could not reach/i);
  });
});
