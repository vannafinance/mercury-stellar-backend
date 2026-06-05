'use client';
import { useQuery } from '@tanstack/react-query';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { getMarginHistoryFromMercury } from '@/lib/mercury-margin';

// Margin transaction history from Mercury (full history — no ~7-day RPC cap).
//
// D21 migration: source is Mercury (no localStorage merge), and there is NO
// ledger-tick refetch. History is append-only and the query is comparatively
// heavy (full ledger range + per-borrow tx timestamp enrichment), so re-polling
// every ~5s is wasteful. Freshness comes from: mount, account change, window
// focus, and margin-mutation invalidation — borrow/repay mutations invalidate
// ['margin'], which prefix-matches ['margin','history'] and triggers a refetch
// exactly when the history actually changes.
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
