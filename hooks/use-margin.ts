'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useMarginAccountInfoStore,
  checkUserMarginAccount,
  createMarginAccount,
  refreshBorrowedBalances,
} from '@/store/margin-account-info-store';
import { getMarginHistoryFromMercury, type MarginTxEntry } from '@/lib/mercury-margin';
import { getMarginHistoryFromRpc } from '@/lib/margin-history-rpc';
import { MarginAccountService } from '@/lib/margin-utils';
import { useUserStore } from '@/store/user';

/** Margin history row decoded from AccountManager events. */
export type MarginHistoryRow = {
  type: MarginTxEntry['type'];
  asset: string;
  amount: string;
  timestamp: number;
  hash: string;
};

// Margin transaction history — Mercury (full history, no ~7-day RPC cap) plus a
// bounded RPC fallback for any recent activity Mercury is currently missing.
//
// The redeployed AccountManager (2026-06-13) now emits self-describing events:
// Trader_Borrow{token_symbol, token_amount}, Trader_Deposit{token_symbol, amount},
// Trader_Repay_Event{token_symbol, token_amount, timestamp}. So borrow amounts and
// deposits come straight from Mercury — the earlier localStorage overlay (which
// filled the old symbol-only Trader_Borrow gap) is no longer needed and was removed.
// Timestamps: repay from its payload; borrow/deposit per-tx from Horizon (the
// contract emits none, by design) — handled in getMarginHistoryFromMercury.
//
// Confirmed 2026-07-21: Mercury's index for the CURRENT AccountManager address
// stalled on 2026-07-19 despite continuous real on-chain activity since (verified
// directly via RPC) — a genuine indexing gap on Mercury's side, not something we
// can fix from here. getMarginHistoryFromRpc fills that gap for whatever RPC's
// own (short) retention window still covers; the two sources are merged and
// deduped by tx hash so history shows real data again in the meantime, reverting
// to Mercury alone automatically once its index catches back up (RPC entries
// simply become redundant with Mercury's and get deduped out).
//
// NO ledger-tick refetch: the query is heavy (full ledger range + per-tx timestamp
// enrichment). Freshness comes from mount, account change, window focus, and the
// margin-mutation invalidation of ['margin'] (prefix-matches ['margin','history']).
/**
 * Full margin transaction history for the connected margin account: Mercury
 * (intended full history) merged with a bounded RPC fallback for any recent
 * activity Mercury's index is currently missing, deduped by tx hash. Gated on
 * the margin account address; intentionally NOT ledger-tick refetched (see note
 * above) — refreshed on mount, account change, window focus, and `['margin']`
 * mutation invalidation. Results are returned newest-first.
 *
 * @returns `{ history, isLoading, isRefreshing }`.
 */
export const useMarginHistory = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const query = useQuery({
    queryKey: ['margin', 'history', marginAccountAddress ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<MarginHistoryRow[]> => {
      if (!marginAccountAddress) return [];
      // Promise.allSettled, not Promise.all: getMarginHistoryFromMercury has
      // no internal try/catch, so a Mercury-side failure (confirmed live: a
      // transient 502 from Mercury's REST endpoint) rejects that promise —
      // with Promise.all that would reject the WHOLE query and discard a
      // perfectly good RPC-fallback result too, surfacing as "No transaction
      // history" even though RPC had real data. Each source degrades
      // independently now.
      const [mercurySettled, rpcSettled] = await Promise.allSettled([
        getMarginHistoryFromMercury(marginAccountAddress),
        getMarginHistoryFromRpc(marginAccountAddress),
      ]);
      const mercury = mercurySettled.status === 'fulfilled' ? mercurySettled.value : [];
      const rpcFallback = rpcSettled.status === 'fulfilled' ? rpcSettled.value : [];
      // Keyed by hash+type+asset, NOT hash alone: a single atomic "Deposit &
      // Borrow" transaction emits TWO distinct events (Trader_Deposit AND
      // Trader_Borrow) sharing the SAME tx hash. Deduping by hash alone
      // collapsed them into one entry, silently dropping whichever event lost
      // the Map.set race — confirmed live (a deposit+borrow tx showed only
      // the deposit in Position History). Mercury first, then RPC fills in
      // anything Mercury doesn't have yet.
      const byKey = new Map<string, MarginTxEntry>();
      const keyOf = (e: MarginTxEntry) => `${e.hash}:${e.type}:${e.asset}`;
      for (const entry of mercury) if (entry.hash) byKey.set(keyOf(entry), entry);
      for (const entry of rpcFallback) if (entry.hash && !byKey.has(keyOf(entry))) byKey.set(keyOf(entry), entry);
      return Array.from(byKey.values());
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const history = (query.data ?? []).slice().sort((a, b) => b.timestamp - a.timestamp);

  return {
    history,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Margin-collateral transfer (wallet ⇄ margin account) — the same underlying
// AccountManager calls as `components/margin/transfer-collateral.tsx`'s MB/WB
// modes, exposed as plain mutations so other surfaces (the Portfolio page's
// top-level Deposit/Withdraw buttons) can drive the same real collateral
// transfer instead of the plain lending-pool supply/redeem flow.
// ─────────────────────────────────────────────────────────────────────────────

/** Precision-safe human-amount → WAD (1e18) string, scaling via BigInt to avoid float drift. */
const toWad = (amount: number): string =>
  (BigInt(Math.floor(amount * 1_000_000)) * BigInt(1_000_000_000_000)).toString();

/** Maps a display/asset-type symbol to the raw contract collateral symbol. */
const normalizeContractTokenSymbol = (symbol: string): string => {
  const s = symbol.toUpperCase();
  if (s === 'BLUSDC' || s === 'BLEND_USDC' || s === 'USDC') return 'USDC';
  if (s === 'AQUSDC' || s === 'AQUIRESUSDC' || s === 'AQUARIUS_USDC') return 'AQUSDC';
  if (s === 'SOUSDC' || s === 'SOROSWAPUSDC' || s === 'SOROSWAP_USDC') return 'SOUSDC';
  return s;
};

/** Resolves the caller's margin account, creating one on-chain if none exists yet. */
async function ensureMarginAccount(userAddress: string): Promise<string> {
  await checkUserMarginAccount(userAddress);
  const { marginAccountAddress: cachedAddress, hasMarginAccount } = useMarginAccountInfoStore.getState();
  let marginAccountAddress = cachedAddress;
  if (!hasMarginAccount || !marginAccountAddress) {
    const created = await createMarginAccount(userAddress);
    if (!created) {
      throw new Error(
        useMarginAccountInfoStore.getState().accountCreationError || 'Failed to create margin account',
      );
    }
    marginAccountAddress = useMarginAccountInfoStore.getState().marginAccountAddress;
  }
  if (!marginAccountAddress) throw new Error('No margin account available');
  return marginAccountAddress;
}

/**
 * Deposit collateral from the connected wallet into the user's margin account
 * (`AccountManagerContract::deposit_collateral_tokens`) — creates the margin
 * account first if the wallet doesn't have one yet. On success invalidates
 * `['margin']` and force-refreshes the store's collateral balances (the real
 * on-chain `Trader_Deposit` event is what makes this show up in
 * {@link useMarginHistory}, no local history write needed).
 */
export const useDepositCollateral = () => {
  const qc = useQueryClient();
  const address = useUserStore((s) => s.address);

  return useMutation({
    mutationFn: async ({ amount, assetType }: { amount: number; assetType: string }) => {
      if (!address) throw new Error('Please connect your wallet first');
      if (!amount || amount <= 0) throw new Error('Please enter a valid amount');

      const marginAccountAddress = await ensureMarginAccount(address);
      const symbol = normalizeContractTokenSymbol(assetType);
      const result = await MarginAccountService.depositCollateralTokens(
        marginAccountAddress,
        symbol,
        toWad(amount),
      );
      if (!result.success) throw new Error(result.error || 'Deposit failed');
      return { hash: result.hash, amount, assetType, marginAccountAddress };
    },
    onSuccess: async ({ marginAccountAddress }) => {
      qc.invalidateQueries({ queryKey: ['margin'] });
      try {
        await refreshBorrowedBalances(marginAccountAddress, true);
      } catch {
        // Non-fatal — ledger tick / next open reconciles.
      }
    },
  });
};

/**
 * Withdraw collateral from the user's margin account back to their wallet
 * (`AccountManagerContract::withdraw_collateral_balance`) — the contract's own
 * `is_withdraw_allowed` health check is the actual safety gate; this hook does
 * not pre-compute a safe max (callers should, for UX, mirror
 * `transfer-collateral.tsx`'s health-factor-aware cap before calling this).
 * Successful withdrawals are emitted by AccountManager as Trader_Withdraw and
 * appear through Mercury/RPC; no browser-side history is written.
 */
export const useWithdrawCollateral = () => {
  const qc = useQueryClient();
  const address = useUserStore((s) => s.address);

  return useMutation({
    mutationFn: async ({ amount, assetType }: { amount: number; assetType: string }) => {
      if (!address) throw new Error('Please connect your wallet first');
      if (!amount || amount <= 0) throw new Error('Please enter a valid amount');

      const marginAccountAddress = useMarginAccountInfoStore.getState().marginAccountAddress;
      if (!marginAccountAddress) throw new Error('No margin account found for this wallet');

      const symbol = normalizeContractTokenSymbol(assetType);
      const result = await MarginAccountService.withdrawCollateralBalance(
        marginAccountAddress,
        symbol,
        toWad(amount),
      );
      if (!result.success) throw new Error(result.error || 'Withdrawal failed');
      return { hash: result.hash, amount, assetType, symbol, marginAccountAddress };
    },
    onSuccess: async ({ marginAccountAddress }) => {
      qc.invalidateQueries({ queryKey: ['margin'] });
      try {
        await refreshBorrowedBalances(marginAccountAddress, true);
      } catch {
        // Non-fatal — ledger tick / next open reconciles.
      }
    },
  });
};
