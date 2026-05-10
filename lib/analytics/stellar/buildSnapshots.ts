// Builds `AccountSnapshot[]` for analytics from **live** Stellar / Soroban data.
//
// Strategy (protocol-wide):
//   1. Read every margin (smart) account ever registered with
//      AccountManager via Registry's `SmartAccountsList` storage entry —
//      this is the closest thing to an on-chain account index.
//   2. For each open account, snapshot its collateral + debt directly from
//      the contract (read-only `simulateTransaction` calls — no Freighter
//      signature required).
//   3. Merge in the connected wallet's snapshot via the live in-memory
//      margin-account-info store. This guarantees the dashboard reflects
//      the user's pending writes immediately (e.g. right after a borrow,
//      before the protocol-wide cache TTL expires) without waiting for
//      the next RPC refresh.

import type {
  AccountSnapshot,
  CollateralPosition,
  DebtPosition,
} from "@/lib/analytics/onchain/types";
import {
  useMarginAccountInfoStore,
  checkUserMarginAccount,
  refreshBorrowedBalances,
  type BorrowedBalance,
} from "@/store/margin-account-info-store";
import { fetchAllMarginAccountSnapshots } from "./allMarginAccounts";
import { collateralPositionTypeForSymbol } from "@/lib/analytics/stellar/collateralClassification";

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

function entriesToCollateral(entries: Record<string, BorrowedBalance>): CollateralPosition[] {
  return Object.entries(entries)
    .map(([symbol, b]): CollateralPosition => ({
      asset: symbol,
      symbol,
      decimals: TOKEN_DECIMALS[symbol] ?? 7,
      amount: parseFloat(b.amount) || 0,
      usd: parseFloat(b.usdValue) || 0,
      type: collateralPositionTypeForSymbol(symbol),
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
  const force = opts?.force ?? false;

  // 1. Connected-wallet refresh: keep this so the overview reacts immediately
  //    to the connected user's writes (the in-memory store is hotter than
  //    the protocol-wide RPC cache).
  let selfSnapshot: AccountSnapshot | null = null;
  if (userAddress) {
    await checkUserMarginAccount(userAddress, force);
    const { hasMarginAccount, marginAccountAddress } = useMarginAccountInfoStore.getState();
    if (hasMarginAccount && marginAccountAddress) {
      await refreshBorrowedBalances(marginAccountAddress, force);
    }
    selfSnapshot = buildSelfSnapshot(userAddress);
  }

  // 2. Protocol-wide fan-out — every margin account ever registered, owners
  //    resolved from RegistryKey::OwnerAddress, balances pulled with a
  //    public read-source (no wallet auth required).
  const { accounts: protocolSnapshots } = await fetchAllMarginAccountSnapshots({ force });

  // 3. Merge — prefer the connected wallet's freshly-recomputed snapshot
  //    over the protocol-wide read for that same account, since the in-memory
  //    store reflects the latest local writes.
  const byAccount = new Map<string, AccountSnapshot>();
  for (const snap of protocolSnapshots) {
    byAccount.set(snap.account, snap);
  }
  if (selfSnapshot) {
    byAccount.set(selfSnapshot.account, selfSnapshot);
  }

  const accounts = Array.from(byAccount.values());
  return { accounts, realAccountCount: accounts.length };
}
