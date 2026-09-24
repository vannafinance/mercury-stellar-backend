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
 * Step 3 normally goes through the authenticated MCP channel. The gateway POST stays
 * as a temporary compatibility path for an MCP deployment that has not registered
 * the action yet. The origin lookup below is used only for that path and for reading
 * the signer id advertised by the same connect page.
 *
 * ## What this module refuses to do
 *
 * It never takes the gateway URL from the browser. A client-supplied forward target
 * would make this an open proxy inside our server's network. The origin is recorded
 * when WE mint the connect request (from the `connect_url` the Sign Service returned)
 * or read from env, and looked up by `request_id` afterwards.
 */

import { copilotConfig } from "./config";
import { MCPError, type MCPClient } from "./mcp-client";

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
 * Record where a freshly minted connect request came from. This supports resolving
 * the public signer id and the temporary gateway compatibility path.
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
    const isTest = u.hostname.endsWith(".test") || u.hostname.endsWith(".invalid");
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const isVanna = u.hostname === "vanna.finance" || u.hostname.endsWith(".vanna.finance");
    const configuredHost =
      process.env.SIGN_CONNECT_BASE_URL || process.env.SIGN_SERVICE_URL || copilotConfig.mcpBaseUrl;
    let isConfigured = false;
    if (configuredHost) {
      try {
        isConfigured = new URL(configuredHost).hostname === u.hostname;
      } catch {}
    }
    if (!isTest && !isLocal && !isVanna && !isConfigured) {
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
  | {
      ok: true;
      /**
       * Whether the Sign Service actually wrote the `identity_wallet_bindings` row.
       *
       * A 200 from register means "the wallet is connected", which is NOT the same as
       * "this identity is now bound to it" — and for a long time nothing could tell the
       * two apart, because the response said `connected: true` either way and this
       * function discarded the body. Callers then reported success while every consumer
       * downstream still refused the wallet as unbound.
       *
       * `null` means an older Sign Service that does not report the field at all; it is
       * deliberately distinct from `false`, so a caller can retry on a real failure
       * without looping forever against a deployment that simply cannot answer.
       */
      bindingWritten: boolean | null;
      /** Why the binding did not land, when the service named a reason. */
      bindingError?: string;
    }
  | {
      ok: false;
      /** Error code from the Sign Service, or a transport code we generated. */
      code: string;
      message: string;
      /** True when the single-use request expired (HTTP 410) — needs a fresh one. */
      expired: boolean;
    };

const REGISTER_FAILURE_MESSAGE =
  "The wallet-authorization service could not complete the request.";

function safeErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
}

/** Older composite dispatchers report an unavailable action as this structured shape. */
function isRegisterActionAbsent(result: Record<string, unknown>): boolean {
  const code = safeErrorCode(result.code);
  if (code === "unknown_action" || code === "unknown_tool" || code === "tool_not_found") {
    return true;
  }

  // Before the dispatcher returned a distinct code, its missing-action result was the
  // only `invalid_input` response with a top-level message and no operation status.
  // This call supplies both required arguments, so a service refusal has a status and
  // an error code instead and cannot take this compatibility path.
  return result.error === "invalid_input" && !result.status && typeof result.message === "string";
}

function isRegisterToolAbsentError(error: unknown): boolean {
  if (!(error instanceof MCPError)) return false;
  return ["unknown_action", "unknown_tool", "tool_not_found"].includes(error.code ?? "");
}

function registerFailure(code: unknown, expiredStatus?: number): RegisterBindResult {
  const safeCode = safeErrorCode(code) ?? "register_failed";
  return {
    ok: false,
    code: safeCode,
    message: REGISTER_FAILURE_MESSAGE,
    expired: expiredStatus === 410 || safeCode === "expired",
  };
}

function registerSuccess(result: Record<string, unknown>): RegisterBindResult {
  const bindingError = safeErrorCode(result.identity_binding_error);
  return {
    ok: true,
    bindingWritten:
      typeof result.identity_binding_written === "boolean"
        ? result.identity_binding_written
        : null,
    ...(bindingError ? { bindingError } : {}),
  };
}

async function registerViaGateway(opts: {
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
        // The compatibility gateway still enforces its browser-origin allowlist.
        ...(copilotConfig.publicOrigin ? { Origin: copilotConfig.publicOrigin } : {}),
      },
      body: JSON.stringify({
        request_id: opts.requestId,
        walletAddress: opts.walletAddress,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return registerFailure("gateway_unreachable");
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    /* A malformed body is represented as a generic failure below. */
  }

  if (res.ok) return registerSuccess(payload);
  return registerFailure(payload.error, res.status);
}

export function registerWalletBind(
  mcp: MCPClient,
  opts: {
    requestId: string;
    walletAddress: string;
    origin?: string | null;
  },
  userId: string,
): Promise<RegisterBindResult> {
  if (!userId) return Promise.resolve(registerFailure("invalid_input"));
  return registerWalletBindViaMcp(mcp, opts, userId);
}

/**
 * Complete step 3 through the authenticated MCP register action. An older server that
 * reports the action itself as absent uses the existing gateway request as a temporary
 * compatibility path. Other MCP failures never fall back.
 */
async function registerWalletBindViaMcp(
  mcp: MCPClient,
  opts: { requestId: string; walletAddress: string; origin?: string | null },
  userId: string,
): Promise<RegisterBindResult> {
  let result: Record<string, unknown>;
  try {
    result = await mcp.call(
      "vanna_connect_wallet_register",
      { request_id: opts.requestId, wallet_address: opts.walletAddress },
      userId,
    );
  } catch (e) {
    if (isRegisterToolAbsentError(e)) {
      return opts.origin
        ? registerViaGateway({ ...opts, origin: opts.origin })
        : registerFailure("register_tool_unavailable");
    }
    return registerFailure(e instanceof MCPError ? e.code : "register_failed");
  }

  if (isRegisterActionAbsent(result)) {
    return opts.origin
      ? registerViaGateway({ ...opts, origin: opts.origin })
      : registerFailure("register_tool_unavailable");
  }
  if (result.status === "ok" || result.status === "connected") return registerSuccess(result);
  return registerFailure(result.error, result.http_status === 410 ? 410 : undefined);
}
