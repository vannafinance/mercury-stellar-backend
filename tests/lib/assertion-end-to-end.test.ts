/**
 * The assertion must survive the WHOLE request, not just a direct client.call().
 *
 * ## The live failure this pins
 *
 * After deploying the identity rewire, the Sign Service logged, on every
 * /sessions call:
 *
 *   hasAssertion: true
 *   verifyOk: false
 *   assertionError: assertion subject is not an end user: sub="client_01KXBNH…"
 *                   does not start with "user_"
 *
 * An assertion WAS arriving — but it was the M2M bearer, because the MCP falls
 * back to the bearer when the copilot sends no X-Vanna-User-Assertion header. So
 * the header never left the app, even though /api/auth/session on the same
 * deployment reported anchor:"privy" for the same user.
 *
 * The existing transport test could not catch that: it called
 * `client.call()` from inside `withBoundUser`, which skips every layer where the
 * ambient identity can actually be lost — the route handler, handleChat, and the
 * async hops between them. This drives the REAL exported POST handler instead,
 * with only the network and the Privy verifier faked, so the binding has to
 * survive the same path production takes.
 *
 * The `auto_sign` action is used deliberately: handle.ts short-circuits it before
 * any LLM routing, so this exercises the exact call that failed live
 * (vanna_enable_auto_sign → POST /sessions) with no Vertex dependency.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MCP_URL = "https://mcp.test.invalid/mcp";
const TOKEN_URL = "https://tenant.authkit.app/oauth2/token";
const TRADER = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
const PRIVY_SUB = "did:privy:cmrx9k2p400abcd0lm12efgh";
const PRIVY_TOKEN = "privy.access.token.for.alice"; // nosec - fixture

// The Privy verifier is the one thing that cannot run here: it would need a real
// ES256 signature from Privy's keys. Its own test suite covers that with real
// crypto; this test is about what happens to the identity AFTER it verifies.
vi.mock("@/lib/copilot/privy-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/privy-auth")>();
  return {
    ...actual,
    verifyPrivyToken: vi.fn(async (token: string) => {
      if (token !== PRIVY_TOKEN) throw new actual.PrivyAuthError("unexpected token");
      return { sub: PRIVY_SUB, sessionId: "sess-1", expiresAt: Date.now() + 3_600_000 };
    }),
  };
});

interface Recorded {
  url: string;
  authorization: string | null;
  assertion: string | null;
  body: string;
}

let recorded: Recorded[] = [];
let realFetch: typeof fetch;

function installFakeNetwork() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit);
    const body = String(init?.body ?? "");
    recorded.push({
      url,
      authorization: headers.get("authorization"),
      assertion: headers.get("x-vanna-user-assertion"),
      body,
    });

    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "m2m_token", expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === MCP_URL) {
      const parsed = JSON.parse(body || "{}") as { method?: string };
      if (parsed.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-mcp-1" },
        });
      }
      if (parsed.method === "notifications/initialized") {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      // Whatever the tool, answer with the shape enable_auto_sign expects.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            structuredContent: {
              status: "needs_confirmation",
              message: "Choose caps",
              default_cap_usd: 1000,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

/** POST /api/copilot exactly as the browser does it. */
async function postCopilot(headers: Record<string, string>) {
  const { POST } = await import("@/app/api/copilot/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("https://preview.vanna.finance/api/copilot", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      user_id: TRADER,
      tier: "paid",
      // Short-circuits before any LLM routing — the live enable_auto_sign path.
      auto_sign: { action: "start" },
    }),
  });
  return POST(req);
}

const mcpToolCalls = () => recorded.filter((r) => r.url === MCP_URL && r.body.includes("tools/call"));

/** Import-time configuration, so warming the route graph sees the same env a test does. */
function setEnv() {
  process.env.MCP_MODE = "live";
  process.env.MCP_BASE_URL = MCP_URL;
  process.env.WORKOS_M2M_CLIENT_ID = "client_m2m";
  process.env.WORKOS_M2M_CLIENT_SECRET = "secret";
  process.env.WORKOS_M2M_TOKEN_URL = TOKEN_URL;
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "cmrdk67en003k0cjojj56n8mh";
}

// Warm the route module graph once, outside any test's budget.
//
// `postCopilot` imports the real `/api/copilot` route, which pulls in the whole copilot
// brain. That transform+load is genuine work — over five seconds while the full suite has
// every worker busy — and inside `it()` it was charged to a 5s test timeout, so the FIRST
// test here failed with "Test timed out in 5000ms" on roughly every other full-suite run
// and passed alone every time. The measured failures were 5123ms / 5258ms / 5277ms: not a
// hang, just marginally over. Later tests in the file were always fine, because by then
// the module cache was warm.
//
// Paying it here lets the hook carry a timeout sized for "load a large module graph" while
// the tests keep the default 5s and stay honest about their own work. Env first, because
// the graph reads MCP_MODE and the WorkOS settings as it loads.
beforeAll(async () => {
  setEnv();
  await import("@/app/api/copilot/route");
  await import("next/server");
}, 120_000);

beforeEach(async () => {
  setEnv();
  recorded = [];
  installFakeNetwork();
  const { resetMcpClient } = await import("@/lib/copilot/mcp-client");
  resetMcpClient();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const { resetMcpClient } = await import("@/lib/copilot/mcp-client");
  resetMcpClient();
});

describe("a Privy token on the request reaches the MCP as the assertion", () => {
  it("THE LIVE BUG: the assertion header is present on the MCP tool call", async () => {
    await postCopilot({ "x-privy-token": PRIVY_TOKEN });

    const calls = mcpToolCalls();
    expect(calls.length).toBeGreaterThan(0);
    // Live, this was null and the MCP fell back to forwarding its own M2M bearer,
    // which the Sign Service refused as a machine subject.
    expect(calls[0].assertion).toBe(PRIVY_TOKEN);
  });

  it("the bearer stays the app's M2M credential", async () => {
    await postCopilot({ "x-privy-token": PRIVY_TOKEN });
    const calls = mcpToolCalls();
    expect(calls[0].authorization).toBe("Bearer m2m_token");
    expect(calls[0].authorization).not.toContain(PRIVY_TOKEN);
  });

  it("works when the token arrives on Privy's cookie instead of the header", async () => {
    await postCopilot({ cookie: `privy-token=${PRIVY_TOKEN}` });
    expect(mcpToolCalls()[0].assertion).toBe(PRIVY_TOKEN);
  });

  it("sends no assertion when the request carries no Privy session", async () => {
    await postCopilot({});
    const calls = mcpToolCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].assertion).toBeNull();
  });

  it("sends no assertion when the token is refused", async () => {
    await postCopilot({ "x-privy-token": "some.other.token" });
    expect(mcpToolCalls()[0].assertion).toBeNull();
  });
});
