/**
 * Chain-derived Lite positions.
 *
 * Lite mode previously persisted strategy metadata in localStorage. That made
 * another browser/device disagree with the protocol. The current view is built
 * from live Blend tracking-token balances, Aquarius/Soroswap LP balances, pool
 * reserves, and SmartAccount debt. Values that cannot be proven on-chain
 * (original leverage/cost basis) are explicitly marked recovered.
 */
import { AquariusService, AQUARIUS_POOLS, aquariusLpUnderlyingAmounts } from "@/lib/aquarius-utils";
import { BlendService } from "@/lib/blend-utils";
import { MarginAccountService } from "@/lib/margin-utils";
import { fetchTokenPrices, getCachedTokenPrice } from "@/lib/oracle-price";
import { SoroswapService } from "@/lib/soroswap-utils";

export interface LitePositionRecord {
  id: string;
  marginAccountAddress: string;
  poolId: string;
  poolLabel: string;
  protocol: string;
  poolVersion: string;
  poolType: "single" | "lp";
  poolTokens: string[];
  collateralAsset: string;
  collateralAmount: number;
  collateralUsdAtOpen: number;
  borrowAsset: string;
  borrowAmount: number;
  borrowUsdAtOpen: number;
  collateralBorrowAmount?: number;
  collateralBorrowUsdAtOpen?: number;
  leverage: number;
  supplyApr: number;
  vannaFeeApr: number;
  liquidationLtv: number;
  isSameAsset: boolean;
  openedAt: number;
  txHash?: string;
  recovered?: boolean;
}

const DUST = 1e-6;
const amountOf = (
  debts: Record<string, { amount: string }>,
  ...symbols: string[]
): number => {
  for (const symbol of symbols) {
    const value = parseFloat(debts[symbol]?.amount ?? "0");
    if (value > 0) return value;
  }
  return 0;
};

const record = (input: Omit<LitePositionRecord, "openedAt" | "recovered">): LitePositionRecord => ({
  ...input,
  openedAt: Date.now(),
  recovered: true,
});

/** Build every currently-open yield position from authoritative on-chain state. */
export async function getLitePositionsFromChain(
  marginAccountAddress: string | null | undefined,
): Promise<LitePositionRecord[]> {
  if (!marginAccountAddress) return [];

  await fetchTokenPrices(["XLM", "USDC"]);
  const xlmPrice = getCachedTokenPrice("XLM");
  const usdcPrice = getCachedTokenPrice("USDC");

  const [debtResult, blendXlm, blendUsdc, soroswapLp, soroswapStats, ...aquariusResults] =
    await Promise.all([
      MarginAccountService.getCurrentBorrowedBalances(marginAccountAddress, { includePrices: false }),
      BlendService.getUserBlendBalance(marginAccountAddress, "XLM"),
      BlendService.getUserBlendBalance(marginAccountAddress, "USDC"),
      SoroswapService.getLpBalance(marginAccountAddress),
      SoroswapService.getPoolStats(),
      ...AQUARIUS_POOLS.flatMap((pool) => [
        AquariusService.getUserLpBalance(
          marginAccountAddress,
          pool.poolAddress,
          pool.tokens[0],
          pool.tokens[1],
        ),
        AquariusService.getAquariusPoolStats(pool.poolAddress),
      ]),
    ]);

  const debts = debtResult.success && debtResult.data ? debtResult.data : {};
  // A SmartAccount stores aggregate debt per lending market, not a browser-side
  // "position id". Allocate each debt unit at most once across the reconstructed
  // protocol aggregates so multiple open pools never double-count one liability.
  let remainingXlmDebt = amountOf(debts, "XLM");
  let remainingBlendUsdcDebt = amountOf(debts, "BLUSDC", "USDC");
  let remainingAqUsdcDebt = amountOf(debts, "AQUSDC", "AQUARIUS_USDC");
  let remainingSoUsdcDebt = amountOf(debts, "SOUSDC", "SOROSWAP_USDC");
  const positions: LitePositionRecord[] = [];

  const addBlend = (symbol: "XLM" | "USDC", underlyingRaw: string, debt: number) => {
    const underlying = parseFloat(underlyingRaw) || 0;
    if (!(underlying > DUST)) return;
    const price = symbol === "XLM" ? xlmPrice : usdcPrice;
    const deployedDebt = Math.min(underlying, debt);
    const equity = Math.max(0, underlying - deployedDebt);
    positions.push(record({
      id: `chain-blend-${symbol.toLowerCase()}`,
      marginAccountAddress,
      poolId: `${symbol.toLowerCase()}-blend`,
      poolLabel: symbol === "USDC" ? "BLUSDC" : symbol,
      protocol: "Blend",
      poolVersion: "V1",
      poolType: "single",
      poolTokens: [symbol],
      collateralAsset: symbol,
      collateralAmount: equity,
      collateralUsdAtOpen: equity * price,
      borrowAsset: symbol,
      borrowAmount: deployedDebt,
      borrowUsdAtOpen: deployedDebt * price,
      leverage: equity > DUST ? underlying / equity : 1,
      supplyApr: 0,
      vannaFeeApr: 0,
      liquidationLtv: 82,
      isSameAsset: true,
    }));
  };
  addBlend("XLM", blendXlm.underlyingBalance, remainingXlmDebt);
  remainingXlmDebt = Math.max(0, remainingXlmDebt - (parseFloat(blendXlm.underlyingBalance) || 0));
  addBlend("USDC", blendUsdc.underlyingBalance, remainingBlendUsdcDebt);
  remainingBlendUsdcDebt = Math.max(0, remainingBlendUsdcDebt - (parseFloat(blendUsdc.underlyingBalance) || 0));

  const ssLp = parseFloat(soroswapLp) || 0;
  const ssShares = parseFloat(soroswapStats?.totalShares ?? "0");
  if (ssLp > DUST && soroswapStats && ssShares > 0) {
    const ratio = ssLp / ssShares;
    const xlm = ratio * (parseFloat(soroswapStats.reserveXLM) || 0);
    const usdc = ratio * (parseFloat(soroswapStats.reserveUSDC) || 0);
    const xlmBorrow = Math.min(xlm, remainingXlmDebt);
    const usdcBorrow = Math.min(usdc, remainingSoUsdcDebt);
    remainingXlmDebt -= xlmBorrow;
    remainingSoUsdcDebt -= usdcBorrow;
    const equityXlm = Math.max(0, xlm - xlmBorrow);
    const equityUsd = equityXlm * xlmPrice;
    positions.push(record({
      id: "chain-soroswap-xlm-usdc",
      marginAccountAddress,
      poolId: "xlm-usdc-soroswap",
      poolLabel: "XLM/USDC",
      protocol: "Soroswap",
      poolVersion: "DEX",
      poolType: "lp",
      poolTokens: ["XLM", "USDC"],
      collateralAsset: "XLM",
      collateralAmount: equityXlm,
      collateralUsdAtOpen: equityUsd,
      borrowAsset: "USDC",
      borrowAmount: usdcBorrow,
      borrowUsdAtOpen: usdcBorrow * usdcPrice,
      collateralBorrowAmount: xlmBorrow,
      collateralBorrowUsdAtOpen: xlmBorrow * xlmPrice,
      leverage: equityUsd > DUST ? (xlm * xlmPrice + usdc * usdcPrice) / equityUsd : 1,
      supplyApr: 0,
      vannaFeeApr: 0,
      liquidationLtv: 82,
      isSameAsset: false,
    }));
  }

  AQUARIUS_POOLS.forEach((pool, index) => {
    const lp = parseFloat(String(aquariusResults[index * 2] ?? "0")) || 0;
    const stats = aquariusResults[index * 2 + 1] as Awaited<ReturnType<typeof AquariusService.getAquariusPoolStats>>;
    if (!(lp > DUST) || !stats) return;
    const { amountA, amountB } = aquariusLpUnderlyingAmounts(lp, stats, pool.tokens[0], pool.tokens[1]);
    const xlmBorrow = Math.min(amountA, remainingXlmDebt);
    const usdcBorrow = Math.min(amountB, remainingAqUsdcDebt);
    remainingXlmDebt -= xlmBorrow;
    remainingAqUsdcDebt -= usdcBorrow;
    const equityXlm = Math.max(0, amountA - xlmBorrow);
    const equityUsd = equityXlm * xlmPrice;
    positions.push(record({
      id: `chain-${pool.id}`,
      marginAccountAddress,
      poolId: "xlm-usdc-aquarius",
      poolLabel: pool.tokens.join("/"),
      protocol: "Aquarius",
      poolVersion: "AMM",
      poolType: "lp",
      poolTokens: [...pool.tokens],
      collateralAsset: pool.tokens[0],
      collateralAmount: equityXlm,
      collateralUsdAtOpen: equityUsd,
      borrowAsset: pool.tokens[1],
      borrowAmount: usdcBorrow,
      borrowUsdAtOpen: usdcBorrow * usdcPrice,
      collateralBorrowAmount: xlmBorrow,
      collateralBorrowUsdAtOpen: xlmBorrow * xlmPrice,
      leverage: equityUsd > DUST ? (amountA * xlmPrice + amountB * usdcPrice) / equityUsd : 1,
      supplyApr: 0,
      vannaFeeApr: 0,
      liquidationLtv: 82,
      isSameAsset: false,
    }));
  });

  return positions;
}
