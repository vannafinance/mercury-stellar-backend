/**
 * On-chain strings (token symbols, pool names, SEP-41 metadata) are attacker-controlled.
 * They must never be treated as instructions, and they must not be long enough to
 * drown a turn. Same charset and cap as the fact-card `assetLabel` filter.
 *
 * Keep in lockstep with `vanna_mcp` `mcp_server/onchain_strings.py`.
 */

export const ONCHAIN_LABEL_MAX = 24;
export const UNTRUSTED_ONCHAIN_LABEL = "[untrusted]";

const ONCHAIN_LABEL_RE = /^[A-Za-z0-9_/-]{1,24}$/;
const STELLAR_ADDR_RE = /^[GC][A-Z0-9]{55}$/;
const LABEL_KEY =
  /^(symbol|name|pool_name|poolName|asset_code|assetCode|asset_symbol|vtoken_symbol|display_name|token_symbol)$/i;

export function isOnChainLabel(value: string): boolean {
  return ONCHAIN_LABEL_RE.test(value);
}

/** Strict symbol/name: keep XLM / BLUSDC / AQ_XLM_USDC; drop injection sentences. */
export function boundOnChainLabel(value: unknown): string {
  if (typeof value !== "string") return UNTRUSTED_ONCHAIN_LABEL;
  return isOnChainLabel(value) ? value : UNTRUSTED_ONCHAIN_LABEL;
}

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "");
}

/**
 * Walk a tool payload. Label keys are replaced when they are not a bounded
 * symbol. Other strings lose control characters and are clipped; G/C addresses
 * pass through.
 */
export function boundOnChainStrings(value: unknown, key = "", depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => boundOnChainStrings(item, key, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = boundOnChainStrings(v, k, depth + 1);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  if (STELLAR_ADDR_RE.test(value)) return value;
  if (LABEL_KEY.test(key)) return boundOnChainLabel(value);
  const cleaned = stripControls(value);
  return cleaned.length > 240 ? cleaned.slice(0, 240) : cleaned;
}
