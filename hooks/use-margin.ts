'use client';
import { useQuery } from '@tanstack/react-query';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { getMarginHistoryFromMercury } from '@/lib/mercury-margin';
import { getMarginHistoryByAccount, type MarginHistoryEntry } from '@/lib/margin-history';

// Margin transaction history: Mercury (full history — no ~7-day RPC cap) with a
// local-storage overlay merged in by tx-hash.
//
// Why the overlay: the AccountManager `Trader_Borrow` event emits ONLY the asset
// symbol — no amount, no timestamp (unlike `Trader_Repay_Event`). Mercury mirrors
// the chain exactly, so a Mercury-only history shows every borrow as 0.00 at one
// carry-forward time, and has no deposits at all (the contract emits no deposit
// event). We overlay the user's local records (which DO capture amount+timestamp
// for their own deposit/borrow actions) by tx-hash to fill those gaps, while
// keeping Mercury as the source for full cross-device borrow/repay history.
// Remove the overlay once the contract emits amount+timestamp on Trader_Borrow.
//
// NO ledger-tick refetch: the query is heavy (full ledger range + per-borrow tx
// timestamp enrichment). Freshness comes from mount, account change, window focus,
// and margin-mutation invalidation of ['margin'] (prefix-matches ['margin','history']).
const amountIsMissing = (a?: string): boolean => {
  if (!a) return true;
  const t = a.trim();
  if (t === '' || t === '—') return true;
  const n = parseFloat(t);
  return !Number.isFinite(n) || n === 0;
};

export const useMarginHistory = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const query = useQuery({
    queryKey: ['margin', 'history', marginAccountAddress ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<MarginHistoryEntry[]> => {
      if (!marginAccountAddress) return [];
      const mercury = await getMarginHistoryFromMercury(marginAccountAddress);
      const local = getMarginHistoryByAccount(marginAccountAddress);
      const localByKey = new Map<string, MarginHistoryEntry>(
        local.map((e) => [`${e.hash}:${e.type}`, e]),
      );
      const seen = new Set<string>();

      const merged: MarginHistoryEntry[] = mercury.map((m) => {
        const key = `${m.hash}:${m.type}`;
        seen.add(key);
        const l = localByKey.get(key);
        return {
          id: key,
          marginAccountAddress,
          type: m.type,
          asset: m.asset || l?.asset || '',
          // Amount: Trader_Borrow emits none — fill from the local record (Mercury
          // has no chain source for it). Timestamp: Mercury is now authoritative
          // (repay from payload, borrow from Horizon); local only fills a miss.
          amount: amountIsMissing(m.amount) && l ? l.amount : m.amount,
          timestamp: m.timestamp || l?.timestamp || 0,
          hash: m.hash,
        };
      });

      // Local-only entries Mercury can't return (deposits, transfers, or borrows
      // not yet indexed) — additive, deduped by hash+type.
      for (const l of local) {
        if (!seen.has(`${l.hash}:${l.type}`)) merged.push(l);
      }
      return merged;
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
