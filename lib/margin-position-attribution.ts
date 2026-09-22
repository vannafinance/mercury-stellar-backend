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
 * Pure: pass the same Mercury history the Position History tab uses (Mercury
 * indexes Trader_Deposit alongside Trader_Borrow/Trader_Repay_Event, so this
 * works whenever deposit+borrow were submitted as one atomic transaction).
 * Debt opened via separate transactions — or before Mercury had a record of
 * this account — has no shared hash to join on, so it comes back empty for
 * that borrow; the caller's fallback then shows it as portfolio-wide
 * (cross-collateral) rather than guessing which deposit opened it.
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

/** Net cash borrowed per asset: Σ borrow − Σ repay, derived only from chain events. */
export function buildNetBorrowCashByToken(
  history: AttributionHistoryEntry[],
): Map<string, number> {
  const netByToken = new Map<string, number>();
  for (const entry of history) {
    if (entry.type !== "borrow" && entry.type !== "repay") continue;
    const amount = parseFloat(entry.amount || "0");
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const token = canonicalToken(entry.asset);
    const signed = entry.type === "borrow" ? amount : -amount;
    netByToken.set(token, (netByToken.get(token) ?? 0) + signed);
  }
  return netByToken;
}

/**
 * Interest accrued till date = current on-chain debt + repayments − borrows.
 * Returns null when the original borrow history is unavailable so the UI does
 * not mislabel the entire live debt as interest.
 */
export function calculateAccruedBorrowInterest(
  currentDebt: number,
  netBorrowCash: number | undefined,
): number | null {
  if (netBorrowCash === undefined || !Number.isFinite(currentDebt)) return null;
  return Math.max(0, currentDebt - netBorrowCash);
}

export { canonicalToken as canonicalMarginPositionToken };
