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
import { collateralPositionTypeForSymbol } from "@/lib/analytics/stellar/collateralClassification";

const STELLAR_CHAIN_ID = 0;

/**
 * Fetch the protocol-wide account snapshots from the shared edge-cached route
 * (`/api/analytics/accounts`) instead of running the bounded RPC fan-out in the
 * browser — so the heavy scan runs ~once per 30s globally, not per visitor.
 * `force` busts the server cache for an immediate fresh read. Restores the
 * Infinity health factor the route wired as a marker string.
 */
async function fetchProtocolSnapshots(force: boolean): Promise<AccountSnapshot[]> {
  const res = await fetch(`/api/analytics/accounts${force ? "?force=1" : ""}`);
  if (!res.ok) throw new Error(`analytics accounts failed (${res.status})`);
  const { accounts } = (await res.json()) as { accounts: AccountSnapshot[] };
  return accounts.map((a) => ({
    ...a,
    healthFactor:
      (a.healthFactor as unknown) === "Infinity" ? Number.POSITIVE_INFINITY : a.healthFactor,
    leverage: (a.leverage as unknown) === "Infinity" ? Number.POSITIVE_INFINITY : a.leverage,
  }));
}

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

  // The connected-wallet refresh (1) and the protocol-wide edge-cached scan
  // (2) are fully independent — neither reads the other's result — but were
  // previously awaited one after another, adding the wallet refresh's
  // latency on top of the protocol scan's on every cold load. Run them
  // concurrently instead.
  const [selfSnapshot, protocolSnapshots] = await Promise.all([
    // 1. Connected-wallet refresh: keep this so the overview reacts immediately
    //    to the connected user's writes (the in-memory store is hotter than
    //    the protocol-wide RPC cache).
    (async (): Promise<AccountSnapshot | null> => {
      if (!userAddress) return null;
      await checkUserMarginAccount(userAddress, force);
      const { hasMarginAccount, marginAccountAddress } = useMarginAccountInfoStore.getState();
      if (hasMarginAccount && marginAccountAddress) {
        await refreshBorrowedBalances(marginAccountAddress, force);
      }
      return buildSelfSnapshot(userAddress);
    })(),
    // 2. Protocol-wide snapshots — served from the shared edge-cached route so the
    //    bounded RPC fan-out runs once per ~30s globally, not in every browser.
    fetchProtocolSnapshots(force),
  ]);

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
