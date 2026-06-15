'use client';
import { useQuery } from '@tanstack/react-query';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { getMarginHistoryFromMercury } from '@/lib/mercury-margin';

// Margin transaction history — pure Mercury (full history, no ~7-day RPC cap).
//
// The redeployed AccountManager (2026-06-13) now emits self-describing events:
// Trader_Borrow{token_symbol, token_amount}, Trader_Deposit{token_symbol, amount},
// Trader_Repay_Event{token_symbol, token_amount, timestamp}. So borrow amounts and
// deposits come straight from Mercury — the earlier localStorage overlay (which
// filled the old symbol-only Trader_Borrow gap) is no longer needed and was removed.
// Timestamps: repay from its payload; borrow/deposit per-tx from Horizon (the
// contract emits none, by design) — handled in getMarginHistoryFromMercury.
//
// NO ledger-tick refetch: the query is heavy (full ledger range + per-tx timestamp
// enrichment). Freshness comes from mount, account change, window focus, and the
// margin-mutation invalidation of ['margin'] (prefix-matches ['margin','history']).
export const useMarginHistory = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const query = useQuery({
    queryKey: ['margin', 'history', marginAccountAddress ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async () => {
      if (!marginAccountAddress) return [];
      return getMarginHistoryFromMercury(marginAccountAddress);
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
