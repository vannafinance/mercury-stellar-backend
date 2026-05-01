import { calcNetApr, calcEarningsUsd } from "./lite-position-math";
import { getTokenPriceUsdSync } from "@/lib/prices";

export type LitePositionStatus = "active" | "risky" | "liquidation";

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

/* ═══ Mock positions — Stellar (XLM / USDC / Blend) themed ═══════════════
 *
 * These are displayed when no real margin account positions exist.
 * Stellar integration replaces this array with real on-chain data;
 * the shape and math are unchanged.
 */

interface BuildArgs {
  id: string;
  poolId: string;
  protocol: string;
  poolVersion: string;
  poolType: "single" | "lp";
  poolTokens: string[];
  asset: string;              // collateral & borrow asset (same-asset positions)
  priceUsd: number;
  collateralAmount: number;
  leverage: number;
  supplyApr: number;
  vannaFeeApr: number;
  healthFactor: number;
  liquidationLtv: number;
  status: LitePositionStatus;
  openedAt: string;
  elapsedYears: number;
}

const buildPosition = (a: BuildArgs): LitePosition => {
  const collateralUsd = a.collateralAmount * a.priceUsd;
  const borrowAmount = a.collateralAmount * (a.leverage - 1);
  const borrowUsd = borrowAmount * a.priceUsd;
  const netApr = calcNetApr({
    supplyApr: a.supplyApr,
    vannaFeeApr: a.vannaFeeApr,
    leverage: a.leverage,
  });
  const earningsUsd = calcEarningsUsd(collateralUsd, netApr, a.elapsedYears);
  return {
    id: a.id,
    poolId: a.poolId,
    poolLabel: a.asset,
    protocol: a.protocol,
    poolVersion: a.poolVersion,
    poolType: a.poolType,
    poolTokens: a.poolTokens,
    collateralAsset: a.asset,
    collateralAmount: a.collateralAmount,
    collateralUsd,
    borrowAsset: a.asset,
    borrowAmount,
    borrowUsd,
    isSameAsset: true,
    leverage: a.leverage,
    supplyApr: a.supplyApr,
    vannaFeeApr: a.vannaFeeApr,
    netApr,
    earningsUsd,
    healthFactor: a.healthFactor,
    liquidationLtv: a.liquidationLtv,
    status: a.status,
    openedAt: a.openedAt,
  };
};

export const MOCK_LITE_POSITIONS: LitePosition[] = [
  /* XLM 5× on Blend XLM pool — healthy, profitable.
     netApr = 5×5.2 − 4×3.5 = 26 − 14 = 12%. */
  buildPosition({
    id: "pos-xlm-5x",
    poolId: "xlm-blend",
    protocol: "Blend",
    poolVersion: "V1",
    poolType: "single",
    poolTokens: ["XLM"],
    asset: "XLM",
    priceUsd: getTokenPriceUsdSync("XLM"),
    collateralAmount: 1000,
    leverage: 5,
    supplyApr: 5.2,
    vannaFeeApr: 3.5,
    healthFactor: 1.67,
    liquidationLtv: 82,
    status: "active",
    openedAt: "2d ago",
    elapsedYears: 2 / 365,
  }),
  /* USDC 6× on Blend USDC pool — risky HF, break-even APR for demo.
     netApr = 6×8.1 − 5×5.0 = 48.6 − 25 = 23.6%, but user over-leveraged → HF 1.35. */
  buildPosition({
    id: "pos-usdc-6x",
    poolId: "usdc-blend",
    protocol: "Blend",
    poolVersion: "V1",
    poolType: "single",
    poolTokens: ["USDC"],
    asset: "USDC",
    priceUsd: 1.0,
    collateralAmount: 500,
    leverage: 6,
    supplyApr: 8.1,
    vannaFeeApr: 5.0,
    healthFactor: 1.35,
    liquidationLtv: 86,
    status: "risky",
    openedAt: "5d ago",
    elapsedYears: 5 / 365,
  }),
  /* USDC 3× on Soroswap XLM/USDC LP — profitable, healthy.
     netApr = 3×10.2 − 2×5.0 = 30.6 − 10 = 20.6%. */
  buildPosition({
    id: "pos-usdc-soroswap-3x",
    poolId: "xlm-usdc-soroswap",
    protocol: "Soroswap",
    poolVersion: "DEX",
    poolType: "lp",
    poolTokens: ["XLM", "USDC"],
    asset: "USDC",
    priceUsd: 1.0,
    collateralAmount: 300,
    leverage: 3,
    supplyApr: 10.2,
    vannaFeeApr: 5.0,
    healthFactor: 2.10,
    liquidationLtv: 82,
    status: "active",
    openedAt: "10d ago",
    elapsedYears: 10 / 365,
  }),
];

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
    const collateralPrice = getTokenPriceUsdSync(collateralAsset);
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
