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

// ── live ────────────────────────────────────────────────────────────────────

class LiveMCPClient implements MCPClient {
  private token: string | null = null;
  private tokenExpiry = 0;
  private tokenPromise: Promise<string> | null = null;
  private static readonly TIMEOUT_MS = 30_000;
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

  async call(tool: string, args: Record<string, unknown>, _userId?: string): Promise<Record<string, unknown>> {
    const token = await this.getToken();
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // One session per tool call keeps the client simple and avoids stale sessions.
    const initRes = await fetch(copilotConfig.mcpBaseUrl, {
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
    if (!initRes.ok) {
      const text = await initRes.text().catch(() => "");
      if (initRes.status === 401 || initRes.status === 403) {
        throw new MCPAuthError(`MCP rejected the token (${initRes.status}): ${text.slice(0, 300)}`);
      }
      throw new MCPCallError(`MCP initialize failed (${initRes.status}): ${text.slice(0, 300)}`);
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    await consumeSseJson(initRes); // drain initialize result
    if (!sessionId) {
      throw new MCPCallError("MCP initialize response missing mcp-session-id header");
    }

    const sessionHeaders = { ...baseHeaders, "mcp-session-id": sessionId };

    // Required by Streamable HTTP after initialize.
    await fetch(copilotConfig.mcpBaseUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(LiveMCPClient.TIMEOUT_MS),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });

    const callRes = await fetch(copilotConfig.mcpBaseUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(LiveMCPClient.TIMEOUT_MS),
      cache: "no-store",
    });
    if (!callRes.ok) {
      const text = await callRes.text().catch(() => "");
      if (callRes.status === 401 || callRes.status === 403) {
        // Force token refresh next time.
        this.token = null;
        this.tokenExpiry = 0;
        throw new MCPAuthError(`MCP rejected the token (${callRes.status}): ${text.slice(0, 300)}`);
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
