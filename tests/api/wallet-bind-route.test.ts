import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMcpClient: vi.fn(),
  loadUserFromRequest: vi.fn(),
  resolveConnectOrigin: vi.fn(),
}));

vi.mock("@/lib/copilot/mcp-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/mcp-client")>();
  return { ...actual, getMcpClient: mocks.getMcpClient };
});

vi.mock("@/lib/copilot/request-user", () => ({
  loadUserFromRequest: mocks.loadUserFromRequest,
}));

vi.mock("@/lib/copilot/wallet-bind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/wallet-bind")>();
  return { ...actual, resolveConnectOrigin: mocks.resolveConnectOrigin };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/copilot/wallet-bind/route";

const SUBJECT = "did:privy:verified-subject";
const ORIGIN = "https://gateway.test";
const REQUEST_ID = "request-for-route-test";
const WALLET = "GBOUND";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/copilot/wallet-bind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /api/copilot/wallet-bind register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectOrigin.mockReturnValue(ORIGIN);
    mocks.loadUserFromRequest.mockResolvedValue({
      bound: { sub: SUBJECT, accessToken: "verified-assertion", kind: "privy" },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the verified-sub authentication refusal", async () => {
    mocks.loadUserFromRequest.mockResolvedValue({ bound: null });
    const mcpCall = vi.fn();
    mocks.getMcpClient.mockReturnValue({ call: mcpCall });

    const response = await POST(request({
      action: "register",
      request_id: REQUEST_ID,
      wallet_address: WALLET,
    }));

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      ok: false,
      status: "error",
      error: "not_authenticated",
      reason: "not_authenticated",
    });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("registers through MCP with the verified subject and does not fetch the gateway", async () => {
    const mcpCall = vi.fn(async () => ({
      status: "connected",
      identity_binding_written: true,
    }));
    mocks.getMcpClient.mockReturnValue({ call: mcpCall });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      action: "register",
      request_id: REQUEST_ID,
      wallet_address: WALLET,
    }));

    expect(mcpCall).toHaveBeenCalledWith(
      "vanna_connect_wallet_register",
      { request_id: REQUEST_ID, wallet_address: WALLET },
      SUBJECT,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await responseBody(response)).toEqual({
      ok: true,
      status: "ok",
      error: null,
      bound: true,
    });
  });

  it("uses the gateway only when MCP structurally reports the action absent", async () => {
    const mcpCall = vi.fn(async () => ({
      error: "invalid_input",
      code: "unknown_action",
      message: "legacy dispatcher response",
    }));
    mocks.getMcpClient.mockReturnValue({ call: mcpCall });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ status: "connected", identity_binding_written: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      action: "register",
      request_id: REQUEST_ID,
      wallet_address: WALLET,
    }));

    expect(mcpCall).toHaveBeenCalledWith(
      "vanna_connect_wallet_register",
      { request_id: REQUEST_ID, wallet_address: WALLET },
      SUBJECT,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORIGIN}/wallets/connect/register`);
    expect(await responseBody(response)).toMatchObject({
      ok: true,
      status: "ok",
      error: null,
      bound: true,
    });
  });

  it("does not fall back for a register refusal", async () => {
    const mcpCall = vi.fn(async () => ({ status: "error", error: "rate_limited" }));
    mocks.getMcpClient.mockReturnValue({ call: mcpCall });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      action: "register",
      request_id: REQUEST_ID,
      wallet_address: WALLET,
    }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await responseBody(response)).toEqual({
      ok: false,
      status: "error",
      error: "rate_limited",
      reason: "rate_limited",
      expired: false,
    });
  });
});
