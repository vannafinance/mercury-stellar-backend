import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWalletBind, rememberConnectOrigin } from "@/lib/copilot/wallet-bind";
import { MCPCallError } from "@/lib/copilot/mcp-client";

/**
 * A 200 from register is not a binding.
 *
 * `/wallets/connect/register` answers `{status:'ok', connected:true}` whether or not it
 * wrote the `identity_wallet_bindings` row. The app must retain that structured outcome
 * on the MCP path, and only use the gateway when the MCP action is absent.
 *
 * What is pinned here is that the OUTCOME is read from the response rather than inferred
 * from the status, including the case of a Sign Service too old to report it — which must
 * stay distinguishable from a reported failure, or a caller retrying on `false` would spin
 * forever against a deployment that simply cannot answer.
 */

const ORIGIN = "https://gateway.test";
const REQUEST_ID = "req-outcome";

function respondWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("registerWalletBind uses MCP and preserves the binding outcome", () => {
  it("reports a written binding", async () => {
    const mcp = {
      call: vi.fn(async () => ({
        status: "ok",
        connected: true,
        identity_binding_written: true,
      })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    expect(mcp.call).toHaveBeenCalledWith(
      "vanna_connect_wallet_register",
      { request_id: REQUEST_ID, wallet_address: "GBOUND" },
      "user-1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingWritten).toBe(true);
  });

  it("accepts connected as a successful MCP register status", async () => {
    const mcp = {
      call: vi.fn(async () => ({
        status: "connected",
        identity_binding_written: true,
      })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingWritten).toBe(true);
  });

  it("does not report success as a binding when the service says none was written", async () => {
    const mcp = {
      call: vi.fn(async () => ({
        status: "ok",
        connected: true,
        identity_binding_written: false,
        identity_binding_error: "binding_write_failed",
      })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    // The call succeeded — the binding did not. Collapsing these is the original defect.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingWritten).toBe(false);
      expect(result.bindingError).toBe("binding_write_failed");
    }
  });

  it("says 'unknown', not 'no', when the service does not report the field", async () => {
    const mcp = { call: vi.fn(async () => ({ status: "ok", connected: true })) };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    expect(result.ok).toBe(true);
    // null, never false: an absence of evidence is not evidence of failure.
    if (result.ok) expect(result.bindingWritten).toBeNull();
  });

  it("still surfaces a refusal as a refusal", async () => {
    const mcp = {
      call: vi.fn(async () => ({
        status: "error",
        error: "wallet_mismatch",
        message: "upstream details stay private",
      })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GOTHER",
      origin: ORIGIN,
    }, "user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("wallet_mismatch");
      expect(result.expired).toBe(false);
      expect(result.message).not.toContain("upstream details");
    }
  });

  it("uses the gateway only when the register action is structurally absent", async () => {
    rememberConnectOrigin(REQUEST_ID, `${ORIGIN}/connect`);
    const fetchMock = respondWith({ status: "ok", connected: true, identity_binding_written: true });
    const mcp = {
      call: vi.fn(async () => ({
        error: "invalid_input",
        code: "unknown_action",
        message: "old dispatcher has not registered this action",
      })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORIGIN}/wallets/connect/register`);
  });

  it("recognizes the legacy dispatcher shape without reading its message text", async () => {
    rememberConnectOrigin(REQUEST_ID, `${ORIGIN}/connect`);
    const fetchMock = respondWith({ status: "ok", connected: true });
    const mcp = {
      call: vi.fn(async () => ({ error: "invalid_input", message: "dispatcher response" })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back on a structural missing-tool error, but not on other MCP failures", async () => {
    rememberConnectOrigin(REQUEST_ID, `${ORIGIN}/connect`);
    const fetchMock = respondWith({ status: "ok", connected: true });
    const missing = {
      call: vi.fn(async () => {
        throw new MCPCallError("untrusted error detail", { code: "unknown_tool" });
      }),
    };
    const missingResult = await registerWalletBind(missing, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");
    expect(missingResult.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    const otherError = {
      call: vi.fn(async () => {
        throw new MCPCallError("upstream detail with credentials", { code: "rate_limited" });
      }),
    };
    const failure = await registerWalletBind(otherError, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");
    expect(failure.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    if (!failure.ok) expect(failure.message).not.toContain("credentials");
  });

  it("does not use the gateway for a register refusal or an invalid input result", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mcp = {
      call: vi.fn(async () => ({ status: "error", error: "invalid_input" })),
    };

    const result = await registerWalletBind(mcp, {
      requestId: REQUEST_ID,
      walletAddress: "GBOUND",
      origin: ORIGIN,
    }, "user-1");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
