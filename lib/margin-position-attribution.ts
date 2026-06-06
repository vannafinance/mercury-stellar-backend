import { getMarginHistoryByAccount } from "@/lib/margin-history";

const canonicalToken = (token: string): string => {
  const normalized = token.toUpperCase();
  if (normalized === "BLEND_USDC" || normalized === "USDC") return "BLUSDC";
  if (normalized === "AQUIRESUSDC" || normalized === "AQUARIUS_USDC") return "AQUSDC";
  if (normalized === "SOROSWAPUSDC" || normalized === "SOROSWAP_USDC") return "SOUSDC";
  return normalized;
};

export type BorrowAttribution = {
  /** Collateral canonical symbol → borrow canonical symbols opened against it. */
  borrowsByCollateral: Map<string, Set<string>>;
  /** `${collateral}:${borrow}` → principal borrowed in that atomic open. */
  principalByPair: Map<string, number>;
};

/**
 * Derive which borrows belong to which deposit-collateral row from local
 * margin history (deposit + borrow entries sharing the same tx hash).
 */
export function buildBorrowAttributionFromHistory(
  marginAccountAddress: string | null | undefined,
): BorrowAttribution {
  const borrowsByCollateral = new Map<string, Set<string>>();
  const principalByPair = new Map<string, number>();

  if (!marginAccountAddress) {
    return { borrowsByCollateral, principalByPair };
  }

  const history = getMarginHistoryByAccount(marginAccountAddress)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  const depositCollateralByHash = new Map<string, string>();

  for (const entry of history) {
    if (entry.type === "deposit" && entry.hash) {
      depositCollateralByHash.set(entry.hash, canonicalToken(entry.asset));
      continue;
    }

    if (entry.type !== "borrow" || !entry.hash) continue;

    const collateralCanonical = depositCollateralByHash.get(entry.hash);
    if (!collateralCanonical) continue;

    const borrowCanonical = canonicalToken(entry.asset);
    if (!borrowsByCollateral.has(collateralCanonical)) {
      borrowsByCollateral.set(collateralCanonical, new Set());
    }
    borrowsByCollateral.get(collateralCanonical)!.add(borrowCanonical);

    const pairKey = `${collateralCanonical}:${borrowCanonical}`;
    const amt = parseFloat(entry.amount || "0") || 0;
    if (amt > 0) {
      principalByPair.set(pairKey, (principalByPair.get(pairKey) ?? 0) + amt);
    }
  }

  return { borrowsByCollateral, principalByPair };
}

export { canonicalToken as canonicalMarginPositionToken };
