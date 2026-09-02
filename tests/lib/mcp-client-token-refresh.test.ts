/**
 * The transport contract: one bearer, one assertion, never confused.
 *
 *   Authorization: Bearer <M2M>        which APPLICATION is calling. Constant.
 *   X-Vanna-User-Assertion: <token>    which PERSON it is calling for. Per request.
 *
 * This used to swap the bearer for the end user's token, which is the bug the
 * whole identity rewire fixes: the MCP then forwarded its own machine token to
 * the Sign Service as a user assertion and every auto-sign returned
 * 401 invalid_user_assertion, because a machine `sub` may not stand in for a
 * person.
 *
 * Two properties matter and both are pinned below:
 *   1. the assertion is read from the CURRENT request's ambient identity, so a
 *      cached client can never serve a stale one (the live bug that made writes
 *      fail ~30 minutes after sign-in);
 *   2. reads carry no assertion at all, so an anonymous visitor is unaffected.
 *
 * Drives the real getMcpClient() against a fake MCP so the actual handshake and
 * tools/call path are exercised, not a stubbed seam.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MCP_URL = "https://mcp.test.invalid/mcp";
const TOKEN_URL = "https://tenant.authkit.app/oauth2/token";

interface Recorded {
  url: string;
  authorization: string | null;
  assertion: string | null;
  method: string;
  sessionId: string | null;
  body: string;
}

let recorded: Recorded[] = [];
/** tools/call responses to serve, in order; a number means "fail with that status". */
let toolCallScript: Array<number | "ok" | "structured_error"> = [];
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
      assertion: headers.get("x-vanna-user-assertion"),
      method: init?.method ?? "GET",
      sessionId: headers.get("mcp-session-id"),
      body,
    });

    // WorkOS client_credentials — still the app's transport credential.
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
        if (next === "structured_error") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 2,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: "invalid_user_assertion",
                    message: "user assertion rejected",
                  }),
                },
              ],
            },
          });
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

const privy = (sub: string, accessToken: string) =>
  ({ sub, accessToken, kind: "privy" }) as const;

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

describe("bearer and assertion are separate credentials", () => {
  it("a write carries the M2M bearer AND the user's assertion", async () => {
    const { getMcpClient, withBoundUser } = await libs();

    await withBoundUser(privy("did:privy:alice", "privy_tok_alice"), () =>
      getMcpClient().call("vanna_lend", { amount: 1 }),
    );

    const [call] = toolCalls();
    expect(call.authorization).toBe("Bearer m2m_token");
    expect(call.assertion).toBe("privy_tok_alice");
  });

  it("a WorkOS session is forwarded the same way — one mechanism, two anchors", async () => {
    const { getMcpClient, withBoundUser } = await libs();

    await withBoundUser({ sub: "user_01KX5T", accessToken: "workos_tok", kind: "workos" }, () =>
      getMcpClient().call("vanna_lend", {}),
    );

    const [call] = toolCalls();
    expect(call.authorization).toBe("Bearer m2m_token");
    expect(call.assertion).toBe("workos_tok");
  });

  it("the user token NEVER becomes the bearer", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    await withBoundUser(privy("did:privy:alice", "privy_tok_alice"), () =>
      getMcpClient().call("vanna_enable_auto_sign", {}),
    );
    expect(toolCalls()[0].authorization).not.toContain("privy_tok_alice");
  });

  it("the handshake stays assertion-free — the session belongs to the app", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    await withBoundUser(privy("did:privy:alice", "privy_tok_alice"), () =>
      getMcpClient().call("vanna_lend", {}),
    );
    expect(initializes()).toHaveLength(1);
    expect(initializes()[0].assertion).toBeNull();
  });
});

describe("the assertion always comes from the current request", () => {
  it("THE BUG: a second call for the same user sends the NEWER token", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser(privy("did:privy:alice", "tok_OLD"), () =>
      client.call("vanna_lend", { amount: 1 }),
    );
    await withBoundUser(privy("did:privy:alice", "tok_NEW"), () =>
      client.call("vanna_lend", { amount: 2 }),
    );

    const calls = toolCalls();
    expect(calls.map((c) => c.assertion)).toEqual(["tok_OLD", "tok_NEW"]);
  });

  it("two users in a row never cross assertions", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser(privy("did:privy:alice", "tok_a"), () => client.call("vanna_lend", {}));
    await withBoundUser(privy("did:privy:bob", "tok_b"), () => client.call("vanna_lend", {}));

    expect(toolCalls().map((c) => c.assertion)).toEqual(["tok_a", "tok_b"]);
  });

  it("one shared session serves every user — no per-user handshake", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    await withBoundUser(privy("did:privy:alice", "tok_a"), () => client.call("vanna_lend", {}));
    await withBoundUser(privy("did:privy:bob", "tok_b"), () => client.call("vanna_lend", {}));

    // The old design opened one MCP session per user because the bearer differed.
    expect(initializes()).toHaveLength(1);
    expect(toolCalls().every((c) => c.sessionId === "sess-1")).toBe(true);
  });
});

describe("reads and signed-out writes", () => {
  it("a read sends no assertion even while a user is bound", async () => {
    const { getMcpClient, withBoundUser } = await libs();

    await withBoundUser(privy("did:privy:alice", "tok_a"), () =>
      getMcpClient().call("vanna_get_price", { symbol: "XLM" }),
    );

    expect(recorded.some((r) => r.url === TOKEN_URL)).toBe(true);
    expect(toolCalls()[0].authorization).toBe("Bearer m2m_token");
    expect(toolCalls()[0].assertion).toBeNull();
  });

  it("signed out, a write still goes out — it just cannot auto-sign", async () => {
    const { getMcpClient } = await libs();
    await getMcpClient().call("vanna_lend", {});
    expect(toolCalls()[0].authorization).toBe("Bearer m2m_token");
    expect(toolCalls()[0].assertion).toBeNull();
  });
});

describe("401 recovery", () => {
  it("preserves a structured MCP error code from result.isError", async () => {
    const { getMcpClient } = await libs();
    toolCallScript = ["structured_error"];

    await expect(getMcpClient().call("vanna_lend", {})).rejects.toMatchObject({
      code: "invalid_user_assertion",
      name: "MCPCallError",
    });
  });

  it("re-mints the M2M token and re-handshakes, then retries", async () => {
    const { getMcpClient, withBoundUser, MCPAuthError } = await libs();
    const client = getMcpClient();

    toolCallScript = [401];
    await expect(
      withBoundUser(privy("did:privy:alice", "tok_a"), () => client.call("vanna_lend", {})),
    ).rejects.toBeInstanceOf(MCPAuthError);

    // The rejected credential is dropped so the next request re-mints rather than
    // replaying a token the MCP has already refused.
    toolCallScript = ["ok"];
    const out = await withBoundUser(privy("did:privy:alice", "tok_a"), () =>
      client.call("vanna_lend", {}),
    );
    expect(out).toEqual({ ok: true });
    expect(initializes()).toHaveLength(2);
  });

  it("a stale MCP session is re-handshaked once and replayed", async () => {
    const { getMcpClient, withBoundUser } = await libs();
    const client = getMcpClient();

    toolCallScript = [404, "ok"];
    const out = await withBoundUser(privy("did:privy:alice", "tok_a"), () =>
      client.call("vanna_lend", {}),
    );

    expect(out).toEqual({ ok: true });
    expect(initializes()).toHaveLength(2);
    // The replay must carry the same identity, not drop it on the retry path.
    expect(toolCalls().map((c) => c.assertion)).toEqual(["tok_a", "tok_a"]);
  });
});
