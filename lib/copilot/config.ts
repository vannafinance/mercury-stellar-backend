/**
 * Copilot brain settings — resolved from process env (.env.local in Next.js).
 * Server-only. Never import from client components.
 *
 * Production defaults for this app: Vertex (gemini-3.6-flash) + live MCP.
 */

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function envFloat(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const copilotConfig = {
  /** Always live for now (mock only if explicitly forced for unit tests). */
  get mcpMode(): "mock" | "live" {
    return env("MCP_MODE", "live").toLowerCase() === "mock" ? "mock" : "live";
  },
  get mcpBaseUrl(): string {
    return env("MCP_BASE_URL", "https://mcp.vanna.finance/mcp");
  },
  get workosClientId(): string {
    return env("WORKOS_M2M_CLIENT_ID");
  },
  get workosClientSecret(): string {
    return env("WORKOS_M2M_CLIENT_SECRET");
  },
  get workosTokenUrl(): string {
    return env(
      "WORKOS_M2M_TOKEN_URL",
      "https://sensitive-silk-47-staging.authkit.app/oauth2/token",
    );
  },

  /** Always Vertex for now. */
  get llmProvider(): string {
    return "vertex";
  },
  get googleCloudProject(): string {
    return env("GOOGLE_CLOUD_PROJECT", "vanna-mcp");
  },
  get googleCloudLocation(): string {
    // Must be exactly "global" for the multi-region host.
    return (env("GOOGLE_CLOUD_LOCATION", "global") || "global").trim();
  },
  get vertexModel(): string {
    return env("VERTEX_MODEL", "gemini-3.6-flash");
  },

  /**
   * Routing mechanism.
   *   "fc"   — native function calling: tool names and argument values are constrained
   *            by schema, so an invalid tool or a non-existent pool cannot be returned.
   *   "json" — the older path that pastes the tool catalogue into the prompt as prose.
   * "fc" degrades to "json" by itself if the endpoint rejects the schema, so this only
   * needs setting to pin the old behaviour deliberately.
   */
  get router(): "fc" | "json" {
    return env("COPILOT_ROUTER", "fc").toLowerCase() === "json" ? "json" : "fc";
  },

  /**
   * Local risk env vars are NO LONGER enforced by the copilot.
   * Health factor, leverage, and spend caps are enforced by the MCP server
   * and the Sign Service auto-sign policy. Kept as optional informational defaults only.
   */
  get minHealthFactor(): number {
    return envFloat("MIN_HEALTH_FACTOR", 1.3);
  },
  get maxLeverage(): number {
    return envFloat("MAX_LEVERAGE", 10);
  },
  get maxPositionUsd(): number {
    return envFloat("MAX_POSITION_USD", 50_000);
  },
  get readsOnly(): boolean {
    return env("COPILOT_READS_ONLY", "false").toLowerCase() === "true";
  },
};

/**
 * Tools the MCP server exposes, shown in the health chip.
 *
 * 14 since the 2026-07-31 consolidation: oracle, protocol_info, account,
 * margin_status, margin_trade, earn_market, earn_position, earn_write,
 * farm_overview, farm_blend, farm_lp, swap, wallet, sign. Each dispatches on an
 * `action`, so the legacy fine-grained names are mapped in mcp-client.ts.
 * Verify with `tools/list` after an MCP redeploy.
 */
export const TEMPLATE_COUNT = 14;
