import { calcNetApr } from "./lite-position-math";
import { getCachedTokenPrice } from "@/lib/oracle-price";

/** Health bucket for a Lite position: healthy, near-threshold, or liquidatable. */
export type LitePositionStatus = "active" | "risky" | "liquidation";

/** A single leveraged-yield position as rendered across the Lite UI (list, detail, card). */
export interface LitePosition {
  id: string;
  poolId: string;
  poolLabel: string;
  protocol: string;
  poolVersion: string;
  /** 'single' = Blend lending pool; 'lp' = Soroswap/Aquarius AMM */
  poolType: "single" | "lp";
  poolTokens: string[];
  collateralAsset: string;
  collateralAmount: number;
  collateralUsd: number;
  borrowAsset: string;
  borrowAmount: number;
  borrowUsd: number;
  /** true when collateralAsset === borrowAsset (both tokens live in the pool) */
  isSameAsset: boolean;
  leverage: number;
  supplyApr: number;
  vannaFeeApr: number;
  netApr: number;
  earningsUsd: number;
  healthFactor: number;
  liquidationLtv: number;
  status: LitePositionStatus;
  openedAt: string;
}

/* ═══ Real position builder ══════════════════════════════════════════════
 *
 * Converts margin-account-info-store's borrowedBalances into LitePosition
 * rows. Called from lite-home.tsx when the user has an active margin account.
 */
const POOL_INFO: Record<string, { protocol: string; poolVersion: string; poolType: "single" | "lp"; tokens: string[]; supplyApr: number; vannaFeeApr: number; liquidationLtv: number }> = {
  XLM:  { protocol: "Blend",    poolVersion: "V1",  poolType: "single", tokens: ["XLM"],        supplyApr: 5.2,  vannaFeeApr: 3.5, liquidationLtv: 82 },
  USDC: { protocol: "Blend",    poolVersion: "V1",  poolType: "single", tokens: ["USDC"],       supplyApr: 8.1,  vannaFeeApr: 5.0, liquidationLtv: 86 },
  BLUSDC: { protocol: "Blend",  poolVersion: "V1",  poolType: "single", tokens: ["USDC"],       supplyApr: 8.1,  vannaFeeApr: 5.0, liquidationLtv: 86 },
};

// Replaced static map with the shared oracle cache: callers (lite-home.tsx)
// already trigger refresh via the margin store, so the cache is warm by the
// time this builder runs.

/**
 * Builds {@link LitePosition} rows from the margin store's on-chain
 * `borrowedBalances`, spreading the account's total collateral across each
 * borrow leg in proportion to its USD value. Each leg is treated as a same-asset
 * single-token Blend position; pool rates come from {@link POOL_INFO} (falling
 * back to XLM defaults) and collateral token amounts are derived from the shared
 * oracle price cache. Returns an empty array when there is no borrowed balance.
 */
export function buildRealPositions(
  borrowedBalances: Record<string, { amount: string; usdValue: string }>,
  totalCollateralValue: number,
  healthFactor: number
): LitePosition[] {
  const positions: LitePosition[] = [];
  const borrowEntries = Object.entries(borrowedBalances).filter(
    ([, b]) => Number(b.amount) > 0
  );
  if (borrowEntries.length === 0) return positions;

  // Spread collateral proportionally across borrow positions
  const totalBorrowUsd = borrowEntries.reduce(
    (s, [, b]) => s + Number(b.usdValue), 0
  );

  for (const [token, balance] of borrowEntries) {
    const borrowAmount = Number(balance.amount) || 0;
    const borrowUsd    = Number(balance.usdValue) || 0;
    if (borrowAmount <= 0) continue;

    // Proportional share of total collateral for this borrow leg
    const collateralUsd = totalBorrowUsd > 0
      ? totalCollateralValue * (borrowUsd / totalBorrowUsd)
      : totalCollateralValue;

    const info = POOL_INFO[token] ?? {
      protocol: "Blend", poolVersion: "V1", poolType: "single" as const,
      tokens: [token], supplyApr: 5.2, vannaFeeApr: 3.5, liquidationLtv: 82,
    };

    // Single-asset Blend pools (XLM, USDC) are same-asset: the user deposits and
    // borrows the same token, so collateral = borrow token.
    const collateralAsset = token;
    const collateralPrice = getCachedTokenPrice(collateralAsset);
    const collateralAmount = collateralUsd / collateralPrice;

    const leverage = collateralUsd > 0 ? (collateralUsd + borrowUsd) / collateralUsd : 1;
    const netApr = calcNetApr({ supplyApr: info.supplyApr, vannaFeeApr: info.vannaFeeApr, leverage });
    const status: LitePositionStatus =
      healthFactor >= 1.5 ? "active" : healthFactor >= 1.1 ? "risky" : "liquidation";

    positions.push({
      id: `pos-${token.toLowerCase()}`,
      poolId: `${token.toLowerCase()}-blend`,
      poolLabel: token,
      protocol: info.protocol,
      poolVersion: info.poolVersion,
      poolType: info.poolType,
      poolTokens: info.tokens,
      collateralAsset,
      collateralAmount,
      collateralUsd,
      borrowAsset: token,
      borrowAmount,
      borrowUsd,
      isSameAsset: true,
      leverage,
      supplyApr: info.supplyApr,
      vannaFeeApr: info.vannaFeeApr,
      netApr,
      earningsUsd: 0,
      healthFactor,
      liquidationLtv: info.liquidationLtv,
      status,
      openedAt: "recently",
    });
  }

  return positions;
}
