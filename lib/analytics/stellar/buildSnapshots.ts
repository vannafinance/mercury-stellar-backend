// Adapter that synthesises an `AccountSnapshot[]` for the analytics
// dashboard out of Stellar data. v1: a single REAL snapshot from the
// connected wallet's margin account (read straight from the existing
// margin-account-info-store — no mutations), padded with deterministic
// SYNTHETIC snapshots so distribution charts have something to plot.
//
// We don't enumerate all protocol margin accounts here because Stellar
// keys SmartAccounts by trader (no registry-style "all accounts" call),
// and Soroban testnet event retention is only ~7 days. A proper indexer
// is a separate, server-side project.

import type { AccountSnapshot, CollateralPosition, DebtPosition } from "@/lib/analytics/onchain/types";
import { useMarginAccountInfoStore, type BorrowedBalance } from "@/store/margin-account-info-store";
import { ACTIVE_ASSETS, syntheticCAccount, syntheticGAccount } from "@/lib/analytics/stellar/canon";

const SYNTHETIC_FILL_COUNT = 31; // total chart population = 1 real + 31 synthetic
const STELLAR_CHAIN_ID = 0; // synthetic id; UI doesn't read it for routing decisions

const TOKEN_DECIMALS: Record<string, number> = {
  XLM: 7,
  USDC: 7,
  BLUSDC: 7,
  AQUSDC: 7,
  SOUSDC: 7,
  BLEND_USDC: 7,
  AQUARIUS_USDC: 7,
  SOROSWAP_USDC: 7,
};

// Heuristics mirror the bucket the EVM `fetchAllAccounts` placed each token
// in. Stellar test pools are: Blend (lending) → "aToken", Aquarius/Soroswap
// (LP-flavoured pools) → "lp", plain XLM/USDC → "cash".
function bucketFor(symbol: string): CollateralPosition["type"] {
  const s = symbol.toUpperCase();
  if (s === "BLUSDC" || s === "BLEND_USDC") return "aToken";
  if (s === "AQUSDC" || s === "SOUSDC" || s === "AQUARIUS_USDC" || s === "SOROSWAP_USDC") return "lp";
  if (s === "XLM" || s === "USDC") return "cash";
  return "unknown";
}

function entriesToCollateral(entries: Record<string, BorrowedBalance>): CollateralPosition[] {
  return Object.entries(entries)
    .map(([symbol, b]): CollateralPosition => ({
      asset: symbol,
      symbol,
      decimals: TOKEN_DECIMALS[symbol] ?? 7,
      amount: parseFloat(b.amount) || 0,
      usd: parseFloat(b.usdValue) || 0,
      type: bucketFor(symbol),
    }))
    .filter((p) => p.amount > 0);
}

function entriesToDebt(entries: Record<string, BorrowedBalance>): DebtPosition[] {
  return Object.entries(entries)
    .map(([symbol, b]): DebtPosition => ({
      asset: symbol,
      symbol,
      decimals: TOKEN_DECIMALS[symbol] ?? 7,
      amount: parseFloat(b.amount) || 0,
      usd: parseFloat(b.usdValue) || 0,
    }))
    .filter((p) => p.amount > 0);
}

function buildSelfSnapshot(userAddress: string): AccountSnapshot | null {
  const s = useMarginAccountInfoStore.getState();
  if (!s.hasMarginAccount || !s.marginAccountAddress) return null;

  const collateral = entriesToCollateral(s.collateralBalances);
  const debt = entriesToDebt(s.borrowedBalances);

  const totalCollateralUsd = s.totalCollateralValue;
  const totalDebtUsd = s.totalBorrowedValue;
  const healthFactor = s.avgHealthFactor > 0 ? s.avgHealthFactor : Infinity;
  const leverage = totalCollateralUsd > 0 ? 1 + totalDebtUsd / totalCollateralUsd : 1;

  return {
    account: s.marginAccountAddress,
    ownerProxy: userAddress,
    chainId: STELLAR_CHAIN_ID,
    collateral,
    debt,
    totalCollateralUsd,
    totalDebtUsd,
    healthFactor,
    leverage,
    isHealthy: healthFactor >= 1.1,
  };
}

// ─── Synthetic fill ─────────────────────────────────────────────────────────
// Deterministic pseudo-random so charts don't reshuffle on every refresh.
// Same `dr(seed)` shape used elsewhere in the codebase for mock pages.
const dr = (seed: number): number => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};

function syntheticAccount(i: number): AccountSnapshot {
  let hf: number;
  if (i === 0) hf = 0.94;
  else if (i === 1) hf = 1.05;
  else if (i < 6) hf = 1.08 + (i - 2) * 0.05;
  else if (i < 16) hf = 1.3 + (i - 6) * 0.07;
  else hf = 2.0 + (i - 16) * 0.12;
  hf = Math.round(hf * 100) / 100;

  const debt = Math.floor(40_000 + dr(i * 7 + 1) * 600_000 / 1000) * 1000;
  const totalCollateralUsd = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, 1 + debt / Math.max(1, totalCollateralUsd)));

  // Synthetic distribution drawn ONLY from the live app's asset universe
  // (lib/analytics/stellar/canon.ts → ACTIVE_ASSETS). Never introduce any
  // asset that isn't currently surfaced in the user-facing dropdowns.
  const collSymbol = ACTIVE_ASSETS[i % ACTIVE_ASSETS.length];
  const debtSymbol = ACTIVE_ASSETS[(i + 1) % ACTIVE_ASSETS.length];

  const collateral: CollateralPosition[] = [{
    asset: collSymbol,
    symbol: collSymbol,
    decimals: 7,
    amount: totalCollateralUsd,
    usd: totalCollateralUsd,
    type: bucketFor(collSymbol),
  }];

  const debtArr: DebtPosition[] = [{
    asset: debtSymbol,
    symbol: debtSymbol,
    decimals: 7,
    amount: debt,
    usd: debt,
  }];

  // Stellar-shaped identifiers (C... contract / G... wallet, 56 chars
  // base32). Chart keys only — never RPC-fetched — but format-correct so
  // tables, filters and explorer-style links don't break invariants.
  const synthAccount = syntheticCAccount(i);
  const synthOwner = syntheticGAccount(i);

  return {
    account: synthAccount,
    ownerProxy: synthOwner,
    chainId: STELLAR_CHAIN_ID,
    collateral,
    debt: debtArr,
    totalCollateralUsd,
    totalDebtUsd: debt,
    healthFactor: hf,
    leverage,
    isHealthy: hf >= 1.1,
  };
}

export async function buildAnalyticsSnapshots(
  userAddress: string | null,
): Promise<{ accounts: AccountSnapshot[]; realAccountCount: number }> {
  const out: AccountSnapshot[] = [];
  let realAccountCount = 0;

  if (userAddress) {
    const self = buildSelfSnapshot(userAddress);
    if (self) {
      out.push(self);
      realAccountCount = 1;
    }
  }

  // Pad with synthetic snapshots so distribution charts populate. Real vs
  // synthetic counts are shown on the overview status strip.
  for (let i = 0; i < SYNTHETIC_FILL_COUNT; i++) {
    out.push(syntheticAccount(i));
  }

  return { accounts: out, realAccountCount };
}
