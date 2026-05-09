// Builds `AccountSnapshot[]` for analytics from **live** Stellar / Soroban data only.
//
// There is no on-chain registry that lists every margin account, so the client can
// only snapshot the **connected wallet's** SmartAccount (via the margin-account
// store). Charts and KPIs reflect that real position — never synthetic padding.

import type { AccountSnapshot, CollateralPosition, DebtPosition } from "@/lib/analytics/onchain/types";
import {
  useMarginAccountInfoStore,
  checkUserMarginAccount,
  refreshBorrowedBalances,
  type BorrowedBalance,
} from "@/store/margin-account-info-store";

const STELLAR_CHAIN_ID = 0;

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

export async function buildAnalyticsSnapshots(
  userAddress: string | null,
  opts?: { force?: boolean },
): Promise<{ accounts: AccountSnapshot[]; realAccountCount: number }> {
  const out: AccountSnapshot[] = [];
  let realAccountCount = 0;
  const force = opts?.force ?? false;

  if (userAddress) {
    await checkUserMarginAccount(userAddress, force);
    const { hasMarginAccount, marginAccountAddress } = useMarginAccountInfoStore.getState();
    if (hasMarginAccount && marginAccountAddress) {
      await refreshBorrowedBalances(marginAccountAddress, force);
    }
    const self = buildSelfSnapshot(userAddress);
    if (self) {
      out.push(self);
      realAccountCount = 1;
    }
  }

  return { accounts: out, realAccountCount };
}
