/**
 * In-process MCP client for the Vanna Finance MCP server.
 *
 * Auth: two credentials that answer two different questions, sent together — not
 * one credential doing both jobs (see RoutingMCPClient at the bottom).
 *   Authorization: Bearer …      WorkOS M2M. Which application is calling.
 *                                Every call, signed in or not.
 *   X-Vanna-User-Assertion: …    the end user's own token — Privy by default, a
 *                                WorkOS Connect OAuth login if they have one.
 *                                Writes only, and only when someone is signed in.
 *                                The Sign Service verifies this and it is the only
 *                                thing that can authorize a signature.
 * Transport: Streamable HTTP (POST + SSE `event: message` frames + mcp-session-id).
 *
 * Mock mode returns canned numbers so the copilot works offline.
 */

import { copilotConfig } from "./config";
import { callNeedsUserToken, currentUser } from "./user-context";

export class MCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPError";
  }
}

export class MCPAuthError extends MCPError {
  constructor(message: string) {
    super(message);
    this.name = "MCPAuthError";
  }
}

export class MCPCallError extends MCPError {
  constructor(message: string) {
    super(message);
    this.name = "MCPCallError";
  }
}

export interface MCPClient {
  call(tool: string, args: Record<string, unknown>, userId?: string): Promise<Record<string, unknown>>;
}

// ── mock ────────────────────────────────────────────────────────────────────

class MockMCPClient implements MCPClient {
  async call(tool: string, args: Record<string, unknown>, _userId?: string): Promise<Record<string, unknown>> {
    if (tool === "vanna_get_account_health") {
      return {
        health_factor: 1.72,
        leverage: 3.1,
        collateral_usd: 500,
        debt_usd: 200,
        net_yield_apy: 6.4,
      };
    }
    if (tool === "vanna_get_pool_stats") {
      return {
        pool_symbol: String(args.symbol ?? "USDC"),
        utilization_pct: "64.00",
        borrow_apr_pct: "3.10",
        supply_apr_pct: "5.20",
        supply_apy_pct: "5.20",
        total_liquidity_human: "1000000",
        total_borrows_human: "640000",
      };
    }
    if (tool === "vanna_get_price") {
      const symbol = String(args.symbol ?? "XLM").toUpperCase();
      const table: Record<string, string> = { XLM: "0.11", USDC: "1.0", AQUA: "0.004", BLUSDC: "1.0" };
      return {
        symbol,
        price_usd: table[symbol] ?? "1.0",
        decimals: 14,
        is_stale: false,
      };
    }
    if (tool === "vanna_get_prices_batch" || tool === "vanna_get_prices") {
      return {
        prices: {
          XLM: { price_usd: "0.11" },
          USDC: { price_usd: "1.0" },
          AQUA: { price_usd: "0.004" },
        },
        fetched: 3,
        requested: 3,
      };
    }
    if (tool === "vanna_get_collateral") {
      return { collateral: [{ symbol: "USDC", amount_human: "100", usd: 100 }] };
    }
    if (tool === "vanna_get_debt") {
      return { debt: [{ symbol: "USDC", amount_human: "40", usd: 40 }] };
    }
    if (tool === "vanna_can_borrow") {
      return { allowed: true, max_borrow_human: "250", symbol: args.symbol ?? "USDC" };
    }
    if (tool === "vanna_can_withdraw") {
      return { allowed: true, max_withdraw_human: "80", symbol: args.symbol ?? "USDC" };
    }
    if (tool === "vanna_list_protocol_addresses") {
      return { note: "mock protocol addresses", addresses: {} };
    }
    if (tool === "vanna_resolve_account") {
      return { smart_account: null, found: false };
    }
    if (tool === "vanna_get_vtoken_balance") {
      return { balance_human: "50", symbol: args.symbol ?? "USDC" };
    }
    if (tool === "vanna_get_inactive_accounts") {
      return { accounts: [], count: 0 };
    }
    // write-shaped mock (unused for execution path)
    return { unsigned_xdr: `AAAA...MOCK_XDR::${tool}`, is_write: true };
  }
}

// ── legacy → consolidated tool translation ──────────────────────────────────

/**
 * The MCP server consolidated its ~42 fine-grained tools into 14 dispatchers, each
 * taking `{ action, kwargs }`. Calling `vanna_get_price` now returns
 * "Unknown tool: vanna_get_price", which broke every read and write at once.
 *
 * The `kwargs` payload is byte-for-byte the old argument object, so translating at
 * the transport boundary restores everything without touching the router, arg
 * builders, `explain.ts` (keyed on these names), or the tool labels the UI shows as
 * MCP proof. Callers keep using the legacy names; new-style names pass through
 * untouched, so `vanna_swap` and the LP/Blend write actions can be wired directly.
 */
const LEGACY_TOOL_MAP: Record<string, { tool: string; action: string }> = {
  // oracle
  vanna_get_price: { tool: "vanna_oracle", action: "get_price" },
  vanna_get_prices: { tool: "vanna_oracle", action: "get_prices_batch" },
  vanna_get_prices_batch: { tool: "vanna_oracle", action: "get_prices_batch" },
  // protocol info
  vanna_list_protocol_addresses: { tool: "vanna_protocol_info", action: "list_addresses" },
  vanna_get_collateral_config: { tool: "vanna_protocol_info", action: "collateral_config" },
  // margin account lifecycle
  vanna_open_account: { tool: "vanna_account", action: "open" },
  vanna_close_account: { tool: "vanna_account", action: "close" },
  vanna_get_inactive_accounts: { tool: "vanna_account", action: "list_inactive" },
  // margin reads
  vanna_get_account_health: { tool: "vanna_margin_status", action: "health" },
  vanna_get_collateral: { tool: "vanna_margin_status", action: "collateral" },
  vanna_get_debt: { tool: "vanna_margin_status", action: "debt" },
  vanna_get_max_borrow: { tool: "vanna_margin_status", action: "max_borrow" },
  // margin writes + preflights
  vanna_can_borrow: { tool: "vanna_margin_trade", action: "can_borrow" },
  vanna_can_withdraw: { tool: "vanna_margin_trade", action: "can_withdraw" },
  vanna_deposit_collateral: { tool: "vanna_margin_trade", action: "deposit" },
  vanna_withdraw_collateral: { tool: "vanna_margin_trade", action: "withdraw" },
  vanna_borrow: { tool: "vanna_margin_trade", action: "borrow" },
  vanna_repay: { tool: "vanna_margin_trade", action: "repay" },
  vanna_deposit_and_borrow: { tool: "vanna_margin_trade", action: "deposit_and_borrow" },
  vanna_settle_account: { tool: "vanna_margin_trade", action: "settle" },
  // earn
  vanna_get_pool_stats: { tool: "vanna_earn_market", action: "pool_stats" },
  vanna_get_vtoken_exchange_rate: { tool: "vanna_earn_market", action: "exchange_rate" },
  vanna_get_vtoken_balance: { tool: "vanna_earn_position", action: "balance" },
  vanna_lend: { tool: "vanna_earn_write", action: "lend" },
  vanna_redeem: { tool: "vanna_earn_write", action: "redeem" },
  // farm
  vanna_get_farm_overview: { tool: "vanna_farm_overview", action: "overview" },
  vanna_get_blend_reserve_stats: { tool: "vanna_farm_blend", action: "reserve_stats" },
  vanna_list_blend_reserves: { tool: "vanna_farm_blend", action: "list_reserves" },
  vanna_get_blend_position: { tool: "vanna_farm_blend", action: "position" },
  // Farm Blend writes — legacy names → consolidated farm_blend dispatcher.
  // Plain supply (FW1) uses action=supply; leveraged entry uses action=deploy.
  vanna_deploy_to_blend: { tool: "vanna_farm_blend", action: "deploy" },
  vanna_blend_supply: { tool: "vanna_farm_blend", action: "supply" },
  vanna_blend_withdraw: { tool: "vanna_farm_blend", action: "withdraw" },
  vanna_list_aquarius_pools: { tool: "vanna_farm_lp", action: "list_aquarius" },
  vanna_get_aquarius_pool_stats: { tool: "vanna_farm_lp", action: "aquarius_stats" },
  vanna_get_farm_lp_position: { tool: "vanna_farm_lp", action: "lp_position" },
  vanna_get_lp_balance: { tool: "vanna_farm_lp", action: "get_lp_balance" },
  vanna_add_liquidity: { tool: "vanna_farm_lp", action: "add_liquidity" },
  vanna_remove_liquidity: { tool: "vanna_farm_lp", action: "remove_liquidity" },
  // DEX swap via margin account
  vanna_swap: { tool: "vanna_swap", action: "swap" },
  // wallet identity / balances
  vanna_get_wallet_balance: { tool: "vanna_wallet", action: "balance" },
  vanna_get_token_balance: { tool: "vanna_wallet", action: "token_balance" },
  vanna_list_my_wallet_bindings: { tool: "vanna_wallet", action: "list_bindings" },
  vanna_list_smart_accounts: { tool: "vanna_wallet", action: "list_smart_accounts" },
  vanna_resolve_account: { tool: "vanna_wallet", action: "resolve" },
  // signing
  vanna_enable_auto_sign: { tool: "vanna_sign", action: "enable_auto_sign" },
  vanna_disable_auto_sign: { tool: "vanna_sign", action: "disable_auto_sign" },
  vanna_sign_and_submit: { tool: "vanna_sign", action: "sign_and_submit" },
};

/** Legacy call → the consolidated `{ name, arguments }` the server now expects. */
export function toServerCall(
  tool: string,
  args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } {
  const mapped = LEGACY_TOOL_MAP[tool];
  if (!mapped) return { name: tool, arguments: args };
  return { name: mapped.tool, arguments: { action: mapped.action, kwargs: args } };
}

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * Where a bearer token comes from. Two implementations:
 *
 *   M2M      — the app's own client_credentials token. Fine for reads; its `sub`
 *              is the client id, so it cannot prove WHO is asking.
 *   end user — a Connect OAuth token with `aud` = the MCP resource URI and
 *              `sub` = user_…, bound to the request (see user-context.ts).
 *
 * `key` identifies the credential so each one gets its own cached MCP session —
 * a Streamable-HTTP session is opened under a specific bearer and must not be
 * shared across identities.
 */
interface TokenSource {
  key: string;
  getToken(): Promise<string>;
  /** Called after a 401 so a cached token is not retried forever. */
  invalidate(): void;
  /**
   * Identifies the CREDENTIAL MATERIAL, as `key` identifies the identity.
   *
   * The two differ for end users and that difference caused a live bug: clients
   * are cached by `key` (`user:<sub>`), which is stable across a token refresh,
   * so a cached client happily kept serving the access token it was constructed
   * with. Half an hour in, every write 401'd with "Token has expired" even
   * though the request had just refreshed the cookie. liveClientFor now compares
   * fingerprints and adopts the newer credential.
   *
   * Hashed rather than the raw token so it is safe to log or diff.
   */
  fingerprint(): string;
}

const TIMEOUT_MS = 90_000;
const EXPIRY_MARGIN_MS = 60_000;

class M2MTokenSource implements TokenSource {
  readonly key = "m2m";
  private token: string | null = null;
  private tokenExpiry = 0;
  private tokenPromise: Promise<string> | null = null;

  invalidate(): void {
    this.token = null;
    this.tokenExpiry = 0;
  }

  /**
   * Constant. This source is a long-lived singleton that mints and rotates its
   * own token in place, so the client holding it never needs replacing — which
   * is exactly why reads never hit the expiry bug that writes did.
   */
  fingerprint(): string {
    return "m2m";
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      const { workosClientId, workosClientSecret, workosTokenUrl } = copilotConfig;
      if (!workosClientId || !workosClientSecret) {
        throw new MCPAuthError(
          "Missing WORKOS_M2M_CLIENT_ID / WORKOS_M2M_CLIENT_SECRET. Add them to .env.local.",
        );
      }
      const res = await fetch(workosTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: workosClientId,
          client_secret: workosClientSecret,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new MCPAuthError(`WorkOS token endpoint returned ${res.status}: ${text.slice(0, 300)}`);
      }
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) {
        throw new MCPAuthError("WorkOS token response missing access_token");
      }
      const ttlMs = (body.expires_in ?? 300) * 1000;
      this.token = body.access_token;
      this.tokenExpiry = Date.now() + Math.max(ttlMs - EXPIRY_MARGIN_MS, 0);
      return this.token;
    })().finally(() => {
      this.tokenPromise = null;
    });

    return this.tokenPromise;
  }
}

// There was a second TokenSource here — one built per request from the signed-in
// user's own token, which became the bearer. It is gone on purpose: an end-user
// token is now sent as X-Vanna-User-Assertion beside the M2M bearer (see
// RoutingMCPClient), so there is exactly one credential minting tokens for the
// transport and nothing to cache per user.

// ── live ────────────────────────────────────────────────────────────────────

class LiveMCPClient implements MCPClient {
  /** Cached Streamable-HTTP session — see getSession. */
  private sessionId: string | null = null;
  private sessionPromise: Promise<string> | null = null;
  /** Writes (sign/sim) often exceed 30s on testnet under load. */
  private static readonly TIMEOUT_MS = TIMEOUT_MS;

  constructor(private tokens: TokenSource) {}

  /**
   * Adopt a refreshed credential for the same identity.
   *
   * The MCP session is deliberately KEPT. Sessions are not bound to a specific
   * bearer — the M2M source has always rotated its token every few minutes
   * behind a stable session id in production — so re-handshaking on every
   * refresh would cost three extra round-trips for nothing. If that assumption
   * ever stops holding, the 401 path in RoutingMCPClient evicts the client and
   * rebuilds it from scratch, so the failure is self-correcting rather than
   * sticky.
   */
  useTokens(next: TokenSource): void {
    if (next.key !== this.tokens.key) return; // different identity — not ours to adopt
    if (next.fingerprint() === this.tokens.fingerprint()) return;
    this.tokens = next;
  }

  private async getToken(): Promise<string> {
    return this.tokens.getToken();
  }

  /**
   * Open a Streamable-HTTP session and cache it on the instance.
   *
   * Previously every tool call did initialize → notifications/initialized →
   * tools/call, so a turn that touches four pools cost twelve round-trips instead
   * of four. The client is already a process-wide singleton caching the WorkOS
   * token, so the session id caches the same way; `call` drops it and retries once
   * if the server has expired it. Concurrent callers share one in-flight handshake
   * rather than racing to open several sessions.
   */
  private async getSession(baseHeaders: Record<string, string>): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = (async () => {
      let initRes: Response;
      try {
        initRes = await fetch(copilotConfig.mcpBaseUrl, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "vanna-copilot-next", version: "1.0.0" },
            },
          }),
          signal: AbortSignal.timeout(LiveMCPClient.TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/abort|timeout/i.test(msg)) {
          throw new MCPCallError(
            `MCP initialize timed out after ${LiveMCPClient.TIMEOUT_MS / 1000}s — MCP may be cold. Retry.`,
          );
        }
        throw new MCPCallError(
          `MCP initialize network error: could not reach MCP (${msg}). Check MCP_BASE_URL and connectivity.`,
        );
      }
      if (!initRes.ok) {
        const text = await initRes.text().catch(() => "");
        if (initRes.status === 401 || initRes.status === 403) {
          throw new MCPAuthError(`MCP rejected the token (${initRes.status}): ${text.slice(0, 300)}`);
        }
        throw new MCPCallError(`MCP initialize failed (${initRes.status}): ${text.slice(0, 300)}`);
      }
      const id = initRes.headers.get("mcp-session-id");
      await consumeSseJson(initRes); // drain initialize result
      if (!id) throw new MCPCallError("MCP initialize response missing mcp-session-id header");

      // Required by Streamable HTTP after initialize.
      await fetch(copilotConfig.mcpBaseUrl, {
        method: "POST",
        headers: { ...baseHeaders, "mcp-session-id": id },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: AbortSignal.timeout(LiveMCPClient.TIMEOUT_MS),
        cache: "no-store",
      }).catch(() => {
        /* non-fatal */
      });

      this.sessionId = id;
      return id;
    })().finally(() => {
      this.sessionPromise = null;
    });

    return this.sessionPromise;
  }

  /** Drop the cached session so the next call re-handshakes. */
  private resetSession(): void {
    this.sessionId = null;
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    _userId?: string,
    retryOnStaleSession = true,
  ): Promise<Record<string, unknown>> {
    const token = await this.getToken();
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // The handshake is deliberately assertion-free: the MCP session belongs to
    // this app's credential and is shared by every caller, so attaching one
    // user's token to it would be misleading in MCP's logs and would tie a
    // per-request identity to a process-lifetime object.
    const sessionId = await this.getSession(baseHeaders);
    const sessionHeaders: Record<string, string> = {
      ...baseHeaders,
      "mcp-session-id": sessionId,
    };

    // Who is asking, when anyone is. Sent ALONGSIDE the bearer, never instead of
    // it: the bearer says which application is calling (M2M, verified by the MCP)
    // and this says which person it is calling for (verified by the Sign Service,
    // which is the only place that may authorize a signature). Conflating the two
    // is what made the MCP forward its own machine token as a user assertion and
    // earn a 401 on every auto-sign.
    const user = callNeedsUserToken(tool) ? currentUser() : null;
    if (user) {
      sessionHeaders["X-Vanna-User-Assertion"] = user.accessToken;
    }

    let callRes: Response;
    try {
      callRes = await fetch(copilotConfig.mcpBaseUrl, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: toServerCall(tool, args),
        }),
        signal: AbortSignal.timeout(LiveMCPClient.TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort|timeout/i.test(msg)) {
        throw new MCPCallError(
          `MCP call '${tool}' timed out after ${LiveMCPClient.TIMEOUT_MS / 1000}s — server may be cold or overloaded. Retry.`,
        );
      }
      throw new MCPCallError(
        `MCP call '${tool}' network error: could not reach ${copilotConfig.mcpBaseUrl.slice(0, 48)}… (${msg})`,
      );
    }
    if (!callRes.ok) {
      const text = await callRes.text().catch(() => "");
      if (callRes.status === 401 || callRes.status === 403) {
        // Force token refresh next time.
        this.tokens.invalidate();
        this.resetSession(); // the session was opened with the rejected token
        throw new MCPAuthError(`MCP rejected the token (${callRes.status}): ${text.slice(0, 300)}`);
      }
      // A cached session the server has since dropped: 404 (unknown session) or a
      // 400 naming the session. Re-handshake once and replay — invisible to callers.
      const staleSession =
        callRes.status === 404 || (callRes.status === 400 && /session/i.test(text));
      if (staleSession && retryOnStaleSession) {
        this.resetSession();
        return this.call(tool, args, _userId, false);
      }
      throw new MCPCallError(`MCP call '${tool}' failed (${callRes.status}): ${text.slice(0, 300)}`);
    }

    const payload = await consumeSseJson(callRes);
    if (payload?.error) {
      throw new MCPCallError(
        `MCP call '${tool}' error: ${payload.error.message ?? JSON.stringify(payload.error).slice(0, 300)}`,
      );
    }
    const result = payload?.result;
    if (!result) {
      throw new MCPCallError(`MCP call '${tool}' returned empty result`);
    }
    if (result.isError) {
      const msg = extractText(result).slice(0, 300);
      throw new MCPCallError(`MCP tool '${tool}' reported an error: ${msg}`);
    }
    return shapeToolResult(result);
  }
}

// ── SSE / shaping helpers ───────────────────────────────────────────────────

async function consumeSseJson(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  // text/event-stream: last `data: {...}` wins
  let last: any = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      last = JSON.parse(raw);
    } catch {
      /* keep scanning */
    }
  }
  return last;
}

function extractText(result: any): string {
  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    if (typeof block?.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function shapeToolResult(result: any): Record<string, unknown> {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = extractText(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

// ── factory ─────────────────────────────────────────────────────────────────

const m2mTokens = new M2MTokenSource();

/**
 * One live client per credential, so each keeps its own MCP session.
 *
 * Bounded: a busy deploy would otherwise accumulate one entry per user who has
 * ever signed in, each holding a session id. Eviction is oldest-first, and the
 * only cost of evicting is one extra handshake on that user's next write.
 */
const MAX_CLIENTS = 128;
const liveClients = new Map<string, LiveMCPClient>();

function liveClientFor(tokens: TokenSource): LiveMCPClient {
  const existing = liveClients.get(tokens.key);
  if (existing) {
    // Refresh LRU position.
    liveClients.delete(tokens.key);
    liveClients.set(tokens.key, existing);
    // Hand it the credential from THIS request. Without this the cache key
    // (`user:<sub>`, stable across refreshes) pins the very first access token
    // for the life of the process, and every write starts failing "Token has
    // expired" about half an hour after sign-in.
    existing.useTokens(tokens);
    return existing;
  }
  const created = new LiveMCPClient(tokens);
  liveClients.set(tokens.key, created);
  while (liveClients.size > MAX_CLIENTS) {
    const oldest = liveClients.keys().next();
    if (oldest.done) break;
    // Never evict the shared M2M client — every signed-out read depends on it.
    if (oldest.value === m2mTokens.key) {
      const m2m = liveClients.get(m2mTokens.key)!;
      liveClients.delete(m2mTokens.key);
      liveClients.set(m2mTokens.key, m2m);
      continue;
    }
    liveClients.delete(oldest.value);
  }
  return created;
}

/**
 * Every call goes out on this app's M2M credential. Who it is FOR travels beside
 * it, as the `X-Vanna-User-Assertion` header that LiveMCPClient.call attaches
 * from the ambient identity (see user-context.ts).
 *
 * A write with no signed-in user still goes out and still WORKS: the MCP builds
 * and simulates the transaction, auto-sign is refused for want of an assertion,
 * and the copilot falls back to wallet-sign. Being signed in is what upgrades
 * that to auto-sign.
 *
 * ## Why there is no longer a client per user
 *
 * This used to swap the BEARER for the end user's token, which forced one
 * LiveMCPClient (and one MCP session) per user, an LRU to bound them, and a
 * retry-with-eviction path because a bound token cannot be re-minted. All of
 * that existed to work around using one credential for two jobs. With identity
 * in a header the bearer is constant, so a single cached session serves everyone
 * and a token that expires mid-flight is the browser's problem to refresh, not a
 * cache-coherency problem here.
 */
class RoutingMCPClient implements MCPClient {
  async call(
    tool: string,
    args: Record<string, unknown>,
    userId?: string,
  ): Promise<Record<string, unknown>> {
    return liveClientFor(m2mTokens).call(tool, args, userId);
  }
}

let singleton: MCPClient | null = null;

export function getMcpClient(): MCPClient {
  if (!singleton) {
    singleton = copilotConfig.mcpMode === "live" ? new RoutingMCPClient() : new MockMCPClient();
  }
  return singleton;
}

/** Test helper / hot-reload safety */
export function resetMcpClient(): void {
  singleton = null;
  liveClients.clear();
  m2mTokens.invalidate();
}
