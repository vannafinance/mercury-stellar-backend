import type { CollateralPosition } from "@/lib/analytics/onchain/types";

/**
 * Map smart-account collateral symbols to analytics buckets (Margin Breakdown).
 * Keep in sync with on-chain symbols (Blend tracking, Aquarius / Soroswap LP).
 */
export function collateralPositionTypeForSymbol(symbol: string): CollateralPosition["type"] {
  const u = symbol.toUpperCase();
  if (u === "BLUSDC" || u === "BLEND_USDC" || u.startsWith("BLEND_")) return "aToken";
  if (
    u === "AQUSDC" ||
    u === "SOUSDC" ||
    u === "AQUARIUS_USDC" ||
    u === "SOROSWAP_USDC" ||
    u.startsWith("AQ_") ||
    u.startsWith("SS_")
  ) {
    return "lp";
  }
  if (u === "XLM" || u === "USDC") return "cash";
  return "unknown";
}
