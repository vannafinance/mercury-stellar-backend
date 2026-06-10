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

/** Minimal shape this needs from a history entry. Mercury's MarginTxEntry
 *  (borrow|repay) is assignable; `type` is widened to string so a future
 *  `deposit` entry compiles without a cast. */
export interface AttributionHistoryEntry {
  type: string;
  asset: string;
  amount: string;
  hash: string;
}

/**
 * Derive which borrows belong to which deposit-collateral row by matching a
 * deposit and a borrow that share the same tx hash (an atomic cross-asset open).
 *
 * Pure: pass the same Mercury history the Position History tab uses. NOTE the
 * grouping is deposit-driven — Mercury currently indexes only borrow/repay (no
 * deposit events), so the returned maps are empty today and the caller falls
 * back to attaching all borrows to the largest collateral row. Multi-collateral
 * attribution lights up automatically once deposit events land in Mercury.
 */
export function buildBorrowAttributionFromHistory(
  history: AttributionHistoryEntry[],
): BorrowAttribution {
  const borrowsByCollateral = new Map<string, Set<string>>();
  const principalByPair = new Map<string, number>();

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
