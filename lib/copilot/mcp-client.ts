/**
 * In-process MCP client for the Vanna Finance MCP server.
 *
 * Auth: WorkOS M2M (client_credentials) → Bearer JWT.
 * Transport: Streamable HTTP (POST + SSE `event: message` frames + mcp-session-id).
 *
 * Mock mode returns canned numbers so the copilot works offline.
 */

import { copilotConfig } from "./config";

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

// ── live ────────────────────────────────────────────────────────────────────

class LiveMCPClient implements MCPClient {
  private token: string | null = null;
  private tokenExpiry = 0;
  private tokenPromise: Promise<string> | null = null;
  /** Cached Streamable-HTTP session — see getSession. */
  private sessionId: string | null = null;
  private sessionPromise: Promise<string> | null = null;
  /** Writes (sign/sim) often exceed 30s on testnet under load. */
  private static readonly TIMEOUT_MS = 90_000;
  private static readonly EXPIRY_MARGIN_MS = 60_000;

  private async getToken(): Promise<string> {
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
        signal: AbortSignal.timeout(LiveMCPClient.TIMEOUT_MS),
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
      this.tokenExpiry = Date.now() + Math.max(ttlMs - LiveMCPClient.EXPIRY_MARGIN_MS, 0);
      return this.token;
    })().finally(() => {
      this.tokenPromise = null;
    });

    return this.tokenPromise;
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

    const sessionId = await this.getSession(baseHeaders);
    const sessionHeaders = { ...baseHeaders, "mcp-session-id": sessionId };

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
        this.token = null;
        this.tokenExpiry = 0;
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

let singleton: MCPClient | null = null;

export function getMcpClient(): MCPClient {
  if (!singleton) {
    singleton = copilotConfig.mcpMode === "live" ? new LiveMCPClient() : new MockMCPClient();
  }
  return singleton;
}

/** Test helper / hot-reload safety */
export function resetMcpClient(): void {
  singleton = null;
}
