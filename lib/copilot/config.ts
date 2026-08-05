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

  // ── End-user login (Connect OAuth + resource indicator) ───────────────────
  //
  // Why this exists alongside the M2M block above: an M2M token's `sub` is the
  // CLIENT id, one value shared by every user of this app. The Sign Service now
  // refuses it as a user assertion (it must start with `user_`), so auto-sign
  // needs a token minted by an actual end-user login. Requesting `resource` on
  // that login is what makes the token's `aud` the MCP's resource URI, which is
  // the audience both the MCP and the Sign Service already verify against.
  //
  // Unset → no login button, reads still work on M2M, and writes fall back to
  // wallet-sign exactly as they do today. Nothing breaks by not configuring it.

  /** AuthKit issuer, e.g. https://your-project.authkit.app (no trailing slash). */
  get workosIssuer(): string {
    const explicit = env("WORKOS_ISSUER").replace(/\/$/, "");
    if (explicit) return explicit;
    // Derive from the M2M token URL so a single-tenant deploy needs one less var.
    return this.workosTokenUrl.replace(/\/oauth2\/token\/?$/, "").replace(/\/$/, "");
  },
  get workosAuthorizeUrl(): string {
    return env("WORKOS_AUTHORIZE_URL") || `${this.workosIssuer}/oauth2/authorize`;
  },
  get workosUserTokenUrl(): string {
    return env("WORKOS_USER_TOKEN_URL") || `${this.workosIssuer}/oauth2/token`;
  },
  /** Connect OAuth client id (the end-user app client, NOT the M2M client). */
  get workosClientIdUser(): string {
    return env("WORKOS_CLIENT_ID");
  },
  /**
   * WorkOS **environment** client id — Developer → API Keys. Staging is
   * `client_01KX5H81JH2HWD2DHKYFYFXNS2`.
   *
   * This is what actually lands in `aud` on a hand-created Connect OAuth token:
   * not the Connect app's own client id, but the environment's. Observed live —
   * the token came back with `aud = client_01KX5H81…` while the Connect app is
   * `client_01KZ6ZZQK…`.
   *
   * ⚠️ It is also the audience the **M2M** token carries (see
   * AUTOSIGN_AUDIENCE_BLOCKER.md §1). Both credentials in this environment are
   * minted for the same audience, so `aud` cannot tell them apart — only `sub`
   * can (`user_…` vs `client_…`). That is exactly what the Sign Service's
   * subject guard checks, and with this audience accepted, that guard is the
   * ONLY thing separating an end user from the machine credential. Do not
   * weaken it.
   */
  get workosEnvClientId(): string {
    return env("WORKOS_ENV_CLIENT_ID");
  },
  /** Client secret for the authorization-code exchange (confidential client). */
  get workosClientSecretUser(): string {
    return env("WORKOS_CLIENT_SECRET");
  },
  /**
   * RFC 8707 resource indicator. Defaults to mcpBaseUrl so the token's `aud` and
   * the server being called can never drift apart by forgetting one of two vars.
   *
   * Only sent when mcpSendResource is on — see that getter for why it is not.
   */
  get mcpResource(): string {
    return env("MCP_RESOURCE") || this.mcpBaseUrl;
  },
  /**
   * Send `resource` on authorize / token / refresh? **Default off.**
   *
   * A hand-created Connect OAuth application — one made in the WorkOS Dashboard,
   * "Managed by you", confidential — rejects an explicit `resource` on the token
   * endpoint with RFC 8707 `invalid_target`, **even when that exact URI is
   * registered as the Default Resource Indicator**. Per WorkOS, the default
   * applies only to DCR/CIMD clients; hand-created OAuth and M2M Connect apps
   * never use it, and in practice they 400 when it is sent.
   *
   * Observed: authorize succeeded and returned a code; the exchange came back
   * `400 invalid_target`, so login never completed.
   *
   * What a hand-created Connect OAuth client mints instead:
   *
   *     aud = <this app's client_id>     (NOT the MCP resource URI)
   *     sub = user_…                     (a real per-user subject — the part that matters)
   *
   * That is still a correct end-user token. The `sub` is what closes the F3 hole
   * and what bindings key on; the `aud` is just which client it was minted for.
   * So the fix is to accept that audience on the verifying side rather than to
   * force a parameter this client type refuses — see .env.example for the
   * WORKOS_AUDIENCE value the Sign Service needs.
   *
   * Turn this ON if the Copilot is ever re-registered as a DCR/CIMD client, which
   * would then mint aud = the MCP resource URI.
   */
  get mcpSendResource(): boolean {
    const v = env("MCP_SEND_RESOURCE", "false").toLowerCase();
    return v === "true" || v === "1" || v === "on" || v === "yes";
  },
  /**
   * Fixed redirect URI. Must match a redirect registered in the WorkOS dashboard.
   * Leave unset to derive it from the incoming request origin (fine for local dev
   * and single-domain deploys; set it explicitly behind a proxy that rewrites Host).
   */
  get authRedirectUri(): string {
    return env("COPILOT_AUTH_REDIRECT_URI");
  },
  /** Secret for the encrypted session cookie. Required for login to be enabled. */
  get sessionSecret(): string {
    return env("COPILOT_SESSION_SECRET");
  },
  /** True when end-user login is fully configured. */
  get userLoginEnabled(): boolean {
    return !!(this.workosClientIdUser && this.workosClientSecretUser && this.sessionSecret);
  },

  // ── End-user identity from Privy (the default path) ───────────────────────
  //
  // The user signs in with Privy to get a wallet; that same session is what
  // proves who they are on the money path. Its access token carries
  // iss=privy.io / sub=did:privy:… / aud=<app id>, which is everything the Sign
  // Service's assertion verifier needs — so there is no second login.
  //
  // The WorkOS block above still works and is still accepted as an assertion;
  // it is simply no longer the only way to be a user. Reads and the MCP
  // transport keep using the M2M credential either way: WorkOS remains the
  // machine identity, Privy is the human one.

  /** Privy app id. Public by design — it is the token audience, not a secret. */
  get privyAppId(): string {
    return env("NEXT_PUBLIC_PRIVY_APP_ID");
  },
  /**
   * Where to fetch Privy's signing keys. Derived from the app id so a deploy
   * cannot end up verifying tokens against a different app's keys by forgetting
   * to update one of two vars.
   */
  get privyJwksUri(): string {
    return (
      env("PRIVY_JWKS_URI") ||
      `https://auth.privy.io/api/v1/apps/${this.privyAppId}/jwks.json`
    );
  },
  /** True when a Privy session can be used as the end-user assertion. */
  get privyIdentityEnabled(): boolean {
    return !!this.privyAppId;
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
   * Fallback models when primary Vertex model returns 404/unavailable.
   * Comma-separated env VERTEX_MODEL_FALLBACKS or built-in list.
   */
  get vertexModelFallbacks(): string[] {
    const raw = env(
      "VERTEX_MODEL_FALLBACKS",
      "gemini-2.5-flash,gemini-2.0-flash-001,gemini-2.0-flash",
    );
    const primary = this.vertexModel;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((m) => m && m !== primary);
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

  /**
   * Max atomic legs MultiLegAgent will expand/execute per turn.
   * Caps latency and blast radius on free-form plans.
   */
  get multiLegMaxLegs(): number {
    const n = Math.floor(envFloat("COPILOT_MULTI_LEG_MAX", 8));
    return n >= 1 && n <= 12 ? n : 8;
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
