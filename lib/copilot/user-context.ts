/**
 * Per-request end-user identity, bound ambiently.
 *
 * ## Why AsyncLocalStorage instead of a parameter
 *
 * `getMcpClient()` is called from ~15 places across handle.ts, and every write
 * path bottoms out in `mcp.call(tool, args, userId)` where `userId` is the wallet
 * G-address, not a WorkOS subject. Threading a token through all of them would
 * touch every call site and — the part that actually matters — a NEW write tool
 * added later would silently default to the M2M credential and fail auto-sign in
 * exactly the way that took a week to diagnose the first time.
 *
 * Binding the identity to the request instead means the transport decides, once,
 * which credential a call goes out with. Any future tool is covered by default.
 *
 * ## Lifetime
 *
 * The route handler refreshes the token if needed and binds it for the whole
 * request BEFORE calling into the copilot, so nothing inside has to think about
 * expiry. A long multi-leg turn can still outlive a 30-minute token mid-flight;
 * that case is handled on the other side, by session-scoped signing in the Sign
 * Service (PHASE3_TOKEN_REFRESH_BLOCKER.md §4), not by refreshing here.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface BoundUser {
  /**
   * The subject the Sign Service will key bindings on: `did:privy:…` for a Privy
   * session (the default path), `user_…` for a WorkOS Connect OAuth login.
   */
  sub: string;
  email?: string;
  /**
   * The end-user's own token. Forwarded to the MCP as `X-Vanna-User-Assertion`,
   * NEVER as the bearer — the bearer stays the app's M2M credential, because the
   * two answer different questions ("which app is calling" vs "who is asking").
   */
  accessToken: string;
  /** Which identity system minted `accessToken`. Diagnostics only. */
  kind: "privy" | "workos";
}

const storage = new AsyncLocalStorage<BoundUser>();

/** Run `fn` with `user` bound as the ambient end-user identity. */
export function withBoundUser<T>(user: BoundUser | null, fn: () => T): T {
  if (!user) return fn();
  return storage.run(user, fn);
}

/** The end-user bound to the current request, or null when signed out. */
export function currentUser(): BoundUser | null {
  return storage.getStore() ?? null;
}

/**
 * Tools that only READ. Everything else is treated as a write and gets the
 * end-user token when one is available.
 *
 * The list is deliberately an allowlist of reads rather than a denylist of
 * writes: an unrecognised tool then defaults to the STRONGER credential. Getting
 * that backwards is how a new write tool would quietly regress to M2M and fail
 * auto-sign with a 401 that points nowhere.
 *
 * Names are the consolidated dispatchers (post-2026-07-31) plus the legacy names
 * mcp-client.ts still accepts, because callers use both.
 */
const READ_ONLY_TOOLS = new Set<string>([
  // consolidated dispatchers that are purely informational
  "vanna_oracle",
  "vanna_protocol_info",
  "vanna_margin_status",
  "vanna_earn_market",
  "vanna_earn_position",
  "vanna_farm_overview",
  // legacy fine-grained read names
  "vanna_get_price",
  "vanna_get_prices",
  "vanna_get_prices_batch",
  "vanna_list_protocol_addresses",
  "vanna_get_collateral_config",
  "vanna_get_account_health",
  "vanna_get_collateral",
  "vanna_get_debt",
  "vanna_get_max_borrow",
  "vanna_can_borrow",
  "vanna_can_withdraw",
  "vanna_get_pool_stats",
  "vanna_get_vtoken_exchange_rate",
  "vanna_get_vtoken_balance",
  "vanna_get_farm_overview",
  "vanna_get_blend_reserve_stats",
  "vanna_list_blend_reserves",
  "vanna_get_blend_position",
  "vanna_list_aquarius_pools",
  "vanna_get_aquarius_pool_stats",
  "vanna_get_farm_lp_position",
  "vanna_get_lp_balance",
  "vanna_get_inactive_accounts",
  "vanna_get_wallet_balance",
  "vanna_get_token_balance",
  "vanna_list_my_wallet_bindings",
  "vanna_list_smart_accounts",
  "vanna_resolve_account",
]);

/**
 * Should this call carry the end-user token?
 *
 * Reads stay on the shared M2M credential: they need no user identity, they work
 * for signed-out visitors, and keeping them on one cached MCP session avoids a
 * per-user handshake for pure browsing.
 */
export function callNeedsUserToken(tool: string): boolean {
  return !READ_ONLY_TOOLS.has(tool);
}

/** Exposed for tests and for the health chip. */
export function readOnlyToolNames(): string[] {
  return [...READ_ONLY_TOOLS];
}
