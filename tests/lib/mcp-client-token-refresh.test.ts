/**
 * The transport must always use the token bound to the CURRENT request.
 *
 * Live bug this pins: clients are cached by identity (`user:<sub>`), which is
 * stable across a token refresh, so a cached LiveMCPClient kept serving the
 * access token it was constructed with. Roughly 30 minutes after sign-in every
 * write failed with
 *
 *     MCP rejected the token (401): {"error":"unauthorized","detail":"Token has expired"}
 *
 * even though loadUserFromRequest had just refreshed the cookie. And because
 * BoundUserTokenSource.invalidate() has nothing to re-mint, the 401 was
 * permanent for that sub until the process restarted — which on serverless
 * means "until the instance happens to recycle".
 *
 * Drives the real getMcpClient() with a fake MCP so it exercises the actual
 * handshake + tools/call path, not a stubbed seam.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MCP_URL = "https://mcp.test.invalid/mcp";
const TOKEN_URL = "https://tenant.authkit.app/oauth2/token";

interface Recorded {
  url: string;
  authorization: string | null;
  method: string;
  sessionId: string | null;
  body: string;
}

let recorded: Recorded[] = [];
/** tools/call responses to serve, in order; a number means "fail with that status". */
let toolCallScript: Array<number | "ok"> = [];
let realFetch: typeof fetch;
let sessionCounter = 0;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function installFakeMcp() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit);
    const body = String(init?.body ?? "");

    recorded.push({
      url,
      authorization: headers.get("authorization"),
      method: init?.method ?? "GET",
      sessionId: headers.get("mcp-session-id"),
      body,
    });

    // WorkOS client_credentials (the M2M read path).
    if (url === TOKEN_URL) {
      return jsonResponse({ access_token: "m2m_token", expires_in: 300 });
    }

    if (url === MCP_URL) {
      const parsed = JSON.parse(body || "{}") as { method?: string };
      if (parsed.method === "initialize") {
        sessionCounter += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": `sess-${sessionCounter}`,
          },
        });
      }
      if (parsed.method === "notifications/initialized") {
        return jsonResponse({});
      }
      if (parsed.method === "tools/call") {
        const next = toolCallScript.shift() ?? "ok";
        if (typeof next === "number") {
          return new Response(
            JSON.stringify({ error: "unauthorized", detail: "Token has expired" }),
            { status: next, headers: { "content-type": "application/json" } },
          );
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { structuredContent: { ok: true } },
        });
      }
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

async function libs() {
  const mcp = await import("@/lib/copilot/mcp-client");
  const ctx = await import("@/lib/copilot/user-context");
  return { ...mcp, ...ctx };
}

const toolCalls = () =>
  recorded.filter((r) => r.url === MCP_URL && r.body.includes("tools/call"));
const initializes = () =>
  recorded.filter((r) => r.url === MCP_URL && r.body.includes('"initialize"'));

beforeEach(async () => {
  process.env.MCP_MODE = "live";
  process.env.MCP_BASE_URL = MCP_URL;
  process.env.WORKOS_M2M_CLIENT_ID = "client_m2m";
  process.env.WORKOS_M2M_CLIENT_SECRET = "secret";
  process.env.WORKOS_M2M_TOKEN_URL = TOKEN_URL;
  recorded = [];
  toolCallScript = [];
  sessionCounter = 0;
  installFakeMcp();
  const { resetMcpClient } = await libs();
  resetMcpClient();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const { resetMcpClient } = await libs();
  resetMcpClient();
});

describe("a refreshed access token is actually used", () => {
  it("THE BUG: second call for the same sub sends the NEWER bearer", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser({ sub: "user_1", accessToken: "tok_OLD" }, () =>
      client.call("vanna_lend", { amount: 1 }),
    );
    await withBoundUser({ sub: "user_1", accessToken: "tok_NEW" }, () =>
      client.call("vanna_lend", { amount: 2 }),
    );

    const calls = toolCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].authorization).toBe("Bearer tok_OLD");
    // Before the fix this was still "Bearer tok_OLD" — the cached client had
    // pinned the first TokenSource under key user:user_1.
    expect(calls[1].authorization).toBe("Bearer tok_NEW");
  });

  it("reuses the MCP session across a refresh (no needless re-handshake)", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser({ sub: "user_1", accessToken: "tok_OLD" }, () =>
      client.call("vanna_lend", {}),
    );
    await withBoundUser({ sub: "user_1", accessToken: "tok_NEW" }, () =>
      client.call("vanna_lend", {}),
    );

    expect(initializes()).toHaveLength(1);
    expect(toolCalls()[1].sessionId).toBe("sess-1");
  });

  it("an unchanged token does not disturb anything", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();
    for (let i = 0; i < 3; i++) {
      await withBoundUser({ sub: "user_1", accessToken: "tok_SAME" }, () =>
        client.call("vanna_lend", {}),
      );
    }
    expect(initializes()).toHaveLength(1);
    expect(toolCalls().every((c) => c.authorization === "Bearer tok_SAME")).toBe(true);
  });

  it("keeps separate sessions per user and never crosses bearers", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser({ sub: "user_a", accessToken: "tok_a" }, () =>
      client.call("vanna_lend", {}),
    );
    await withBoundUser({ sub: "user_b", accessToken: "tok_b" }, () =>
      client.call("vanna_lend", {}),
    );

    const calls = toolCalls();
    expect(calls[0].authorization).toBe("Bearer tok_a");
    expect(calls[1].authorization).toBe("Bearer tok_b");
    expect(calls[0].sessionId).not.toBe(calls[1].sessionId);
    expect(initializes()).toHaveLength(2);
  });
});

describe("401 recovery", () => {
  it("evicts the stale client and retries once with the current token", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    // Warm a client under the old token.
    await withBoundUser({ sub: "user_1", accessToken: "tok_OLD" }, () =>
      client.call("vanna_lend", {}),
    );

    // Next write: the server rejects the first attempt, the retry succeeds.
    toolCallScript = [401, "ok"];
    const out = await withBoundUser({ sub: "user_1", accessToken: "tok_NEW" }, () =>
      client.call("vanna_lend", {}),
    );

    expect(out).toEqual({ ok: true });
    const calls = toolCalls();
    expect(calls).toHaveLength(3); // warm-up, rejected attempt, successful retry
    expect(calls[2].authorization).toBe("Bearer tok_NEW");
    // Eviction means a brand-new handshake, not the session the 401 came from.
    expect(initializes()).toHaveLength(2);
    expect(calls[2].sessionId).toBe("sess-2");
  });

  it("retries only ONCE — a genuinely dead token surfaces as an error", async () => {
    const { getMcpClient, withBoundUser, MCPAuthError } = await libs();
    const client = getMcpClient();

    toolCallScript = [401, 401, "ok"];
    await expect(
      withBoundUser({ sub: "user_1", accessToken: "tok_DEAD" }, () =>
        client.call("vanna_lend", {}),
      ),
    ).rejects.toBeInstanceOf(MCPAuthError);

    // Two attempts, not an infinite loop, and the third scripted "ok" is unused.
    expect(toolCalls()).toHaveLength(2);
  });

  it("does not leave the evicted client behind for the next request", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    toolCallScript = [401, "ok"];
    await withBoundUser({ sub: "user_1", accessToken: "tok_A" }, () =>
      client.call("vanna_lend", {}),
    );

    // A later request with a newer token must not resurrect anything stale.
    await withBoundUser({ sub: "user_1", accessToken: "tok_B" }, () =>
      client.call("vanna_lend", {}),
    );
    const calls = toolCalls();
    expect(calls[calls.length - 1].authorization).toBe("Bearer tok_B");
  });
});

describe("routing is unchanged", () => {
  it("reads still go out on M2M even while a user is bound", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser({ sub: "user_1", accessToken: "tok_user" }, () =>
      client.call("vanna_get_price", { symbol: "XLM" }),
    );

    expect(recorded.some((r) => r.url === TOKEN_URL)).toBe(true);
    expect(toolCalls()[0].authorization).toBe("Bearer m2m_token");
  });

  it("writes still require the user token when one is bound", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();
    await withBoundUser({ sub: "user_1", accessToken: "tok_user" }, () =>
      client.call("vanna_enable_auto_sign", {}),
    );
    expect(toolCalls()[0].authorization).toBe("Bearer tok_user");
  });

  it("signed out, a write falls back to M2M rather than failing", async () => {
    const { getMcpClient } = await libs();
    await getMcpClient().call("vanna_lend", {});
    expect(toolCalls()[0].authorization).toBe("Bearer m2m_token");
  });
});
