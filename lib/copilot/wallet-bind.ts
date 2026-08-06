/**
 * Server half of the in-app signing-authority bind.
 *
 * ## Why any of this is here
 *
 * The consent that writes `identity_wallet_bindings` is three steps, and only the
 * middle one needs a browser:
 *
 *   1. POST /wallets/connect/start   (MCP, carries the user assertion → stamps `sub`)
 *   2. Privy addSigners             (client SDK, in the page the user is already in)
 *   3. POST /wallets/connect/register (proves quorum-is-signer, writes the binding)
 *
 * Vanna's own connect page does all three by being served FROM the Connect Gateway,
 * so its step 3 is a same-origin fetch. Our copilot page is a different origin and
 * the gateway ships no CORS headers, so the browser cannot make that call — which is
 * the only reason the "open the authorization page" detour existed at all.
 *
 * A server-to-server POST has no CORS to satisfy, so this module makes step 3 from
 * the Next server instead. The gateway's register route is deliberately public — its
 * guards are the unguessable single-use nonce and the server-side
 * `verifyQuorumIsSigner` on the main service, not the caller's identity — so
 * forwarding it changes no security property. The main service still decides
 * success, still re-verifies against Privy, and still fails closed.
 *
 * ## What this module refuses to do
 *
 * It never takes the gateway URL from the browser. A client-supplied forward target
 * would make this an open proxy inside our server's network. The origin is recorded
 * when WE mint the connect request (from the `connect_url` the Sign Service returned)
 * or read from env, and looked up by `request_id` afterwards.
 */

import { copilotConfig } from "./config";

/** How long a minted connect request's origin stays resolvable. Matches the request TTL. */
const ORIGIN_TTL_MS = 30 * 60_000;

/**
 * `request_id` → the Connect Gateway origin that minted it.
 *
 * In-memory on purpose: it is a per-request routing hint with a minutes-long life,
 * not state worth a database. `SIGN_CONNECT_BASE_URL` covers the case where the
 * register call could land on a different instance than the start call.
 */
const originByRequest = new Map<string, { origin: string; at: number }>();

function sweep(now: number): void {
  for (const [k, v] of originByRequest) {
    if (now - v.at > ORIGIN_TTL_MS) originByRequest.delete(k);
  }
}

/** Origin from an explicitly configured gateway base URL, if there is one. */
function configuredOrigin(): string | null {
  const raw = process.env.SIGN_CONNECT_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Record where a freshly minted connect request came from.
 *
 * Derived from the Sign Service's own `connect_url`, so it needs no configuration
 * and cannot point anywhere the Sign Service did not name.
 */
export function rememberConnectOrigin(requestId: string, connectUrl: string): void {
  if (!requestId || !connectUrl) return;
  let origin: string;
  try {
    const u = new URL(connectUrl);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      return;
    }
    origin = u.origin;
  } catch {
    return;
  }
  const now = Date.now();
  sweep(now);
  originByRequest.set(requestId, { origin, at: now });
}

/** The gateway origin for a request id, or null when it cannot be resolved safely. */
export function resolveConnectOrigin(requestId: string): string | null {
  const configured = configuredOrigin();
  if (configured) return configured;
  const hit = originByRequest.get(requestId);
  if (!hit) return null;
  if (Date.now() - hit.at > ORIGIN_TTL_MS) {
    originByRequest.delete(requestId);
    return null;
  }
  return hit.origin;
}

/** Cached signer-quorum id, keyed by the gateway origin that published it. */
const signerIdByOrigin = new Map<string, string>();

/**
 * The Privy signer-quorum id the user must authorize.
 *
 * Public by construction: the Connect Gateway injects it into every browser that
 * loads the connect page, as `window.__VANNA_CONNECT__ = {appId, signerId}`.
 *
 * Read from env when set. Otherwise taken from that same injected script, which
 * makes the in-app path work against an already-deployed gateway with no new
 * configuration — and keeps one source of truth, so the in-app consent can never
 * authorize a different quorum than the fallback page would. Never fatal: no signer
 * id just means the silent path is unavailable and the link fallback is used.
 */
export async function resolvePrivySignerId(origin: string): Promise<string | null> {
  const fromEnv =
    process.env.PRIVY_SIGNER_ID?.trim() || process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID?.trim();
  if (fromEnv) return fromEnv;

  const cached = signerIdByOrigin.get(origin);
  if (cached) return cached;

  try {
    const res = await fetch(`${origin}/connect`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // `[^]` rather than `.` with the `s` flag — the build targets an ES version
    // where `dotAll` is unavailable, and the injected script may span lines.
    const m = html.match(/window\.__VANNA_CONNECT__\s*=\s*(\{[^]*?\})\s*;/);
    if (!m) return null;
    const parsed = JSON.parse(m[1]) as { signerId?: unknown };
    const signerId = typeof parsed.signerId === "string" ? parsed.signerId.trim() : "";
    if (!signerId) return null;
    signerIdByOrigin.set(origin, signerId);
    return signerId;
  } catch {
    return null;
  }
}

export type RegisterBindResult =
  | { ok: true }
  | {
      ok: false;
      /** Error code from the Sign Service, or a transport code we generated. */
      code: string;
      message: string;
      /** True when the single-use request expired (HTTP 410) — needs a fresh one. */
      expired: boolean;
    };

/**
 * Complete step 3: tell the Sign Service the user has authorized the quorum.
 *
 * Sends only public data — `request_id` and the G-address — exactly the body the
 * connect page sends. No key material, no assertion: the main service re-derives the
 * identity from the sub it stamped at start, which is why a hostile caller who
 * guessed a request id still cannot bind a wallet to someone else.
 */
export async function registerWalletBind(opts: {
  requestId: string;
  walletAddress: string;
  origin: string;
}): Promise<RegisterBindResult> {
  let res: Response;
  try {
    res = await fetch(`${opts.origin}/wallets/connect/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The gateway 403s an absent Origin only when CONNECT_ORIGIN_ALLOWLIST is
        // set. Sent when we know our own public origin so that deployment keeps
        // working; harmless when the allowlist is empty.
        ...(copilotConfig.publicOrigin ? { Origin: copilotConfig.publicOrigin } : {}),
      },
      body: JSON.stringify({
        request_id: opts.requestId,
        walletAddress: opts.walletAddress,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      code: "gateway_unreachable",
      message: `Could not reach the wallet-authorization service (${msg}).`,
      expired: false,
    };
  }

  if (res.ok) return { ok: true };

  let code = `http_${res.status}`;
  let message = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    code = j.error || code;
    message = j.message || j.error || message;
  } catch {
    /* keep defaults */
  }
  return { ok: false, code, message, expired: res.status === 410 };
}
