/**
 * `wallet_not_bound` must become a consent flow, not a dead end.
 *
 * ## The live failure this pins
 *
 * With the assertion hop and JWKS routing both fixed, enabling auto-sign started
 * returning a clean, correct 403:
 *
 *   { error: "wallet_not_bound", http_status: 403 }
 *
 * The operator did the only thing the UI suggested — disconnected and reconnected
 * the wallet through the Privy modal, while signed in — and got the same 403. That
 * is not a flaky reconnect: the two facts are stored in different systems.
 *
 *   Privy "Connect Wallet"  → a browser wallet session.
 *   Vanna signing authority → a row in the Sign Service's identity_wallet_bindings,
 *                             stamped at POST /wallets/connect/start from the
 *                             forwarded user assertion's `sub`, and completed when
 *                             the user authorizes the Vanna quorum as an ADDITIONAL
 *                             signer on their own wallet.
 *
 * Nothing a wallet-connect modal does writes that row. And nothing in this app ever
 * called connect_start — grepping it found no caller at all — so the binding could
 * never come into existence, and the 403 was permanent by construction.
 *
 * These tests drive the REAL POST /api/copilot handler (network + Privy verifier
 * faked) because the thing that must hold is end-to-end: the 403 has to turn into a
 * connect_start call that CARRIES THE ASSERTION. A connect_start without it still
 * returns a working link, still connects the wallet, and still writes no binding —
 * a flow that looks like it worked and fixes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MCP_URL = "https://mcp.test.invalid/mcp";
const TOKEN_URL = "https://tenant.authkit.app/oauth2/token";
const TRADER = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
/** A Privy DID, not a WorkOS `user_…`. What bindings must key on for a Privy login. */
const PRIVY_SUB = "did:privy:cmrx9k2p400abcd0lm12efgh";
const PRIVY_TOKEN = "privy.access.token.for.alice"; // nosec - fixture
const CONNECT_URL = "https://sign.test.invalid/connect?req=req_abc123";
const REQUEST_ID = "req_abc123";

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

interface ToolCall {
  /** Consolidated dispatcher name, e.g. `vanna_wallet`. */
  name: string;
  /** Dispatcher action, e.g. `connect_start`. */
  action: string;
  kwargs: Record<string, unknown>;
  assertion: string | null;
  authorization: string | null;
}

let toolCalls: ToolCall[] = [];
let realFetch: typeof fetch;

/** What the fake Sign Service (behind MCP) should answer for enable_auto_sign. */
let bound = false;

function structured(payload: unknown) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: payload } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function installFakeNetwork() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit);
    const body = String(init?.body ?? "");

    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "m2m_token", expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url !== MCP_URL) throw new Error(`unexpected fetch to ${url}`);

    const parsed = JSON.parse(body || "{}") as {
      method?: string;
      params?: { name?: string; arguments?: { action?: string; kwargs?: Record<string, unknown> } };
    };
    if (parsed.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "sess-mcp-1" },
      });
    }
    if (parsed.method === "notifications/initialized") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }

    const name = parsed.params?.name ?? "";
    const action = parsed.params?.arguments?.action ?? "";
    toolCalls.push({
      name,
      action,
      kwargs: parsed.params?.arguments?.kwargs ?? {},
      assertion: headers.get("x-vanna-user-assertion"),
      authorization: headers.get("authorization"),
    });

    if (name === "vanna_sign" && action === "enable_auto_sign") {
      // The exact shape MCP passes through from the Sign Service's bind gate.
      if (!bound) {
        return structured({
          error: "wallet_not_bound",
          message:
            "This wallet is not bound to the authenticated user. Run wallet connect " +
            "again WHILE SIGNED IN, then retry.",
          http_status: 403,
          detail: { status: "error", error: "wallet_not_bound" },
        });
      }
      return structured({
        status: "enabled",
        created: true,
        session_id: "sess_1",
        wallet_address: TRADER,
        default_cap_usd: 1000,
        max_per_tx_usd: 1000,
        max_per_day_usd: 1000,
        summary: "Auto-sign enabled for wallet GBC2B7N2...",
      });
    }
    if (name === "vanna_sign" && action === "disable_auto_sign") {
      if (!bound) {
        return structured({
          error: "wallet_not_bound",
          message: "This wallet is not bound to the authenticated user.",
          http_status: 403,
        });
      }
      return structured({ status: "ok", summary: "Auto-sign disabled." });
    }
    if (name === "vanna_wallet" && action === "connect_start") {
      return structured({
        request_id: REQUEST_ID,
        connect_url: CONNECT_URL,
        expires_in: 900,
        does_not_enable_auto_sign: true,
        poll_schedule_seconds: [2, 4, 8, 16, 32],
      });
    }
    if (name === "vanna_wallet" && action === "connect_status") {
      // Consent completed → the Sign Service wrote the binding at register.
      bound = true;
      return structured({
        status: "connected",
        continue_polling: false,
        wallet_address: TRADER,
        auto_sign_enabled: false,
      });
    }
    return structured({ status: "ok" });
  }) as typeof fetch;
}

/** POST /api/copilot exactly as the browser does it. */
async function postCopilot(
  autoSign: Record<string, unknown>,
  headers: Record<string, string> = { "x-privy-token": PRIVY_TOKEN },
) {
  const { POST } = await import("@/app/api/copilot/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("https://preview.vanna.finance/api/copilot", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ user_id: TRADER, tier: "paid", auto_sign: autoSign }),
  });
  const res = await POST(req);
  return (await res.json()) as {
    kind: string;
    message: string;
    wallet_bind?: {
      status?: string;
      connect_url?: string | null;
      request_id?: string | null;
      retry_action?: string | null;
      max_per_tx_usd?: number | string | null;
      max_per_day_usd?: number | string | null;
      poll_schedule_seconds?: number[] | null;
    } | null;
  };
}

const callsTo = (name: string, action: string) =>
  toolCalls.filter((c) => c.name === name && c.action === action);

beforeEach(async () => {
  process.env.MCP_MODE = "live";
  process.env.MCP_BASE_URL = MCP_URL;
  process.env.WORKOS_M2M_CLIENT_ID = "client_m2m";
  process.env.WORKOS_M2M_CLIENT_SECRET = "secret";
  process.env.WORKOS_M2M_TOKEN_URL = TOKEN_URL;
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "cmrdk67en003k0cjojj56n8mh";
  toolCalls = [];
  bound = false;
  installFakeNetwork();
  const { resetMcpClient } = await import("@/lib/copilot/mcp-client");
  resetMcpClient();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const { resetMcpClient } = await import("@/lib/copilot/mcp-client");
  resetMcpClient();
});

describe("wallet_not_bound starts the additional-signer consent", () => {
  it("THE LIVE BUG: enabling auto-sign on an unbound wallet calls connect_start", async () => {
    const data = await postCopilot({ action: "use_defaults" });

    // Before this change nothing in the app called connect_start, so the binding
    // the 403 asks for could never be written.
    expect(callsTo("vanna_wallet", "connect_start")).toHaveLength(1);
    expect(data.kind).toBe("needs_wallet_bind");
    expect(data.wallet_bind?.connect_url).toBe(CONNECT_URL);
    expect(data.wallet_bind?.status).toBe("needs_consent");
  });

  it("connect_start carries the user assertion — without it no binding is written", async () => {
    await postCopilot({ action: "use_defaults" });

    const [connect] = callsTo("vanna_wallet", "connect_start");
    // The Sign Service stamps THIS token's `sub` onto the pending connect request,
    // and that stored sub becomes the identity_wallet_bindings row. No assertion on
    // this hop = a connect that succeeds and binds nothing.
    expect(connect.assertion).toBe(PRIVY_TOKEN);
    // Alongside the M2M bearer, never in place of it.
    expect(connect.authorization).toBe("Bearer m2m_token");
  });

  it("the binding is keyed on the did:privy subject, not a WorkOS user_", async () => {
    await postCopilot({ action: "use_defaults" });

    const { verifyPrivyToken } = await import("@/lib/copilot/privy-auth");
    // The assertion forwarded on connect_start is the same Privy token whose verified
    // subject is a DID. A `user_`-only assumption anywhere on this path would make a
    // Privy-verified user permanently unbindable.
    const verified = await (verifyPrivyToken as unknown as (t: string) => Promise<{ sub: string }>)(
      PRIVY_TOKEN,
    );
    expect(verified.sub).toBe(PRIVY_SUB);
    expect(verified.sub.startsWith("did:privy:")).toBe(true);
    expect(verified.sub.startsWith("user_")).toBe(false);
    expect(callsTo("vanna_wallet", "connect_start")[0].assertion).toBe(PRIVY_TOKEN);
  });

  it("asks for consent BEFORE spend caps, so caps are never collected then discarded", async () => {
    // "enable auto-sign" with no caps chosen yet. The old path showed the cap picker
    // first; the 403 lands before any session exists, so those numbers went nowhere.
    const data = await postCopilot({ action: "start" });
    expect(data.kind).toBe("needs_wallet_bind");
    expect(callsTo("vanna_wallet", "connect_start")).toHaveLength(1);
  });

  it("carries custom caps through the detour so the user re-enters nothing", async () => {
    const data = await postCopilot({
      action: "custom",
      max_per_tx_usd: 250,
      max_per_day_usd: 900,
    });
    expect(data.kind).toBe("needs_wallet_bind");
    expect(data.wallet_bind?.retry_action).toBe("custom");
    expect(data.wallet_bind?.max_per_tx_usd).toBe(250);
    expect(data.wallet_bind?.max_per_day_usd).toBe(900);
  });

  it("disable also hits the bind gate and says so instead of reporting success", async () => {
    const data = await postCopilot({ action: "disable" });
    expect(data.kind).toBe("needs_wallet_bind");
    expect(data.wallet_bind?.retry_action).toBe("disable");
  });

  it("never claims auto-sign is on while the wallet is unbound", async () => {
    for (const action of ["start", "use_defaults", "custom", "disable"]) {
      toolCalls = [];
      const data = await postCopilot(
        action === "custom" ? { action, max_per_tx_usd: 100 } : { action },
      );
      expect(data.kind).toBe("needs_wallet_bind");
      // No session was created, and nothing in the copy pretends one was.
      expect(data.message).not.toMatch(/auto-sign (is )?(now )?(on|enabled)/i);
    }
  });

  it("never instructs the user to reconnect — it says why that cannot work", async () => {
    const data = await postCopilot({ action: "use_defaults" });
    // The dead end the operator actually walked into. The copy is allowed — required,
    // even — to mention reconnecting, but only to rule it out; never as the next step.
    expect(data.message).not.toMatch(
      /(please |try |now )?(re-?connect|connect) your wallet( again)?[.,]/i,
    );
    expect(data.message).toMatch(/reconnecting your wallet does not fix it/i);
    // And it must name the real action instead.
    expect(data.message).toMatch(/additional signer/i);
    expect(data.message.startsWith(" ")).toBe(false);
  });
});

describe("after the consent completes, the original request finishes", () => {
  it("HAPPY PATH: polling a completed consent enables auto-sign in the same turn", async () => {
    const started = await postCopilot({ action: "use_defaults" });
    expect(started.kind).toBe("needs_wallet_bind");

    const done = await postCopilot({
      action: "bind_status",
      request_id: started.wallet_bind?.request_id,
      retry_action: started.wallet_bind?.retry_action,
    });

    // connect_status ran, and the enable the user originally asked for was replayed.
    expect(callsTo("vanna_wallet", "connect_status")).toHaveLength(1);
    expect(callsTo("vanna_sign", "enable_auto_sign").length).toBeGreaterThan(0);
    expect(done.kind).toBe("answer");
    expect(done.message).toMatch(/auto-sign/i);
  });

  it("a consent still pending reports pending and keeps the request_id to poll", async () => {
    // Override connect_status to stay pending for this case only.
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (String(input) === MCP_URL && body.includes("connect_status")) {
        return structured({ status: "pending", continue_polling: true });
      }
      return prev(input as never, init);
    }) as typeof fetch;

    const data = await postCopilot({
      action: "bind_status",
      request_id: REQUEST_ID,
      retry_action: "use_defaults",
    });
    expect(data.kind).toBe("needs_wallet_bind");
    expect(data.wallet_bind?.status).toBe("pending");
    expect(data.wallet_bind?.request_id).toBe(REQUEST_ID);
    // Crucially it did NOT enable anything on a pending consent.
    expect(callsTo("vanna_sign", "enable_auto_sign")).toHaveLength(0);
  });

  it("a still-unbound wallet after a completed consent is reported as a server fault", async () => {
    // connect_status says connected, but the bind never landed — the one case that is
    // a real bug rather than a missing user action. It must not loop on another link.
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (String(input) === MCP_URL && body.includes("connect_status")) {
        return structured({
          status: "connected",
          wallet_address: TRADER,
          auto_sign_enabled: false,
        });
      }
      if (String(input) === MCP_URL && body.includes("enable_auto_sign")) {
        return structured({ error: "wallet_not_bound", message: "still unbound", http_status: 403 });
      }
      return prev(input as never, init);
    }) as typeof fetch;

    const data = await postCopilot({
      action: "bind_status",
      request_id: REQUEST_ID,
      retry_action: "use_defaults",
    });
    expect(data.kind).toBe("needs_wallet_bind");
    expect(data.wallet_bind?.status).toBe("unavailable");
    expect(data.message).toMatch(/server-side fault|report it/i);
  });
});

describe("the identity-scoped binding read must carry the identity", () => {
  it("list_bindings sends the assertion — on M2M alone it would answer 'no bindings'", async () => {
    const { callNeedsUserToken } = await import("@/lib/copilot/user-context");
    // It reads no chain state; it answers "which wallets has THIS PERSON bound", and
    // the Sign Service keys that solely on the verified assertion sub. Treated as a
    // plain read it returns hasAssertion:false + an empty list, which would CONFIRM a
    // false wallet_not_bound diagnosis.
    expect(callNeedsUserToken("vanna_list_my_wallet_bindings")).toBe(true);
  });

  it("connect_start is never treated as an anonymous read", async () => {
    const { callNeedsUserToken } = await import("@/lib/copilot/user-context");
    expect(callNeedsUserToken("vanna_connect_wallet_start")).toBe(true);
  });

  it("plain chain reads still stay on the shared M2M credential", async () => {
    const { callNeedsUserToken } = await import("@/lib/copilot/user-context");
    expect(callNeedsUserToken("vanna_get_pool_stats")).toBe(false);
    expect(callNeedsUserToken("vanna_get_wallet_balance")).toBe(false);
  });
});

describe("the transport maps the connect tools onto the consolidated API", () => {
  it("connect_start / connect_status become vanna_wallet actions", async () => {
    const { toServerCall } = await import("@/lib/copilot/mcp-client");
    expect(toServerCall("vanna_connect_wallet_start", {})).toEqual({
      name: "vanna_wallet",
      arguments: { action: "connect_start", kwargs: {} },
    });
    expect(toServerCall("vanna_connect_wallet_status", { request_id: REQUEST_ID })).toEqual({
      name: "vanna_wallet",
      arguments: { action: "connect_status", kwargs: { request_id: REQUEST_ID } },
    });
  });
});
