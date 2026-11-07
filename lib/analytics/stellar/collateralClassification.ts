import type { CollateralPosition } from "@/lib/analytics/onchain/types";

/**
 * Map margin-account collateral symbols to analytics buckets (Margin Breakdown).
 * Credit layer (2026-11-06): plain token balances (XLM and the three USDC
 * variants) are cash; Blend supply rows (BLEND_*) are aTokens; the Soroswap
 * pair token (SS_*) and Aquarius share token (AQ_*) are LP.
 */
export function collateralPositionTypeForSymbol(symbol: string): CollateralPosition["type"] {
  const u = symbol.toUpperCase();
  if (u.startsWith("BLEND_")) return "aToken";
  if (u.startsWith("AQ_") || u.startsWith("SS_")) return "lp";
  if (
    u === "XLM" ||
    u === "USDC" ||
    u === "BLUSDC" ||
    u === "AQUSDC" ||
    u === "SOUSDC" ||
    u === "AQUARIUS_USDC" ||
    u === "SOROSWAP_USDC"
  ) {
    return "cash";
  }
  return "unknown";
}
