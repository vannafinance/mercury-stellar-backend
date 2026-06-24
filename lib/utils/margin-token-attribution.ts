/**
 * Split margin-account token balances into borrow proceeds vs own deposit.
 * Farm deployments consume borrow proceeds first (then own collateral).
 */

export type MarginTokenBuckets = {
  /** Outstanding debt for this asset */
  borrowedAmount: number;
  /** User equity = total assets − debt */
  ownDepositAmount: number;
  /** raw free + farm deployed */
  totalAssets: number;
  rawFree: number;
  farmDeployed: number;
  /** Borrow still in wallet (not yet in farm) */
  borrowedFree: number;
  /** Own deposit still in wallet */
  ownFree: number;
  /** Borrow proceeds deployed to farm (allocated first) */
  borrowedInFarm: number;
  /** Own deposit deployed to farm */
  ownInFarm: number;
};

export function computeMarginTokenBuckets(
  rawFree: number,
  farmDeployed: number,
  borrowedAmount: number,
): MarginTokenBuckets {
  const safeRaw = Math.max(0, rawFree);
  const safeFarm = Math.max(0, farmDeployed);
  const safeBorrow = Math.max(0, borrowedAmount);
  const totalAssets = safeRaw + safeFarm;
  const ownDepositAmount = Math.max(0, totalAssets - safeBorrow);

  const borrowedInFarm = Math.min(safeFarm, safeBorrow);
  const ownInFarm = Math.max(0, safeFarm - borrowedInFarm);
  const borrowedRemaining = Math.max(0, safeBorrow - borrowedInFarm);
  const borrowedFree = Math.min(safeRaw, borrowedRemaining);
  const ownFree = Math.max(0, safeRaw - borrowedFree);

  return {
    borrowedAmount: safeBorrow,
    ownDepositAmount,
    totalAssets,
    rawFree: safeRaw,
    farmDeployed: safeFarm,
    borrowedFree,
    ownFree,
    borrowedInFarm,
    ownInFarm,
  };
}

/** How a new deposit from the wallet is attributed (borrow in wallet first). */
export function attributeFarmDeposit(
  rawFree: number,
  farmDeployed: number,
  borrowedAmount: number,
  depositAmount: number,
): { fromBorrow: number; fromOwn: number } {
  const amt = Math.max(0, depositAmount);
  if (amt <= 0) return { fromBorrow: 0, fromOwn: 0 };

  const buckets = computeMarginTokenBuckets(rawFree, farmDeployed, borrowedAmount);
  const fromBorrow = Math.min(amt, buckets.borrowedFree);
  const fromOwn = Math.max(0, amt - fromBorrow);
  return { fromBorrow, fromOwn };
}

const TRACKING_TO_UNDERLYING: Record<string, string> = {
  BLEND_XLM: "XLM",
  BLEND_USDC: "BLUSDC",
  AQ_XLM_USDC: "XLM",
  SS_XLM_USDC: "XLM",
};

export function trackingSymbolToUnderlying(symbol: string): string | null {
  const u = symbol.toUpperCase();
  if (TRACKING_TO_UNDERLYING[u]) return TRACKING_TO_UNDERLYING[u];
  if (u.startsWith("BLEND_")) {
    const tail = u.replace("BLEND_", "");
    return tail === "USDC" ? "BLUSDC" : tail;
  }
  return null;
}

export function isFarmTrackingSymbol(symbol: string): boolean {
  const u = symbol.toUpperCase();
  return (
    u.startsWith("BLEND_") ||
    u.startsWith("AQ_") ||
    u.startsWith("SS_") ||
    u.endsWith("_LP")
  );
}
