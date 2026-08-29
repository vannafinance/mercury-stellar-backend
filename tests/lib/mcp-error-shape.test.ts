import { describe, expect, it } from "vitest";
import { MCPAuthError, MCPCallError } from "@/lib/copilot/mcp-client";

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