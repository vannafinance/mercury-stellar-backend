// ═══════════════════════════════════════════
// VANNA RISK DASHBOARD — COMPLETE MOCK DATA
// ═══════════════════════════════════════════

export type Chain = "base" | "stellar";
export type RiskStatus = "healthy" | "warning" | "danger" | "critical";
export type AlertPriority = "P0" | "P1" | "P2" | "P3";
export type UnwindLegStatus = "not_applicable" | "pending" | "in_progress" | "complete" | "failed";

// ── Helpers ──
const spark = (base: number, volatility: number, len = 168) =>
  Array.from({ length: len }, (_, i) =>
    +(base + Math.sin(i / 12) * volatility + (Math.random() - 0.5) * volatility * 0.5).toFixed(2)
  );

const ts = (daysAgo: number) => Date.now() - daysAgo * 86400000;

// ═══════════════════════════════════════════
// PAGE 1 — PROTOCOL OVERVIEW
// ═══════════════════════════════════════════
export const protocolOverview = {
  totalSupply: 118_400_000,
  totalBorrow: 83_500_000,
  totalCollateral: 142_000_000,
  collateralAtRisk: { value: 4_820_000, positions: 18, percentOfTVL: 4.15 },
  valueEligibleForLiquidation: { volume: 0, count: 0, avgTimeOpen: 0 },
  activeWallets: { base: 1_247, stellar: 438, total: 1_685 },
  walletsAtRisk: 47,
  activeBadDebt: { value: 0, positions: 0, rate24h: 0 },
  avgHealthFactor: 2.12,
  avgLeverage: 4.7,
};

/** Overview risk section — last 14 days, deterministic (USD millions) */
export const overviewSupplyBorrowTrend = Array.from({ length: 14 }, (_, i) => {
  const phase = i * 0.45;
  const supply = 118.4 + Math.sin(phase) * 2.2 + i * 0.08;
  const borrow = 83.5 + Math.sin(phase + 0.4) * 1.8 + i * 0.06;
  return {
    label: `D${i + 1}`,
    supply: Math.round(supply * 100) / 100,
    borrow: Math.round(borrow * 100) / 100,
  };
});

/** High-risk loans (HF &lt; 1.5) — last 14 days, deterministic mock */
export const overviewHighRiskLoansTrend = Array.from({ length: 14 }, (_, i) => {
  const phase = i * 0.55;
  const count = Math.max(
    12,
    Math.round(44 + Math.sin(phase) * 14 + i * 0.35)
  );
  const debtM =
    Math.round((4.35 + Math.sin(phase + 0.35) * 0.85 + i * 0.06) * 100) / 100;
  return {
    label: `D${i + 1}`,
    count,
    debtM,
  };
});

// ═══════════════════════════════════════════
// PAGE 2 — POSITION RISK ANALYTICS
// ═══════════════════════════════════════════
export const hfDistribution = [
  { range: "< 1.0", positionCount: 0, totalDebtUsd: 0, percentOfTotal: 0 },
  { range: "1.0–1.1", positionCount: 3, totalDebtUsd: 890_000, percentOfTotal: 1.07 },
  { range: "1.1–1.3", positionCount: 15, totalDebtUsd: 3_930_000, percentOfTotal: 4.71 },
  { range: "1.3–1.5", positionCount: 87, totalDebtUsd: 12_400_000, percentOfTotal: 14.85 },
  { range: "1.5–2.0", positionCount: 542, totalDebtUsd: 34_280_000, percentOfTotal: 41.05 },
  { range: "> 2.0", positionCount: 1038, totalDebtUsd: 32_000_000, percentOfTotal: 38.32 },
];

export const leverageDistribution = [
  { range: "1–2x", count: 312, debtUsd: 4_200_000 },
  { range: "2–3x", count: 385, debtUsd: 11_800_000 },
  { range: "3–4x", count: 298, debtUsd: 14_200_000 },
  { range: "4–5x", count: 267, debtUsd: 18_900_000 },
  { range: "5–6x", count: 189, debtUsd: 15_300_000 },
  { range: "6–7x", count: 112, debtUsd: 9_800_000 },
  { range: "7–8x", count: 72, debtUsd: 5_600_000 },
  { range: "8–9x", count: 34, debtUsd: 2_400_000 },
  { range: "9–10x", count: 16, debtUsd: 1_300_000 },
];

export const highRiskPositions = [
  { address: "0x1a2b...3c4d", chain: "base" as Chain, healthFactor: 1.04, totalDebt: 420_000, marginValue: 437_000, leverage: 8.2, timeAtRisk: 1820, protocols: ["Morpho", "Uniswap"], breakdown: { aTokens: 180_000, lpTokens: 157_000, trackTokens: 60_000, cash: 40_000 } },
  { address: "0x5e6f...7a8b", chain: "base" as Chain, healthFactor: 1.08, totalDebt: 310_000, marginValue: 334_800, leverage: 7.1, timeAtRisk: 920, protocols: ["Aerodrome", "Avantis"], breakdown: { aTokens: 0, lpTokens: 214_800, trackTokens: 90_000, cash: 30_000 } },
  { address: "GC2F...XYZW", chain: "stellar" as Chain, healthFactor: 1.12, totalDebt: 160_000, marginValue: 179_200, leverage: 5.8, timeAtRisk: 4200, protocols: ["Aquarius"], breakdown: { aTokens: 0, lpTokens: 129_200, trackTokens: 0, cash: 50_000 } },
  { address: "0x9c0d...1e2f", chain: "base" as Chain, healthFactor: 1.15, totalDebt: 890_000, marginValue: 1_023_500, leverage: 6.5, timeAtRisk: 600, protocols: ["Morpho", "Uniswap", "Avantis"], breakdown: { aTokens: 410_000, lpTokens: 320_000, trackTokens: 193_500, cash: 100_000 } },
  { address: "0xab12...cd34", chain: "base" as Chain, healthFactor: 1.18, totalDebt: 550_000, marginValue: 649_000, leverage: 5.2, timeAtRisk: 300, protocols: ["Morpho"], breakdown: { aTokens: 549_000, lpTokens: 0, trackTokens: 0, cash: 100_000 } },
  { address: "GDWX...MNOP", chain: "stellar" as Chain, healthFactor: 1.21, totalDebt: 230_000, marginValue: 278_300, leverage: 4.9, timeAtRisk: 180, protocols: ["Soroswap", "Aquarius"], breakdown: { aTokens: 0, lpTokens: 198_300, trackTokens: 0, cash: 80_000 } },
  { address: "0xef56...7890", chain: "base" as Chain, healthFactor: 1.24, totalDebt: 1_280_000, marginValue: 1_587_200, leverage: 7.8, timeAtRisk: 120, protocols: ["Uniswap", "Aerodrome", "Morpho"], breakdown: { aTokens: 600_000, lpTokens: 687_200, trackTokens: 200_000, cash: 100_000 } },
];

export const marginComposition = {
  aTokens: { valueUsd: 28_400_000, percent: 34.0 },
  lpTokens: { valueUsd: 31_200_000, percent: 37.4 },
  trackTokens: { valueUsd: 15_800_000, percent: 18.9 },
  cash: { valueUsd: 8_100_000, percent: 9.7 },
};

export const whaleConcentration = {
  top5Share: 22.4,
  top10Share: 35.8,
  top20Share: 51.2,
  topPositions: [
    { address: "0xaaa1...1111", chain: "base" as Chain, debtUsd: 5_200_000, sharePercent: 6.2, healthFactor: 1.82, leverage: 4.1 },
    { address: "0xbbb2...2222", chain: "base" as Chain, debtUsd: 4_100_000, sharePercent: 4.9, healthFactor: 2.14, leverage: 3.5 },
    { address: "GCCC...3333", chain: "stellar" as Chain, debtUsd: 3_800_000, sharePercent: 4.6, healthFactor: 1.95, leverage: 5.2 },
    { address: "0xddd4...4444", chain: "base" as Chain, debtUsd: 3_200_000, sharePercent: 3.8, healthFactor: 1.58, leverage: 6.8 },
    { address: "0xeee5...5555", chain: "base" as Chain, debtUsd: 2_400_000, sharePercent: 2.9, healthFactor: 2.41, leverage: 3.2 },
    { address: "GFFF...6666", chain: "stellar" as Chain, debtUsd: 2_100_000, sharePercent: 2.5, healthFactor: 1.72, leverage: 4.6 },
    { address: "0x7777...8888", chain: "base" as Chain, debtUsd: 1_900_000, sharePercent: 2.3, healthFactor: 3.12, leverage: 2.8 },
    { address: "0x9999...0000", chain: "base" as Chain, debtUsd: 1_600_000, sharePercent: 1.9, healthFactor: 1.45, leverage: 7.2 },
    { address: "GAAA...BBBB", chain: "stellar" as Chain, debtUsd: 1_400_000, sharePercent: 1.7, healthFactor: 2.08, leverage: 3.9 },
    { address: "0xcccc...dddd", chain: "base" as Chain, debtUsd: 1_100_000, sharePercent: 1.3, healthFactor: 1.93, leverage: 4.4 },
  ],
};

export const plDistribution = [
  { range: "< -50%", count: 12, totalUsd: -820_000 },
  { range: "-50 to -20%", count: 45, totalUsd: -2_100_000 },
  { range: "-20 to 0%", count: 234, totalUsd: -4_500_000 },
  { range: "0 to +20%", count: 687, totalUsd: 8_200_000 },
  { range: "+20 to +50%", count: 489, totalUsd: 15_400_000 },
  { range: "> +50%", count: 218, totalUsd: 18_900_000 },
];

// ═══════════════════════════════════════════
// PAGE 3 — LIQUIDATION MONITOR
// ═══════════════════════════════════════════
export const liquidationMetrics = {
  numberOfLiquidations: 847,
  liquidationsPeriodLabel: "Last 30 days",
  collateralSeizedUsd: 12_400_000,
  debtRepaidUsd: 11_950_000,
  walletsWithBadDebt: 3,
  liveCount: { total: 0, base: 0, stellar: 0, oldestTimestamp: 0 },
  openVolume: 0,
  avgTimeToLiquidate: 18, // seconds
  successRate: 97.3,
  liquidationHistory: [
    { txHash: "0xabc...123", chain: "base" as Chain, timestamp: ts(0.1), positionAddress: "0x1a2b...3c4d", liquidatorAddress: "0xLIQ1...aaaa", debtAmount: 420_000, recoveryAmount: 431_200, badDebt: 0, durationSeconds: 14, status: "success" },
    { txHash: "0xdef...456", chain: "base" as Chain, timestamp: ts(0.5), positionAddress: "0x7d8e...9f0a", liquidatorAddress: "0xLIQ2...bbbb", debtAmount: 310_000, recoveryAmount: 305_200, badDebt: 4_800, durationSeconds: 22, status: "partial" },
    { txHash: "0xghi...789", chain: "stellar" as Chain, timestamp: ts(1.2), positionAddress: "GCXY...MNOP", liquidatorAddress: "0xLIQ3...cccc", debtAmount: 180_000, recoveryAmount: 184_500, badDebt: 0, durationSeconds: 8, status: "success" },
    { txHash: "0xjkl...012", chain: "base" as Chain, timestamp: ts(2.1), positionAddress: "0xb2c3...d4e5", liquidatorAddress: "0xLIQ1...aaaa", debtAmount: 750_000, recoveryAmount: 762_300, badDebt: 0, durationSeconds: 19, status: "success" },
    { txHash: "0xmno...345", chain: "base" as Chain, timestamp: ts(3.5), positionAddress: "0xf6a7...b8c9", liquidatorAddress: "0xLIQ4...dddd", debtAmount: 520_000, recoveryAmount: 512_800, badDebt: 7_200, durationSeconds: 45, status: "partial" },
    { txHash: "0xpqr...678", chain: "base" as Chain, timestamp: ts(4.2), positionAddress: "0xaaaa...bbbb", liquidatorAddress: "0xLIQ2...bbbb", debtAmount: 95_000, recoveryAmount: 96_200, badDebt: 0, durationSeconds: 11, status: "success" },
    { txHash: "0xstu...901", chain: "stellar" as Chain, timestamp: ts(5.0), positionAddress: "GAAA...BBBB", liquidatorAddress: "0xLIQ5...eeee", debtAmount: 240_000, recoveryAmount: 238_000, badDebt: 2_000, durationSeconds: 31, status: "partial" },
    { txHash: "0xvwx...234", chain: "base" as Chain, timestamp: ts(6.3), positionAddress: "0xcccc...dddd", liquidatorAddress: "0xLIQ1...aaaa", debtAmount: 1_100_000, recoveryAmount: 1_105_000, badDebt: 0, durationSeconds: 16, status: "success" },
    { txHash: "0xyz...567", chain: "base" as Chain, timestamp: ts(8.1), positionAddress: "0xeeee...ffff", liquidatorAddress: "0xLIQ3...cccc", debtAmount: 62_000, recoveryAmount: 62_400, badDebt: 0, durationSeconds: 9, status: "success" },
    { txHash: "0x111...890", chain: "stellar" as Chain, timestamp: ts(10.5), positionAddress: "GCCC...DDDD", liquidatorAddress: "0xLIQ4...dddd", debtAmount: 410_000, recoveryAmount: 405_000, badDebt: 5_000, durationSeconds: 52, status: "partial" },
    { txHash: "0x222...123", chain: "base" as Chain, timestamp: ts(12.0), positionAddress: "0x7777...8888", liquidatorAddress: "0xLIQ1...aaaa", debtAmount: 330_000, recoveryAmount: 334_000, badDebt: 0, durationSeconds: 13, status: "success" },
    { txHash: "0x333...456", chain: "base" as Chain, timestamp: ts(15.2), positionAddress: "0x9999...0000", liquidatorAddress: "0xLIQ2...bbbb", debtAmount: 880_000, recoveryAmount: 882_100, badDebt: 0, durationSeconds: 21, status: "success" },
    { txHash: "0x444...789", chain: "stellar" as Chain, timestamp: ts(18.7), positionAddress: "GEEE...FFFF", liquidatorAddress: "0xLIQ5...eeee", debtAmount: 125_000, recoveryAmount: 124_000, badDebt: 1_000, durationSeconds: 28, status: "partial" },
    { txHash: "0x555...012", chain: "base" as Chain, timestamp: ts(22.4), positionAddress: "0xab12...cd34", liquidatorAddress: "0xLIQ3...cccc", debtAmount: 1_280_000, recoveryAmount: 1_290_000, badDebt: 0, durationSeconds: 17, status: "success" },
  ],
  walletsEligibleForLiquidation: [
    { address: "0x1a2b...3c4d", chain: "base" as Chain, healthFactor: 0.98, debtUsd: 420_000, collateralUsd: 411_600 },
    { address: "0x5e6f...7a8b", chain: "base" as Chain, healthFactor: 0.99, debtUsd: 310_000, collateralUsd: 306_900 },
    { address: "GC2F...XYZW", chain: "stellar" as Chain, healthFactor: 0.97, debtUsd: 160_000, collateralUsd: 155_200 },
    { address: "0x9c0d...1e2f", chain: "base" as Chain, healthFactor: 0.96, debtUsd: 890_000, collateralUsd: 854_400 },
    { address: "0xab12...cd34", chain: "base" as Chain, healthFactor: 0.99, debtUsd: 550_000, collateralUsd: 544_500 },
    { address: "GDWX...MNOP", chain: "stellar" as Chain, healthFactor: 0.98, debtUsd: 230_000, collateralUsd: 225_400 },
    { address: "0xef56...7890", chain: "base" as Chain, healthFactor: 0.95, debtUsd: 1_280_000, collateralUsd: 1_216_000 },
    { address: "0xaaaa...1111", chain: "base" as Chain, healthFactor: 0.99, debtUsd: 72_000, collateralUsd: 71_280 },
    { address: "0xbbbb...2222", chain: "base" as Chain, healthFactor: 0.97, debtUsd: 1_050_000, collateralUsd: 1_018_500 },
    { address: "GZZZ...YYYY", chain: "stellar" as Chain, healthFactor: 0.98, debtUsd: 340_000, collateralUsd: 333_200 },
    { address: "0xcccc...3333", chain: "base" as Chain, healthFactor: 0.96, debtUsd: 615_000, collateralUsd: 590_400 },
    { address: "0xdddd...4444", chain: "base" as Chain, healthFactor: 0.99, debtUsd: 198_000, collateralUsd: 196_020 },
    { address: "0xeeee...5555", chain: "stellar" as Chain, healthFactor: 0.95, debtUsd: 455_000, collateralUsd: 432_250 },
    { address: "0xffff...6666", chain: "base" as Chain, healthFactor: 0.98, debtUsd: 920_000, collateralUsd: 901_600 },
    { address: "0x7777...7777", chain: "base" as Chain, healthFactor: 0.97, debtUsd: 44_000, collateralUsd: 42_680 },
    { address: "G888...9999", chain: "stellar" as Chain, healthFactor: 0.99, debtUsd: 275_000, collateralUsd: 272_250 },
  ],
};

// ═══════════════════════════════════════════
// PAGE 4 — POOL HEALTH
// ═══════════════════════════════════════════
export const poolHealth = [
  {
    asset: "USDC",
    totalSupply: { base: 42_000_000, stellar: 15_000_000, total: 57_000_000 },
    totalBorrowed: { base: 33_600_000, stellar: 10_500_000, total: 44_100_000 },
    utilization: 77.4,
    availableLiquidity: 12_900_000,
    supplyApy: 8.2,
    borrowApy: 12.4,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(7 + Math.random() * 3).toFixed(2),
      borrowApy: +(11 + Math.random() * 4).toFixed(2),
    })),
    topDepositors: [
      { address: "0xaaa1...1111", amount: 8_400_000, sharePercent: 14.7 },
      { address: "0xbbb2...2222", amount: 5_200_000, sharePercent: 9.1 },
      { address: "GCCC...3333", amount: 4_100_000, sharePercent: 7.2 },
      { address: "0xddd4...4444", amount: 3_800_000, sharePercent: 6.7 },
      { address: "0xeee5...5555", amount: 2_900_000, sharePercent: 5.1 },
    ],
    top5Share: 42.8,
    historicalBadDebt: spark(0, 5000, 30),
  },
  {
    asset: "ETH",
    totalSupply: { base: 28_000_000, stellar: 10_000_000, total: 38_000_000 },
    totalBorrowed: { base: 19_600_000, stellar: 7_200_000, total: 26_800_000 },
    utilization: 70.5,
    availableLiquidity: 11_200_000,
    supplyApy: 5.8,
    borrowApy: 9.2,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(4.5 + Math.random() * 2.5).toFixed(2),
      borrowApy: +(8 + Math.random() * 3).toFixed(2),
    })),
    topDepositors: [
      { address: "0x7777...8888", amount: 5_600_000, sharePercent: 14.7 },
      { address: "GAAA...BBBB", amount: 3_800_000, sharePercent: 10.0 },
      { address: "0xcccc...dddd", amount: 2_900_000, sharePercent: 7.6 },
      { address: "0xeee5...5555", amount: 2_100_000, sharePercent: 5.5 },
      { address: "0xfff6...6666", amount: 1_800_000, sharePercent: 4.7 },
    ],
    top5Share: 42.5,
    historicalBadDebt: spark(0, 3000, 30),
  },
  {
    asset: "WBTC",
    totalSupply: { base: 14_520_000, stellar: 6_480_000, total: 21_000_000 },
    totalBorrowed: { base: 9_000_000, stellar: 3_600_000, total: 12_600_000 },
    utilization: 60.0,
    availableLiquidity: 8_400_000,
    supplyApy: 3.4,
    borrowApy: 6.1,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(2.5 + Math.random() * 2).toFixed(2),
      borrowApy: +(5 + Math.random() * 2.5).toFixed(2),
    })),
    topDepositors: [
      { address: "0xbbb2...2222", amount: 4_200_000, sharePercent: 20.0 },
      { address: "0xaaa1...1111", amount: 2_100_000, sharePercent: 10.0 },
      { address: "GFFF...6666", amount: 1_680_000, sharePercent: 8.0 },
      { address: "0x9999...0000", amount: 1_260_000, sharePercent: 6.0 },
      { address: "0xddd4...4444", amount: 840_000, sharePercent: 4.0 },
    ],
    top5Share: 48.0,
    historicalBadDebt: spark(0, 2000, 30),
  },
];

export const poolFlows = Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
  deposits: +(Math.random() * 2_000_000 + 500_000).toFixed(0),
  withdrawals: +(Math.random() * 1_500_000 + 300_000).toFixed(0),
}));

// ═══════════════════════════════════════════
// PAGE 5 — ORACLE & PRICE MONITORING
// ═══════════════════════════════════════════
export const oracleData = {
  assets: [
    {
      asset: "ETH", chain: "base" as Chain,
      oraclePrice: 3_842.50, cexSpotPrice: 3_845.20, dexSpotPrice: 3_840.80,
      deviationCex: 0.07, deviationDex: 0.04,
      lastUpdate: Date.now() - 12000, expectedHeartbeat: 30, isStale: false,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(3800 + Math.random() * 100).toFixed(2),
        cex: +(3800 + Math.random() * 100).toFixed(2),
        dex: +(3800 + Math.random() * 100).toFixed(2),
      })),
    },
    {
      asset: "WBTC", chain: "base" as Chain,
      oraclePrice: 97_420.00, cexSpotPrice: 97_480.50, dexSpotPrice: 97_390.00,
      deviationCex: 0.06, deviationDex: 0.03,
      lastUpdate: Date.now() - 18000, expectedHeartbeat: 30, isStale: false,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(97000 + Math.random() * 800).toFixed(2),
        cex: +(97000 + Math.random() * 800).toFixed(2),
        dex: +(97000 + Math.random() * 800).toFixed(2),
      })),
    },
    {
      asset: "USDC", chain: "base" as Chain,
      oraclePrice: 1.0001, cexSpotPrice: 1.0000, dexSpotPrice: 0.9999,
      deviationCex: 0.01, deviationDex: 0.02,
      lastUpdate: Date.now() - 5000, expectedHeartbeat: 60, isStale: false,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(0.999 + Math.random() * 0.002).toFixed(4),
        cex: +(0.999 + Math.random() * 0.002).toFixed(4),
        dex: +(0.999 + Math.random() * 0.002).toFixed(4),
      })),
    },
    {
      asset: "XLM", chain: "stellar" as Chain,
      oraclePrice: 0.412, cexSpotPrice: 0.4125, dexSpotPrice: 0.4118,
      deviationCex: 0.12, deviationDex: 0.05,
      lastUpdate: Date.now() - 8000, expectedHeartbeat: 30, isStale: false,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(0.40 + Math.random() * 0.03).toFixed(4),
        cex: +(0.40 + Math.random() * 0.03).toFixed(4),
        dex: +(0.40 + Math.random() * 0.03).toFixed(4),
      })),
    },
  ],
  lpTokenAccuracy: [
    { pool: "Uniswap ETH/USDC", chain: "base" as Chain, oracleValue: 2_450_000, simulatedUnwind: 2_428_000, deviation: 0.9 },
    { pool: "Aerodrome ETH/WBTC", chain: "base" as Chain, oracleValue: 1_820_000, simulatedUnwind: 1_798_000, deviation: 1.2 },
    { pool: "Aquarius XLM/USDC", chain: "stellar" as Chain, oracleValue: 890_000, simulatedUnwind: 878_000, deviation: 1.3 },
    { pool: "Soroswap ETH/XLM", chain: "stellar" as Chain, oracleValue: 620_000, simulatedUnwind: 611_000, deviation: 1.5 },
  ],
  trackTokenDeviation: {
    vannaPrice: 3_820.40, avantisMarkPrice: 3_824.10, deviation: 0.10, fundingRate: 0.012,
    history: Array.from({ length: 48 }, (_, i) => ({
      timestamp: Date.now() - (47 - i) * 1800000,
      vanna: +(3800 + Math.random() * 50).toFixed(2),
      avantis: +(3800 + Math.random() * 50).toFixed(2),
    })),
  },
  anomalies: [
    { timestamp: ts(5), asset: "ETH", type: "Deviation spike", severity: "P2" as AlertPriority, deviation: 2.1, duration: 45 },
    { timestamp: ts(12), asset: "USDC", type: "Stale oracle", severity: "P1" as AlertPriority, deviation: 0, duration: 180 },
    { timestamp: ts(18), asset: "XLM", type: "DEX price gap", severity: "P3" as AlertPriority, deviation: 1.8, duration: 30 },
  ],
};

// ═══════════════════════════════════════════
// PAGE 6 — EXTERNAL PROTOCOL HEALTH
// ═══════════════════════════════════════════
export const externalProtocols = {
  protocols: [
    { name: "Uniswap", chain: "base" as Chain, exposureUsd: 18_400_000, exposurePercent: 22.0, tvl: 4_200_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(4_200_000_000, 100_000_000, 30) },
    { name: "Aerodrome", chain: "base" as Chain, exposureUsd: 12_800_000, exposurePercent: 15.3, tvl: 890_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(890_000_000, 40_000_000, 30) },
    { name: "Avantis", chain: "base" as Chain, exposureUsd: 15_800_000, exposurePercent: 18.9, tvl: 320_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(320_000_000, 20_000_000, 30) },
    { name: "Morpho", chain: "base" as Chain, exposureUsd: 28_400_000, exposurePercent: 34.0, tvl: 2_100_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(2_100_000_000, 80_000_000, 30) },
    { name: "Aquarius", chain: "stellar" as Chain, exposureUsd: 5_200_000, exposurePercent: 6.2, tvl: 45_000_000, health: "warning" as RiskStatus, tvlTrend: spark(45_000_000, 5_000_000, 30) },
    { name: "Soroswap", chain: "stellar" as Chain, exposureUsd: 2_900_000, exposurePercent: 3.5, tvl: 18_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(18_000_000, 2_000_000, 30) },
  ],
  incidents: [
    { timestamp: ts(2), protocol: "Aquarius", chain: "stellar" as Chain, severity: "P2" as AlertPriority, description: "Temporary liquidity pool imbalance detected — resolved in 15 minutes" },
    { timestamp: ts(8), protocol: "Aerodrome", chain: "base" as Chain, severity: "P3" as AlertPriority, description: "Governance proposal to adjust fee tiers — monitoring" },
    { timestamp: ts(15), protocol: "Avantis", chain: "base" as Chain, severity: "P3" as AlertPriority, description: "Scheduled maintenance window — 2 minutes downtime" },
  ],
  avantisHealth: {
    openInterest: 180_000_000, fundingRates: { "ETH/USD": 0.012, "BTC/USD": 0.008, "SOL/USD": 0.022 },
    tvl: 320_000_000, utilization: 56.3, isOperational: true,
  },
  stellarDexHealth: {
    aquarius: [
      { pair: "XLM/USDC", tvl: 12_000_000, volume24h: 3_400_000 },
      { pair: "ETH/USDC", tvl: 8_500_000, volume24h: 2_100_000 },
    ],
    soroswap: [
      { pair: "XLM/USDC", depth: 5_200_000, slippageAt100k: 0.8 },
      { pair: "ETH/XLM", depth: 2_800_000, slippageAt100k: 1.4 },
    ],
  },
  circuitBreakers: [
    { name: "Base Morpho Deposits", chain: "base" as Chain, status: "active" as const, trigger: "Morpho TVL < $500M" },
    { name: "Base Avantis Track", chain: "base" as Chain, status: "active" as const, trigger: "Avantis offline" },
    { name: "Base Uniswap LP", chain: "base" as Chain, status: "active" as const, trigger: "Pool TVL < $1M" },
    { name: "Base Aerodrome LP", chain: "base" as Chain, status: "active" as const, trigger: "Pool TVL < $500K" },
    { name: "Stellar Aquarius LP", chain: "stellar" as Chain, status: "active" as const, trigger: "Pool TVL < $1M" },
    { name: "Stellar Soroswap LP", chain: "stellar" as Chain, status: "active" as const, trigger: "Pool TVL < $500K" },
  ],
};

// ═══════════════════════════════════════════
// PAGE 7 — WHALE TRACKER
// ═══════════════════════════════════════════
export const whaleActivity = [
  { timestamp: ts(0.02), address: "0xaaa1...1111", chain: "base" as Chain, action: "INCREASE_LEVERAGE", amountUsd: 820_000, details: "Increased from 3.8x to 4.1x leverage" },
  { timestamp: ts(0.08), address: "GCCC...3333", chain: "stellar" as Chain, action: "DEPOSIT", amountUsd: 500_000, details: "Deposited 500K USDC to lending pool" },
  { timestamp: ts(0.15), address: "0xddd4...4444", chain: "base" as Chain, action: "OPEN_POSITION", amountUsd: 1_200_000, details: "Opened 6.8x leveraged position in ETH/USDC LP" },
  { timestamp: ts(0.3), address: "0xbbb2...2222", chain: "base" as Chain, action: "DECREASE_LEVERAGE", amountUsd: 600_000, details: "Reduced from 4.2x to 3.5x leverage" },
  { timestamp: ts(0.5), address: "GFFF...6666", chain: "stellar" as Chain, action: "WITHDRAW", amountUsd: 350_000, details: "Withdrew 350K from Aquarius pool" },
  { timestamp: ts(0.8), address: "0xeee5...5555", chain: "base" as Chain, action: "CLOSE_POSITION", amountUsd: 2_100_000, details: "Closed position with +12.4% P&L" },
];

// ═══════════════════════════════════════════
// PAGE 8 — CROSS-CHAIN COMPARISON
// ═══════════════════════════════════════════
export const chainComparison = {
  base: {
    chain: "base" as Chain, tvl: 84_520_000, utilization: 74.8, avgHF: 2.12, activeBadDebt: 0,
    activePositions: 1_247, avgLeverage: 4.9, highRiskCount: 12,
    liquidationSuccessRate: 97.8, avgTimeToLiquidate: 16,
    oracleCount: 4, oracleAvgStaleness: 14,
    sequencerStatus: "up" as const, gasPrice: 0.004, blockTime: 2.0,
    integratedProtocols: 4, networkStatus: "healthy" as RiskStatus,
  },
  stellar: {
    chain: "stellar" as Chain, tvl: 31_480_000, utilization: 66.3, avgHF: 2.28, activeBadDebt: 0,
    activePositions: 438, avgLeverage: 4.3, highRiskCount: 6,
    liquidationSuccessRate: 96.1, avgTimeToLiquidate: 24,
    oracleCount: 3, oracleAvgStaleness: 8,
    ledgerCloseTime: 5.2, sorobanResourceUtil: 34.8, networkFees: 0.00001,
    integratedProtocols: 2, networkStatus: "healthy" as RiskStatus,
  },
};

// ═══════════════════════════════════════════
// PAGE 9 — ALERTS
// ═══════════════════════════════════════════
export const alertsData = {
  summary: { P0: 0, P1: 0, P2: 2, P3: 5 },
  active: [
    { id: "a1", priority: "P2" as AlertPriority, metric: "pool_concentration", value: 48, threshold: 40, message: "WBTC pool top-5 depositor concentration at 48%", chain: "base" as Chain, timestamp: ts(0.1), acknowledged: false },
    { id: "a2", priority: "P2" as AlertPriority, metric: "oracle_deviation", value: 1.2, threshold: 1, message: "Aerodrome ETH/WBTC LP oracle deviation at 1.2%", chain: "base" as Chain, timestamp: ts(0.2), acknowledged: false },
    { id: "a3", priority: "P3" as AlertPriority, metric: "new_position_size", value: 1_200_000, threshold: 500_000, message: "New whale position opened: $1.2M at 6.8x leverage", chain: "base" as Chain, timestamp: ts(0.15), acknowledged: true },
    { id: "a4", priority: "P3" as AlertPriority, metric: "utilization", value: 77.4, threshold: 70, message: "USDC pool utilization at 77.4%", chain: "base" as Chain, timestamp: ts(0.3), acknowledged: true },
    { id: "a5", priority: "P3" as AlertPriority, metric: "funding_rate", value: 0.022, threshold: 0.02, message: "Avantis SOL/USD funding rate elevated at 2.2%/hr", chain: "base" as Chain, timestamp: ts(0.4), acknowledged: false },
  ],
  history: [
    { id: "h1", priority: "P1" as AlertPriority, metric: "oracle_stale", value: 310, threshold: 300, message: "ETH oracle stale for 310 seconds", chain: "base" as Chain, timestamp: ts(5), acknowledged: true },
    { id: "h2", priority: "P2" as AlertPriority, metric: "dex_liquidity_change", value: -32, threshold: -30, message: "Aquarius XLM/USDC liquidity dropped 32% in 24h", chain: "stellar" as Chain, timestamp: ts(8), acknowledged: true },
    { id: "h3", priority: "P2" as AlertPriority, metric: "whale_leverage", value: 2.5, threshold: 2, message: "Top-5 whale average leverage spiked 2.5x in 1 hour", chain: "base" as Chain, timestamp: ts(12), acknowledged: true },
    { id: "h4", priority: "P3" as AlertPriority, metric: "new_position_size", value: 800_000, threshold: 500_000, message: "New whale position: $800K at 5.2x leverage", chain: "stellar" as Chain, timestamp: ts(15), acknowledged: true },
  ],
};

// ═══════════════════════════════════════════
// PAGE 10 — STRESS TESTING (legacy results data; explorer uses presets below)
// ═══════════════════════════════════════════

/** Preset buttons on Risk Explorer — same names as stress-test scenarios; fills asset / % / direction (+ auto-apply). */
export type RiskExplorerStressPreset = {
  id: string;
  name: string;
  description: string;
  asset: string;
  direction: "up" | "down";
  priceChangePct: number;
};

export const riskExplorerStressPresets: RiskExplorerStressPreset[] = [
  {
    id: "black-thursday",
    name: "Black Thursday",
    description: "March 2020–style liquidation cascade: ETH −45% / 24h, broad alts −40–50%",
    asset: "ETH",
    direction: "down",
    priceChangePct: 45,
  },
  {
    id: "flash-crash",
    name: "Flash Crash",
    description: "Single-session wipeout: ETH −25% fast, partial recovery modeled as −15% shock",
    asset: "ETH",
    direction: "down",
    priceChangePct: 25,
  },
  {
    id: "stable-depeg",
    name: "Stablecoin Depeg",
    description: "Major stable loses peg (e.g. USDC toward $0.95) — collateral & liquidity stress",
    asset: "USDC",
    direction: "down",
    priceChangePct: 5,
  },
  {
    id: "external-exploit",
    name: "External Exploit (Morpho)",
    description: "Counterparty / protocol failure — aToken exposure impaired (proxy: extreme ETH shock)",
    asset: "ETH",
    direction: "down",
    priceChangePct: 95,
  },
  {
    id: "cascading",
    name: "Cascading Liquidation",
    description: "Liquidation wave: many simultaneous liquidations + thin books (proxy: deep market shock)",
    asset: "ETH",
    direction: "down",
    priceChangePct: 35,
  },
  {
    id: "stellar-halt",
    name: "Stellar Network Halt",
    description: "Settlement / network delay on Stellar — liquidity can’t move (proxy: liquidity stress)",
    asset: "ETH",
    direction: "down",
    priceChangePct: 12,
  },
  {
    id: "luna-crash",
    name: "Luna Crash",
    description: "Terra-style death spiral: collateral reprices in hours (proxy: ETH −60%, extreme vol)",
    asset: "ETH",
    direction: "down",
    priceChangePct: 60,
  },
  {
    id: "covid-crash",
    name: "Covid-19 Crash",
    description: "March 2020 macro risk-off: equities & crypto dump together (proxy: ETH −38% over days)",
    asset: "ETH",
    direction: "down",
    priceChangePct: 38,
  },
];

export const stressTestScenarios = [
  {
    name: "Black Thursday", params: "ETH -45% in 24h, BTC -40%, alts -50%",
    result: { totalBadDebt: 4_200_000, positionsLiquidated: 312, positionsFailed: 28, avgSlippage: 8.4, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { base: { badDebt: 3_100_000, affected: 224 }, stellar: { badDebt: 1_100_000, affected: 88 } },
      poolImpact: { USDC: { badDebt: 2_100_000, solvency: 94.2 }, ETH: { badDebt: 1_400_000, solvency: 95.8 }, WBTC: { badDebt: 700_000, solvency: 96.7 } },
    },
  },
  {
    name: "Flash Crash", params: "ETH -25% in 10min, recovery to -15% in 30min",
    result: { totalBadDebt: 1_800_000, positionsLiquidated: 89, positionsFailed: 12, avgSlippage: 5.2, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { base: { badDebt: 1_400_000, affected: 67 }, stellar: { badDebt: 400_000, affected: 22 } },
      poolImpact: { USDC: { badDebt: 900_000, solvency: 97.5 }, ETH: { badDebt: 600_000, solvency: 98.1 }, WBTC: { badDebt: 300_000, solvency: 98.6 } },
    },
  },
  {
    name: "Stablecoin Depeg", params: "USDC drops to $0.95",
    result: { totalBadDebt: 2_850_000, positionsLiquidated: 145, positionsFailed: 8, avgSlippage: 3.1, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { base: { badDebt: 2_100_000, affected: 108 }, stellar: { badDebt: 750_000, affected: 37 } },
      poolImpact: { USDC: { badDebt: 2_500_000, solvency: 93.1 }, ETH: { badDebt: 200_000, solvency: 99.2 }, WBTC: { badDebt: 150_000, solvency: 99.3 } },
    },
  },
  {
    name: "External Exploit (Morpho)", params: "Morpho hack → aToken value = 0",
    result: { totalBadDebt: 12_400_000, positionsLiquidated: 0, positionsFailed: 489, avgSlippage: 0, protocolSurvives: false, reserveFundDepleted: true,
      chainBreakdown: { base: { badDebt: 12_400_000, affected: 489 }, stellar: { badDebt: 0, affected: 0 } },
      poolImpact: { USDC: { badDebt: 6_200_000, solvency: 82.4 }, ETH: { badDebt: 4_100_000, solvency: 85.2 }, WBTC: { badDebt: 2_100_000, solvency: 90.0 } },
    },
  },
  {
    name: "Cascading Liquidation", params: "100 simultaneous liquidations",
    result: { totalBadDebt: 3_600_000, positionsLiquidated: 100, positionsFailed: 22, avgSlippage: 12.8, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { base: { badDebt: 2_800_000, affected: 78 }, stellar: { badDebt: 800_000, affected: 22 } },
      poolImpact: { USDC: { badDebt: 1_800_000, solvency: 95.0 }, ETH: { badDebt: 1_200_000, solvency: 96.2 }, WBTC: { badDebt: 600_000, solvency: 97.1 } },
    },
  },
  {
    name: "Stellar Network Halt", params: "Stellar halted 1 hour",
    result: { totalBadDebt: 2_100_000, positionsLiquidated: 0, positionsFailed: 0, avgSlippage: 0, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { base: { badDebt: 0, affected: 0 }, stellar: { badDebt: 2_100_000, affected: 94 } },
      poolImpact: { USDC: { badDebt: 1_050_000, solvency: 97.1 }, ETH: { badDebt: 700_000, solvency: 98.0 }, WBTC: { badDebt: 350_000, solvency: 98.3 } },
    },
  },
  {
    name: "Luna Crash", params: "Terra-style spiral — extreme collateral repricing (ETH −60% proxy)",
    result: { totalBadDebt: 9_200_000, positionsLiquidated: 412, positionsFailed: 156, avgSlippage: 18.2, protocolSurvives: false, reserveFundDepleted: true,
      chainBreakdown: { base: { badDebt: 7_200_000, affected: 312 }, stellar: { badDebt: 2_000_000, affected: 98 } },
      poolImpact: { USDC: { badDebt: 4_100_000, solvency: 88.2 }, ETH: { badDebt: 3_200_000, solvency: 89.5 }, WBTC: { badDebt: 1_900_000, solvency: 91.0 } },
    },
  },
  {
    name: "Covid-19 Crash", params: "March 2020 risk-off — ETH −38% over days",
    result: { totalBadDebt: 3_100_000, positionsLiquidated: 198, positionsFailed: 31, avgSlippage: 8.4, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { base: { badDebt: 2_400_000, affected: 142 }, stellar: { badDebt: 700_000, affected: 56 } },
      poolImpact: { USDC: { badDebt: 1_800_000, solvency: 94.8 }, ETH: { badDebt: 900_000, solvency: 96.7 }, WBTC: { badDebt: 400_000, solvency: 97.5 } },
    },
  },
];

export const earlyWarningIndicators = [
  { indicator: "Whale leverage trending up", signal: "Top-5 avg leverage +0.3x in 48h", leadTime: "Hours–days", status: "normal" as RiskStatus },
  { indicator: "DEX liquidity stable", signal: "No significant outflows", leadTime: "Hours–days", status: "healthy" as RiskStatus },
  { indicator: "Avantis funding rates normal", signal: "All pairs < 0.03%/hr", leadTime: "Hours", status: "healthy" as RiskStatus },
  { indicator: "Pool utilization rising", signal: "USDC at 77.4%, approaching 80% threshold", leadTime: "Days", status: "warning" as RiskStatus },
  { indicator: "Liquidator count stable", signal: "8 active in 7d, no decline", leadTime: "Days", status: "healthy" as RiskStatus },
  { indicator: "External protocol TVL stable", signal: "No drops > 5%", leadTime: "Days–weeks", status: "healthy" as RiskStatus },
  { indicator: "Oracle deviation normal", signal: "All assets < 0.5%", leadTime: "Minutes–hours", status: "healthy" as RiskStatus },
  { indicator: "Base sequencer latency", signal: "Block time 2.0s (normal)", leadTime: "Minutes", status: "healthy" as RiskStatus },
];

// ═══════════════════════════════════════════
// NAV DATA
// ═══════════════════════════════════════════
export const navItems = [
  { label: "Overview", href: "/", icon: "grid" },
  { label: "Positions", href: "/positions", icon: "layers" },
  { label: "Liquidations", href: "/liquidations", icon: "zap" },
  { label: "Oracles", href: "/oracles", icon: "radio" },
  { label: "Whales", href: "/whales", icon: "anchor" },
  { label: "Alerts", href: "/alerts", icon: "bell" },
];
