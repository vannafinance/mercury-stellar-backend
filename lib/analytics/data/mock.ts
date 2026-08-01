// ═══════════════════════════════════════════
// VANNA RISK DASHBOARD — STELLAR-NATIVE MOCK DATA
//
// Every fixture in this file references ONLY assets, protocols, and
// addresses that exist in the live application:
//   • Assets:    XLM, USDC (lib/constants.ts → DropdownOptions); legacy BLUSDC/AQUSDC/SOUSDC aliases map to USDC
//   • Protocols: Blend, Aquarius, Soroswap (lib/stellar-utils.ts → CONTRACT_ADDRESSES)
//   • Oracle:    Reflector via OracleContract (lib/oracle-price.ts)
//   • Addresses: Stellar G... (account) / C... (contract), 56-char base32
//
// EVM artifacts (ETH/WBTC/Aave/Uniswap/Morpho/Avantis/0x…) are not
// permitted in this file.
// ═══════════════════════════════════════════

import {
  STELLAR_STRESS_PRESETS,
  syntheticCAccount,
  syntheticGAccount,
  shortStellar,
  ORACLE,
} from "@/lib/analytics/stellar/canon";

/** Single-chain protocol — kept as a tagged union for forward compat
 *  (the type was historically `"base" | "stellar"`; pages shouldn't
 *  branch on it any more). */
export type Chain = "stellar";
export type RiskStatus = "healthy" | "warning" | "danger" | "critical";
export type AlertPriority = "P0" | "P1" | "P2" | "P3";
export type UnwindLegStatus = "not_applicable" | "pending" | "in_progress" | "complete" | "failed";

// ── Helpers ──
const spark = (base: number, volatility: number, len = 168) =>
  Array.from({ length: len }, (_, i) =>
    +(base + Math.sin(i / 12) * volatility + (Math.random() - 0.5) * volatility * 0.5).toFixed(2)
  );

const ts = (daysAgo: number) => Date.now() - daysAgo * 86400000;

// Deterministic synthetic Stellar accounts. Use small ints as seeds so
// the same fixtures keep stable addresses across reloads/tests.
const G = (seed: number) => shortStellar(syntheticGAccount(seed));
const C = (seed: number) => shortStellar(syntheticCAccount(seed));

// ═══════════════════════════════════════════
// PAGE 1 — PROTOCOL OVERVIEW
// ═══════════════════════════════════════════
export const protocolOverview = {
  totalSupply: 31_480_000,
  totalBorrow: 20_870_000,
  totalCollateral: 38_900_000,
  collateralAtRisk: { value: 1_320_000, positions: 11, percentOfTVL: 3.39 },
  valueEligibleForLiquidation: { volume: 0, count: 0, avgTimeOpen: 0 },
  // Active wallets are all Stellar SmartAccounts. Per-network split is
  // collapsed to a single bucket.
  activeWallets: { stellar: 438, total: 438 },
  walletsAtRisk: 19,
  activeBadDebt: { value: 0, positions: 0, rate24h: 0 },
  avgHealthFactor: 2.28,
  avgLeverage: 4.3,
};

/** Overview supply/borrow trend — 14 days, deterministic, USD millions. */
export const overviewSupplyBorrowTrend = Array.from({ length: 14 }, (_, i) => {
  const phase = i * 0.45;
  const supply = 31.48 + Math.sin(phase) * 1.6 + i * 0.03;
  const borrow = 20.87 + Math.sin(phase + 0.4) * 1.1 + i * 0.02;
  return {
    label: `D${i + 1}`,
    supply: Math.round(supply * 100) / 100,
    borrow: Math.round(borrow * 100) / 100,
  };
});

/** High-risk loans (HF < 1.5) — 14 days, deterministic. */
export const overviewHighRiskLoansTrend = Array.from({ length: 14 }, (_, i) => {
  const phase = i * 0.55;
  const count = Math.max(6, Math.round(18 + Math.sin(phase) * 7 + i * 0.18));
  const debtM = Math.round((1.32 + Math.sin(phase + 0.35) * 0.4 + i * 0.025) * 100) / 100;
  return { label: `D${i + 1}`, count, debtM };
});

// ═══════════════════════════════════════════
// PAGE 2 — POSITION RISK ANALYTICS
// ═══════════════════════════════════════════
export const hfDistribution = [
  { range: "< 1.0",   positionCount: 0,   totalDebtUsd: 0,         percentOfTotal: 0    },
  { range: "1.0–1.1", positionCount: 2,   totalDebtUsd: 240_000,   percentOfTotal: 1.15 },
  { range: "1.1–1.3", positionCount: 9,   totalDebtUsd: 1_080_000, percentOfTotal: 5.18 },
  { range: "1.3–1.5", positionCount: 32,  totalDebtUsd: 3_120_000, percentOfTotal: 14.95 },
  { range: "1.5–2.0", positionCount: 184, totalDebtUsd: 8_540_000, percentOfTotal: 40.92 },
  { range: "> 2.0",   positionCount: 211, totalDebtUsd: 7_890_000, percentOfTotal: 37.80 },
];

export const leverageDistribution = [
  { range: "1–2x",  count:  98, debtUsd: 1_180_000 },
  { range: "2–3x",  count: 117, debtUsd: 3_400_000 },
  { range: "3–4x",  count:  82, debtUsd: 4_120_000 },
  { range: "4–5x",  count:  68, debtUsd: 5_080_000 },
  { range: "5–6x",  count:  46, debtUsd: 3_840_000 },
  { range: "6–7x",  count:  28, debtUsd: 2_400_000 },
  { range: "7–8x",  count:  17, debtUsd: 1_320_000 },
  { range: "8–9x",  count:   9, debtUsd:   620_000 },
  { range: "9–10x", count:   4, debtUsd:   320_000 },
];

export const highRiskPositions = [
  { address: G(2001), chain: "stellar" as Chain, healthFactor: 1.04, totalDebt: 220_000, marginValue: 228_800, leverage: 6.4, timeAtRisk: 1820, protocols: ["Blend", "Soroswap"], breakdown: { aTokens: 90_000, lpTokens: 80_000, trackTokens: 32_800, cash: 26_000 } },
  { address: G(2002), chain: "stellar" as Chain, healthFactor: 1.08, totalDebt: 165_000, marginValue: 178_200, leverage: 5.7, timeAtRisk:  920, protocols: ["Aquarius", "Blend"], breakdown: { aTokens: 70_000, lpTokens: 75_000, trackTokens: 18_200, cash: 15_000 } },
  { address: G(2003), chain: "stellar" as Chain, healthFactor: 1.12, totalDebt: 105_000, marginValue: 117_600, leverage: 5.2, timeAtRisk: 4200, protocols: ["Aquarius"],          breakdown: { aTokens:  0,     lpTokens: 92_600, trackTokens:      0, cash: 25_000 } },
  { address: G(2004), chain: "stellar" as Chain, healthFactor: 1.15, totalDebt: 480_000, marginValue: 552_000, leverage: 5.8, timeAtRisk:  600, protocols: ["Blend", "Aquarius", "Soroswap"], breakdown: { aTokens: 220_000, lpTokens: 175_000, trackTokens: 92_000, cash: 65_000 } },
  { address: G(2005), chain: "stellar" as Chain, healthFactor: 1.18, totalDebt: 320_000, marginValue: 377_600, leverage: 4.7, timeAtRisk:  300, protocols: ["Blend"],              breakdown: { aTokens: 320_000, lpTokens:  0,     trackTokens:      0, cash: 57_600 } },
  { address: G(2006), chain: "stellar" as Chain, healthFactor: 1.21, totalDebt: 175_000, marginValue: 211_750, leverage: 4.6, timeAtRisk:  180, protocols: ["Soroswap", "Aquarius"], breakdown: { aTokens:  0,     lpTokens: 152_000, trackTokens:    0, cash: 59_750 } },
  { address: G(2007), chain: "stellar" as Chain, healthFactor: 1.24, totalDebt: 740_000, marginValue: 917_600, leverage: 6.1, timeAtRisk:  120, protocols: ["Blend", "Aquarius", "Soroswap"], breakdown: { aTokens: 360_000, lpTokens: 410_000, trackTokens: 87_600, cash: 60_000 } },
];

export const marginComposition = {
  // aTokens here = Blend b-token tracking collateral (BLEND_XLM/BLEND_USDC).
  // lpTokens  = Aquarius/Soroswap LP receipts (AQ_*, SS_*).
  // trackTokens = generic external integration tracking tokens.
  // cash      = uninvested XLM / USDC on the SmartAccount.
  aTokens:     { valueUsd:  9_240_000, percent: 29.4 },
  lpTokens:    { valueUsd: 12_180_000, percent: 38.7 },
  trackTokens: { valueUsd:  6_120_000, percent: 19.4 },
  cash:        { valueUsd:  3_940_000, percent: 12.5 },
};

export const whaleConcentration = {
  top5Share: 22.4,
  top10Share: 35.8,
  top20Share: 51.2,
  topPositions: [
    { address: G(3001), chain: "stellar" as Chain, debtUsd: 1_320_000, sharePercent: 6.2, healthFactor: 1.82, leverage: 4.1 },
    { address: G(3002), chain: "stellar" as Chain, debtUsd: 1_040_000, sharePercent: 4.9, healthFactor: 2.14, leverage: 3.5 },
    { address: G(3003), chain: "stellar" as Chain, debtUsd:   970_000, sharePercent: 4.6, healthFactor: 1.95, leverage: 5.2 },
    { address: G(3004), chain: "stellar" as Chain, debtUsd:   810_000, sharePercent: 3.8, healthFactor: 1.58, leverage: 6.8 },
    { address: G(3005), chain: "stellar" as Chain, debtUsd:   610_000, sharePercent: 2.9, healthFactor: 2.41, leverage: 3.2 },
    { address: G(3006), chain: "stellar" as Chain, debtUsd:   530_000, sharePercent: 2.5, healthFactor: 1.72, leverage: 4.6 },
    { address: G(3007), chain: "stellar" as Chain, debtUsd:   480_000, sharePercent: 2.3, healthFactor: 3.12, leverage: 2.8 },
    { address: G(3008), chain: "stellar" as Chain, debtUsd:   400_000, sharePercent: 1.9, healthFactor: 1.45, leverage: 7.2 },
    { address: G(3009), chain: "stellar" as Chain, debtUsd:   355_000, sharePercent: 1.7, healthFactor: 2.08, leverage: 3.9 },
    { address: G(3010), chain: "stellar" as Chain, debtUsd:   275_000, sharePercent: 1.3, healthFactor: 1.93, leverage: 4.4 },
  ],
};

export const plDistribution = [
  { range: "< -50%",       count:  4, totalUsd:   -210_000 },
  { range: "-50 to -20%",  count: 18, totalUsd:   -540_000 },
  { range: "-20 to 0%",    count: 92, totalUsd: -1_180_000 },
  { range: "0 to +20%",    count: 271, totalUsd:  2_100_000 },
  { range: "+20 to +50%",  count: 192, totalUsd:  3_950_000 },
  { range: "> +50%",       count:  86, totalUsd:  4_840_000 },
];

// ═══════════════════════════════════════════
// PAGE 3 — LIQUIDATION MONITOR
// ═══════════════════════════════════════════
export const liquidationMetrics = {
  numberOfLiquidations: 312,
  liquidationsPeriodLabel: "Last 30 days",
  collateralSeizedUsd: 4_180_000,
  debtRepaidUsd: 4_010_000,
  walletsWithBadDebt: 2,
  // No multi-chain split — every liquidation is a Soroban tx.
  liveCount: { total: 0, stellar: 0, oldestTimestamp: 0 },
  openVolume: 0,
  avgTimeToLiquidate: 24, // seconds (Stellar ledger close time ~5s × ~5 ledgers per liquidation flow)
  successRate: 96.1,
  liquidationHistory: [
    { txHash: C(4001), chain: "stellar" as Chain, timestamp: ts(0.1), positionAddress: G(2001), liquidatorAddress: G(4101), debtAmount: 220_000, recoveryAmount: 226_400, badDebt:    0, durationSeconds: 14, status: "success" },
    { txHash: C(4002), chain: "stellar" as Chain, timestamp: ts(0.5), positionAddress: G(2008), liquidatorAddress: G(4102), debtAmount: 165_000, recoveryAmount: 162_400, badDebt: 2_600, durationSeconds: 22, status: "partial" },
    { txHash: C(4003), chain: "stellar" as Chain, timestamp: ts(1.2), positionAddress: G(2003), liquidatorAddress: G(4103), debtAmount: 105_000, recoveryAmount: 107_500, badDebt:    0, durationSeconds:  8, status: "success" },
    { txHash: C(4004), chain: "stellar" as Chain, timestamp: ts(2.1), positionAddress: G(2009), liquidatorAddress: G(4101), debtAmount: 405_000, recoveryAmount: 412_000, badDebt:    0, durationSeconds: 19, status: "success" },
    { txHash: C(4005), chain: "stellar" as Chain, timestamp: ts(3.5), positionAddress: G(2010), liquidatorAddress: G(4104), debtAmount: 280_000, recoveryAmount: 274_500, badDebt: 5_500, durationSeconds: 45, status: "partial" },
    { txHash: C(4006), chain: "stellar" as Chain, timestamp: ts(4.2), positionAddress: G(2011), liquidatorAddress: G(4102), debtAmount:  60_000, recoveryAmount:  60_800, badDebt:    0, durationSeconds: 11, status: "success" },
    { txHash: C(4007), chain: "stellar" as Chain, timestamp: ts(5.0), positionAddress: G(3009), liquidatorAddress: G(4105), debtAmount: 130_000, recoveryAmount: 128_900, badDebt: 1_100, durationSeconds: 31, status: "partial" },
    { txHash: C(4008), chain: "stellar" as Chain, timestamp: ts(6.3), positionAddress: G(3010), liquidatorAddress: G(4101), debtAmount: 590_000, recoveryAmount: 593_000, badDebt:    0, durationSeconds: 16, status: "success" },
    { txHash: C(4009), chain: "stellar" as Chain, timestamp: ts(8.1), positionAddress: G(2012), liquidatorAddress: G(4103), debtAmount:  40_000, recoveryAmount:  40_200, badDebt:    0, durationSeconds:  9, status: "success" },
    { txHash: C(4010), chain: "stellar" as Chain, timestamp: ts(10.5), positionAddress: G(2013), liquidatorAddress: G(4104), debtAmount: 220_000, recoveryAmount: 217_500, badDebt: 2_500, durationSeconds: 52, status: "partial" },
    { txHash: C(4011), chain: "stellar" as Chain, timestamp: ts(12.0), positionAddress: G(3008), liquidatorAddress: G(4101), debtAmount: 175_000, recoveryAmount: 177_300, badDebt:    0, durationSeconds: 13, status: "success" },
    { txHash: C(4012), chain: "stellar" as Chain, timestamp: ts(15.2), positionAddress: G(3010), liquidatorAddress: G(4102), debtAmount: 460_000, recoveryAmount: 461_500, badDebt:    0, durationSeconds: 21, status: "success" },
    { txHash: C(4013), chain: "stellar" as Chain, timestamp: ts(18.7), positionAddress: G(2014), liquidatorAddress: G(4105), debtAmount:  72_000, recoveryAmount:  71_300, badDebt:   700, durationSeconds: 28, status: "partial" },
    { txHash: C(4014), chain: "stellar" as Chain, timestamp: ts(22.4), positionAddress: G(2007), liquidatorAddress: G(4103), debtAmount: 740_000, recoveryAmount: 745_500, badDebt:    0, durationSeconds: 17, status: "success" },
  ],
  walletsEligibleForLiquidation: [
    { address: G(2001), chain: "stellar" as Chain, healthFactor: 0.98, debtUsd: 220_000, collateralUsd: 215_600 },
    { address: G(2002), chain: "stellar" as Chain, healthFactor: 0.99, debtUsd: 165_000, collateralUsd: 163_350 },
    { address: G(2003), chain: "stellar" as Chain, healthFactor: 0.97, debtUsd: 105_000, collateralUsd: 101_850 },
    { address: G(2004), chain: "stellar" as Chain, healthFactor: 0.96, debtUsd: 480_000, collateralUsd: 460_800 },
    { address: G(2005), chain: "stellar" as Chain, healthFactor: 0.99, debtUsd: 320_000, collateralUsd: 316_800 },
    { address: G(2006), chain: "stellar" as Chain, healthFactor: 0.98, debtUsd: 175_000, collateralUsd: 171_500 },
    { address: G(2007), chain: "stellar" as Chain, healthFactor: 0.95, debtUsd: 740_000, collateralUsd: 703_000 },
    { address: G(2015), chain: "stellar" as Chain, healthFactor: 0.99, debtUsd:  72_000, collateralUsd:  71_280 },
    { address: G(2016), chain: "stellar" as Chain, healthFactor: 0.97, debtUsd: 580_000, collateralUsd: 562_600 },
    { address: G(2017), chain: "stellar" as Chain, healthFactor: 0.98, debtUsd: 195_000, collateralUsd: 191_100 },
  ],
};

// ═══════════════════════════════════════════
// PAGE 4 — POOL HEALTH (only the 4 lending pools that exist on-chain)
// ═══════════════════════════════════════════
export const poolHealth = [
  {
    asset: "XLM",
    totalSupply: { stellar: 14_200_000, total: 14_200_000 },
    totalBorrowed: { stellar: 9_870_000, total: 9_870_000 },
    utilization: 69.5,
    availableLiquidity: 4_330_000,
    supplyApy: 7.4,
    borrowApy: 11.2,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(6 + Math.random() * 2.5).toFixed(2),
      borrowApy: +(10 + Math.random() * 3).toFixed(2),
    })),
    topDepositors: [
      { address: G(5101), amount: 2_100_000, sharePercent: 14.8 },
      { address: G(5102), amount: 1_300_000, sharePercent:  9.2 },
      { address: G(5103), amount: 1_020_000, sharePercent:  7.2 },
      { address: G(5104), amount:   940_000, sharePercent:  6.6 },
      { address: G(5105), amount:   720_000, sharePercent:  5.1 },
    ],
    top5Share: 42.9,
    historicalBadDebt: spark(0, 5000, 30),
  },
  {
    asset: "BLUSDC",
    totalSupply: { stellar: 8_400_000, total: 8_400_000 },
    totalBorrowed: { stellar: 6_500_000, total: 6_500_000 },
    utilization: 77.4,
    availableLiquidity: 1_900_000,
    supplyApy: 8.2,
    borrowApy: 12.4,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(7 + Math.random() * 3).toFixed(2),
      borrowApy: +(11 + Math.random() * 4).toFixed(2),
    })),
    topDepositors: [
      { address: G(5201), amount: 1_240_000, sharePercent: 14.7 },
      { address: G(5202), amount:   770_000, sharePercent:  9.1 },
      { address: G(5203), amount:   605_000, sharePercent:  7.2 },
      { address: G(5204), amount:   563_000, sharePercent:  6.7 },
      { address: G(5205), amount:   428_000, sharePercent:  5.1 },
    ],
    top5Share: 42.8,
    historicalBadDebt: spark(0, 5000, 30),
  },
  {
    asset: "AQUSDC",
    totalSupply: { stellar: 5_400_000, total: 5_400_000 },
    totalBorrowed: { stellar: 3_240_000, total: 3_240_000 },
    utilization: 60.0,
    availableLiquidity: 2_160_000,
    supplyApy: 5.6,
    borrowApy: 9.1,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(4.5 + Math.random() * 2).toFixed(2),
      borrowApy: +(7.5 + Math.random() * 2.5).toFixed(2),
    })),
    topDepositors: [
      { address: G(5301), amount:   810_000, sharePercent: 15.0 },
      { address: G(5302), amount:   540_000, sharePercent: 10.0 },
      { address: G(5303), amount:   432_000, sharePercent:  8.0 },
      { address: G(5304), amount:   324_000, sharePercent:  6.0 },
      { address: G(5305), amount:   216_000, sharePercent:  4.0 },
    ],
    top5Share: 43.0,
    historicalBadDebt: spark(0, 3000, 30),
  },
  {
    asset: "SOUSDC",
    totalSupply: { stellar: 3_480_000, total: 3_480_000 },
    totalBorrowed: { stellar: 1_260_000, total: 1_260_000 },
    utilization: 36.2,
    availableLiquidity: 2_220_000,
    supplyApy: 3.4,
    borrowApy: 6.1,
    apyHistory: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
      supplyApy: +(2.5 + Math.random() * 2).toFixed(2),
      borrowApy: +(5 + Math.random() * 2.5).toFixed(2),
    })),
    topDepositors: [
      { address: G(5401), amount: 696_000, sharePercent: 20.0 },
      { address: G(5402), amount: 348_000, sharePercent: 10.0 },
      { address: G(5403), amount: 278_000, sharePercent:  8.0 },
      { address: G(5404), amount: 209_000, sharePercent:  6.0 },
      { address: G(5405), amount: 139_000, sharePercent:  4.0 },
    ],
    top5Share: 48.0,
    historicalBadDebt: spark(0, 2000, 30),
  },
];

export const poolFlows = Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
  deposits:    +(Math.random() *   600_000 + 150_000).toFixed(0),
  withdrawals: +(Math.random() *   450_000 +  90_000).toFixed(0),
}));

// ═══════════════════════════════════════════
// PAGE 5 — REFLECTOR ORACLE & PRICE MONITORING
// ═══════════════════════════════════════════
export const oracleData = {
  // Each entry corresponds to one Reflector feed the protocol consults
  // (see lib/oracle-price.ts → PRICEABLE_TOKENS).
  assets: [
    {
      asset: "XLM", chain: "stellar" as Chain,
      oraclePrice: 0.412, cexSpotPrice: 0.4125, dexSpotPrice: 0.4118,
      deviationCex: 0.12, deviationDex: 0.05,
      lastUpdate: Date.now() - 8000, expectedHeartbeat: ORACLE.expectedHeartbeatSec, isStale: false,
      oracleContract: ORACLE.contractAddress,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(0.40 + Math.random() * 0.03).toFixed(4),
        cex:    +(0.40 + Math.random() * 0.03).toFixed(4),
        dex:    +(0.40 + Math.random() * 0.03).toFixed(4),
      })),
    },
    {
      asset: "BLUSDC", chain: "stellar" as Chain,
      oraclePrice: 1.0001, cexSpotPrice: 1.0000, dexSpotPrice: 0.9999,
      deviationCex: 0.01, deviationDex: 0.02,
      lastUpdate: Date.now() - 5000, expectedHeartbeat: ORACLE.expectedHeartbeatSec, isStale: false,
      oracleContract: ORACLE.contractAddress,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(0.999 + Math.random() * 0.002).toFixed(4),
        cex:    +(0.999 + Math.random() * 0.002).toFixed(4),
        dex:    +(0.999 + Math.random() * 0.002).toFixed(4),
      })),
    },
    {
      asset: "AQUSDC", chain: "stellar" as Chain,
      oraclePrice: 0.9998, cexSpotPrice: 1.0001, dexSpotPrice: 0.9994,
      deviationCex: 0.03, deviationDex: 0.04,
      lastUpdate: Date.now() - 11000, expectedHeartbeat: ORACLE.expectedHeartbeatSec, isStale: false,
      oracleContract: ORACLE.contractAddress,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(0.998 + Math.random() * 0.003).toFixed(4),
        cex:    +(0.998 + Math.random() * 0.003).toFixed(4),
        dex:    +(0.998 + Math.random() * 0.003).toFixed(4),
      })),
    },
    {
      asset: "SOUSDC", chain: "stellar" as Chain,
      oraclePrice: 1.0002, cexSpotPrice: 1.0000, dexSpotPrice: 1.0001,
      deviationCex: 0.02, deviationDex: 0.01,
      lastUpdate: Date.now() - 7000, expectedHeartbeat: ORACLE.expectedHeartbeatSec, isStale: false,
      oracleContract: ORACLE.contractAddress,
      history: Array.from({ length: 48 }, (_, i) => ({
        timestamp: Date.now() - (47 - i) * 1800000,
        oracle: +(0.998 + Math.random() * 0.004).toFixed(4),
        cex:    +(0.998 + Math.random() * 0.004).toFixed(4),
        dex:    +(0.998 + Math.random() * 0.004).toFixed(4),
      })),
    },
  ],
  // LP "oracle accuracy" probes only against pools we actually integrate.
  lpTokenAccuracy: [
    { pool: "Aquarius XLM/USDC", chain: "stellar" as Chain, oracleValue: 890_000, simulatedUnwind: 878_000, deviation: 1.3 },
    { pool: "Aquarius XLM/USDT", chain: "stellar" as Chain, oracleValue: 320_000, simulatedUnwind: 314_500, deviation: 1.7 },
    { pool: "Soroswap XLM/USDC", chain: "stellar" as Chain, oracleValue: 620_000, simulatedUnwind: 611_000, deviation: 1.5 },
  ],
  // Tracking-token deviation: Vanna's BLEND_XLM vs. on-chain Blend
  // b-token unit-price (no perp mark-price equivalent on Stellar yet).
  trackTokenDeviation: {
    vannaPrice: 0.4123, blendBTokenPrice: 0.4119, deviation: 0.10, fundingRate: 0,
    history: Array.from({ length: 48 }, (_, i) => ({
      timestamp: Date.now() - (47 - i) * 1800000,
      vanna: +(0.41 + Math.random() * 0.005).toFixed(4),
      blend: +(0.41 + Math.random() * 0.005).toFixed(4),
    })),
  },
  anomalies: [
    { timestamp: ts(5),  asset: "XLM",    type: "Deviation spike", severity: "P2" as AlertPriority, deviation: 2.1, duration: 45 },
    { timestamp: ts(12), asset: "BLUSDC", type: "Reflector stale", severity: "P1" as AlertPriority, deviation: 0,   duration: 180 },
    { timestamp: ts(18), asset: "AQUSDC", type: "DEX price gap",   severity: "P3" as AlertPriority, deviation: 1.8, duration: 30 },
  ],
};

// ═══════════════════════════════════════════
// PAGE 6 — EXTERNAL PROTOCOL HEALTH
// ═══════════════════════════════════════════
export const externalProtocols = {
  // Only protocols Vanna actually composes with on Soroban testnet.
  protocols: [
    { name: "Blend",    chain: "stellar" as Chain, exposureUsd: 18_400_000, exposurePercent: 47.4, tvl: 90_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(90_000_000, 4_000_000, 30) },
    { name: "Aquarius", chain: "stellar" as Chain, exposureUsd:  6_200_000, exposurePercent: 16.0, tvl: 45_000_000, health: "warning" as RiskStatus, tvlTrend: spark(45_000_000, 5_000_000, 30) },
    { name: "Soroswap", chain: "stellar" as Chain, exposureUsd:  3_900_000, exposurePercent: 10.0, tvl: 18_000_000, health: "healthy" as RiskStatus, tvlTrend: spark(18_000_000, 2_000_000, 30) },
  ],
  incidents: [
    { timestamp: ts(2),  protocol: "Aquarius", chain: "stellar" as Chain, severity: "P2" as AlertPriority, description: "Temporary XLM/USDC liquidity imbalance — resolved in 15 minutes" },
    { timestamp: ts(8),  protocol: "Soroswap", chain: "stellar" as Chain, severity: "P3" as AlertPriority, description: "Router latency spike during peak block load — auto-resolved" },
    { timestamp: ts(15), protocol: "Blend",    chain: "stellar" as Chain, severity: "P3" as AlertPriority, description: "Scheduled testnet pool parameter update — no downtime" },
  ],
  // Per-pool health snapshots for the external protocol overview cards.
  blendHealth: {
    poolContract: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    totalSupply: 90_000_000, totalBorrowed: 52_000_000, utilization: 57.8, isOperational: true,
  },
  stellarDexHealth: {
    aquarius: [
      { pair: "XLM/USDC", tvl: 12_000_000, volume24h: 3_400_000 },
      { pair: "XLM/USDT", tvl:  3_900_000, volume24h:   980_000 },
    ],
    soroswap: [
      { pair: "XLM/USDC", depth: 5_200_000, slippageAt100k: 0.8 },
    ],
  },
  circuitBreakers: [
    { name: "Blend Pool Suspension",        chain: "stellar" as Chain, status: "active" as const, trigger: "Blend pool TVL < $10M" },
    { name: "Aquarius LP Halt",             chain: "stellar" as Chain, status: "active" as const, trigger: "Pool TVL < $1M or oracle deviation > 5%" },
    { name: "Soroswap LP Halt",             chain: "stellar" as Chain, status: "active" as const, trigger: "Pool TVL < $500K" },
    { name: "Reflector Freshness Check",    chain: "stellar" as Chain, status: "active" as const, trigger: "Oracle stale > 5 min on any priced asset" },
  ],
};

// ═══════════════════════════════════════════
// PAGE 7 — WHALE TRACKER
// ═══════════════════════════════════════════
export const whaleActivity = [
  { timestamp: ts(0.02), address: G(3001), chain: "stellar" as Chain, action: "INCREASE_LEVERAGE", amountUsd: 320_000, details: "Increased from 3.8× to 4.1× leverage on XLM collateral" },
  { timestamp: ts(0.08), address: G(3003), chain: "stellar" as Chain, action: "DEPOSIT",           amountUsd: 200_000, details: "Deposited 200K BLUSDC into Blend lending pool" },
  { timestamp: ts(0.15), address: G(3004), chain: "stellar" as Chain, action: "OPEN_POSITION",     amountUsd: 480_000, details: "Opened 5.8× leveraged position into Aquarius XLM/USDC LP" },
  { timestamp: ts(0.30), address: G(3002), chain: "stellar" as Chain, action: "DECREASE_LEVERAGE", amountUsd: 240_000, details: "Reduced from 4.2× to 3.5× leverage" },
  { timestamp: ts(0.50), address: G(3006), chain: "stellar" as Chain, action: "WITHDRAW",          amountUsd: 140_000, details: "Withdrew 140K from Aquarius XLM/USDC pool" },
  { timestamp: ts(0.80), address: G(3005), chain: "stellar" as Chain, action: "CLOSE_POSITION",    amountUsd: 840_000, details: "Closed Soroswap LP position with +9.4% PnL" },
];

// ═══════════════════════════════════════════
// PAGE 8 — NETWORK SUMMARY (replaces multi-chain comparison)
// ═══════════════════════════════════════════
// Kept the `chainComparison` export name so consumers don't break, but
// `base` is collapsed to mirror `stellar` (single-chain protocol).
export const chainComparison = {
  stellar: {
    chain: "stellar" as Chain, tvl: 31_480_000, utilization: 66.3, avgHF: 2.28, activeBadDebt: 0,
    activePositions: 438, avgLeverage: 4.3, highRiskCount: 19,
    liquidationSuccessRate: 96.1, avgTimeToLiquidate: 24,
    oracleCount: 4, oracleAvgStaleness: 8,
    ledgerCloseTime: 5.2, sorobanResourceUtil: 34.8, networkFees: 0.00001,
    integratedProtocols: 3, networkStatus: "healthy" as RiskStatus,
  },
  // `base` retained as a typed alias of `stellar` for back-compat with
  // the cross-chain comparison page until it's rewritten as a Stellar
  // network-stats page. Marked deprecated.
  /** @deprecated single-chain protocol — read from `stellar`. */
  base: {
    chain: "stellar" as Chain, tvl: 0, utilization: 0, avgHF: 0, activeBadDebt: 0,
    activePositions: 0, avgLeverage: 0, highRiskCount: 0,
    liquidationSuccessRate: 0, avgTimeToLiquidate: 0,
    oracleCount: 0, oracleAvgStaleness: 0,
    sequencerStatus: "n/a" as const, gasPrice: 0, blockTime: 0,
    integratedProtocols: 0, networkStatus: "healthy" as RiskStatus,
  },
};

// ═══════════════════════════════════════════
// PAGE 9 — ALERTS
// ═══════════════════════════════════════════
export const alertsData = {
  summary: { P0: 0, P1: 0, P2: 2, P3: 4 },
  active: [
    { id: "a1", priority: "P2" as AlertPriority, metric: "pool_concentration",   value: 48,        threshold: 40,      message: "SOUSDC pool top-5 depositor concentration at 48%",        chain: "stellar" as Chain, timestamp: ts(0.10), acknowledged: false },
    { id: "a2", priority: "P2" as AlertPriority, metric: "lp_oracle_deviation",  value: 1.8,       threshold: 1,       message: "Aquarius XLM/USDT LP oracle deviation at 1.8%",            chain: "stellar" as Chain, timestamp: ts(0.20), acknowledged: false },
    { id: "a3", priority: "P3" as AlertPriority, metric: "new_position_size",    value: 480_000,   threshold: 250_000, message: "New whale position opened: $480K at 5.8× leverage on Aquarius LP", chain: "stellar" as Chain, timestamp: ts(0.15), acknowledged: true  },
    { id: "a4", priority: "P3" as AlertPriority, metric: "utilization",          value: 77.4,      threshold: 70,      message: "BLUSDC pool utilization at 77.4%",                         chain: "stellar" as Chain, timestamp: ts(0.30), acknowledged: true  },
    { id: "a5", priority: "P3" as AlertPriority, metric: "blend_b_token_drift",  value: 0.10,      threshold: 0.05,    message: "BLEND_XLM tracking-token vs. live b-token drift at 0.10%", chain: "stellar" as Chain, timestamp: ts(0.40), acknowledged: false },
  ],
  history: [
    { id: "h1", priority: "P1" as AlertPriority, metric: "reflector_stale",        value: 310, threshold: 300, message: "Reflector XLM feed stale for 310 seconds",                  chain: "stellar" as Chain, timestamp: ts(5),  acknowledged: true },
    { id: "h2", priority: "P2" as AlertPriority, metric: "dex_liquidity_change",   value: -32, threshold: -30, message: "Aquarius XLM/USDC liquidity dropped 32% in 24h",            chain: "stellar" as Chain, timestamp: ts(8),  acknowledged: true },
    { id: "h3", priority: "P2" as AlertPriority, metric: "whale_leverage",         value: 2.5, threshold: 2,   message: "Top-5 whale average leverage spiked 2.5× in 1 hour",         chain: "stellar" as Chain, timestamp: ts(12), acknowledged: true },
    { id: "h4", priority: "P3" as AlertPriority, metric: "new_position_size",      value: 320_000, threshold: 250_000, message: "New whale position: $320K at 5.2× leverage on Blend",  chain: "stellar" as Chain, timestamp: ts(15), acknowledged: true },
  ],
};

// ═══════════════════════════════════════════
// PAGE 10 — STRESS TESTING
// ═══════════════════════════════════════════

/** Preset buttons rendered on the Risk Explorer. Sourced directly from
 *  the Stellar canon so updates here automatically flow through to every
 *  scenario page. */
export type RiskExplorerStressPreset = {
  id: string;
  name: string;
  description: string;
  asset: string;
  direction: "up" | "down";
  priceChangePct: number;
};

export const riskExplorerStressPresets: RiskExplorerStressPreset[] =
  STELLAR_STRESS_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    asset: p.asset,
    direction: p.direction,
    priceChangePct: p.priceChangePct,
  }));

export const stressTestScenarios = [
  {
    name: "XLM Flash Crash",
    params: "XLM −35% in 1h, all USDC variants stable",
    result: {
      totalBadDebt: 1_180_000, positionsLiquidated: 92, positionsFailed: 8, avgSlippage: 6.2, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { stellar: { badDebt: 1_180_000, affected: 92 } },
      poolImpact: { XLM: { badDebt: 820_000, solvency: 95.1 }, BLUSDC: { badDebt: 200_000, solvency: 97.8 }, AQUSDC: { badDebt: 100_000, solvency: 98.4 }, SOUSDC: { badDebt: 60_000, solvency: 98.9 } },
    },
  },
  {
    name: "XLM Sustained Drawdown",
    params: "XLM −20% over a week",
    result: {
      totalBadDebt: 740_000, positionsLiquidated: 58, positionsFailed: 4, avgSlippage: 4.1, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { stellar: { badDebt: 740_000, affected: 58 } },
      poolImpact: { XLM: { badDebt: 540_000, solvency: 96.2 }, BLUSDC: { badDebt: 110_000, solvency: 98.4 }, AQUSDC: { badDebt: 60_000, solvency: 98.7 }, SOUSDC: { badDebt: 30_000, solvency: 99.0 } },
    },
  },
  {
    name: "BLUSDC Depeg",
    params: "Blend's USDC reserve depegs to $0.95",
    result: {
      totalBadDebt: 920_000, positionsLiquidated: 48, positionsFailed: 6, avgSlippage: 3.6, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { stellar: { badDebt: 920_000, affected: 48 } },
      poolImpact: { XLM: { badDebt: 60_000, solvency: 99.1 }, BLUSDC: { badDebt: 780_000, solvency: 92.5 }, AQUSDC: { badDebt: 50_000, solvency: 99.0 }, SOUSDC: { badDebt: 30_000, solvency: 99.1 } },
    },
  },
  {
    name: "Reflector Oracle Outage",
    params: "Reflector feed stale > 5 min for XLM (proxy: −15% XLM under no-action)",
    result: {
      totalBadDebt: 410_000, positionsLiquidated: 0, positionsFailed: 0, avgSlippage: 0, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { stellar: { badDebt: 410_000, affected: 22 } },
      poolImpact: { XLM: { badDebt: 280_000, solvency: 97.4 }, BLUSDC: { badDebt: 70_000, solvency: 99.0 }, AQUSDC: { badDebt: 40_000, solvency: 99.2 }, SOUSDC: { badDebt: 20_000, solvency: 99.3 } },
    },
  },
  {
    name: "Stellar Network Halt",
    params: "Soroban produces no new ledgers for 60 min",
    result: {
      totalBadDebt: 540_000, positionsLiquidated: 0, positionsFailed: 0, avgSlippage: 0, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { stellar: { badDebt: 540_000, affected: 28 } },
      poolImpact: { XLM: { badDebt: 380_000, solvency: 97.0 }, BLUSDC: { badDebt: 90_000, solvency: 99.0 }, AQUSDC: { badDebt: 50_000, solvency: 99.1 }, SOUSDC: { badDebt: 20_000, solvency: 99.3 } },
    },
  },
  {
    name: "Blend Pool Exploit",
    params: "Catastrophic event in Blend pool — BLEND_XLM/BLEND_USDC tracking impaired",
    result: {
      totalBadDebt: 3_120_000, positionsLiquidated: 0, positionsFailed: 122, avgSlippage: 0, protocolSurvives: false, reserveFundDepleted: true,
      chainBreakdown: { stellar: { badDebt: 3_120_000, affected: 122 } },
      poolImpact: { XLM: { badDebt: 1_540_000, solvency: 86.4 }, BLUSDC: { badDebt: 1_100_000, solvency: 84.2 }, AQUSDC: { badDebt: 320_000, solvency: 92.1 }, SOUSDC: { badDebt: 160_000, solvency: 94.5 } },
    },
  },
  {
    name: "Aquarius LP Impermanent Loss",
    params: "Sharp XLM/USDC divergence — leveraged Aquarius LPs see HF collapse",
    result: {
      totalBadDebt: 880_000, positionsLiquidated: 41, positionsFailed: 9, avgSlippage: 8.0, protocolSurvives: true, reserveFundDepleted: false,
      chainBreakdown: { stellar: { badDebt: 880_000, affected: 41 } },
      poolImpact: { XLM: { badDebt: 410_000, solvency: 96.4 }, BLUSDC: { badDebt: 200_000, solvency: 97.9 }, AQUSDC: { badDebt: 200_000, solvency: 96.8 }, SOUSDC: { badDebt: 70_000, solvency: 98.7 } },
    },
  },
];

export const earlyWarningIndicators = [
  { indicator: "Whale leverage trending up",         signal: "Top-5 avg leverage +0.3× in 48h",                       leadTime: "Hours–days",     status: "normal"  as RiskStatus },
  { indicator: "DEX liquidity stable",               signal: "No significant Aquarius/Soroswap outflows",             leadTime: "Hours–days",     status: "healthy" as RiskStatus },
  { indicator: "Blend b-token drift normal",         signal: "BLEND_XLM/BLEND_USDC tracking < 0.05% off",             leadTime: "Hours",          status: "healthy" as RiskStatus },
  { indicator: "Pool utilization rising",            signal: "BLUSDC at 77.4%, approaching 80% threshold",            leadTime: "Days",           status: "warning" as RiskStatus },
  { indicator: "Liquidator count stable",            signal: "5 active in 7d, no decline",                            leadTime: "Days",           status: "healthy" as RiskStatus },
  { indicator: "External protocol TVL stable",       signal: "Blend / Aquarius / Soroswap TVL drops < 5%",            leadTime: "Days–weeks",     status: "healthy" as RiskStatus },
  { indicator: "Reflector deviation normal",         signal: "All four priced assets < 0.5% off cex/dex",             leadTime: "Minutes–hours",  status: "healthy" as RiskStatus },
  { indicator: "Soroban ledger close time",          signal: "Avg close 5.2s (normal)",                               leadTime: "Minutes",        status: "healthy" as RiskStatus },
];

// ═══════════════════════════════════════════
// NAV DATA
// ═══════════════════════════════════════════
export const navItems = [
  { label: "Overview",     href: "/",             icon: "grid"   },
  { label: "Positions",    href: "/positions",    icon: "layers" },
  { label: "Liquidations", href: "/liquidations", icon: "zap"    },
  { label: "Oracles",      href: "/oracles",      icon: "radio"  },
  { label: "Whales",       href: "/whales",       icon: "anchor" },
  { label: "Alerts",       href: "/alerts",       icon: "bell"   },
];
