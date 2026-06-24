'use client';

// React Query hooks over the shared Reflector-oracle price cache. Seed prices
// synchronously from the cache for the first render, then refresh on each ledger
// close and on external cache updates from other consumers.

import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchTokenPrices,
  getCachedTokenPrice,
  subscribePriceUpdates,
} from '@/lib/oracle-price';
import { useLedgerTick } from '@/contexts/ledger-subscriber';

const buildPricesMap = (tokens: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of tokens) {
    const upper = (t || '').toUpperCase().trim();
    if (!upper) continue;
    out[upper] = getCachedTokenPrice(upper);
  }
  return out;
};

/**
 * Returns an always-up-to-date USD price map for the requested token symbols.
 * Reads from the shared oracle cache for the synchronous initial render and
 * refreshes from the on-chain Reflector oracle on each new ledger close.
 *
 * External oracle cache updates (from other consumers) trigger query
 * invalidation so cross-component price changes propagate to all subscribers.
 */
export function useTokenPrices(tokens: string[]): Record<string, number> {
  const { tick } = useLedgerTick();
  const queryClient = useQueryClient();
  const lastTickRef = useRef(tick);

  const key = useMemo(() => {
    const unique = Array.from(
      new Set(tokens.map((t) => (t || '').toUpperCase().trim()).filter(Boolean))
    );
    unique.sort();
    return unique.join(',');
  }, [tokens]);

  const symbols = useMemo(() => (key ? key.split(',') : []), [key]);

  const { data } = useQuery({
    queryKey: ['oracle', 'prices', key],
    queryFn: async () => {
      if (symbols.length === 0) return {} as Record<string, number>;
      return await fetchTokenPrices(symbols);
    },
    enabled: symbols.length > 0,
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    queryClient.invalidateQueries({ queryKey: ['oracle', 'prices'] });
  }, [tick, queryClient]);

  useEffect(() => {
    const unsubscribe = subscribePriceUpdates(() => {
      queryClient.invalidateQueries({ queryKey: ['oracle', 'prices'] });
    });
    return unsubscribe;
  }, [queryClient]);

  return useMemo(() => {
    const baseline = buildPricesMap(symbols);
    return data ? { ...baseline, ...data } : baseline;
  }, [data, symbols]);
}

/** Single-symbol convenience wrapper. */
export function useTokenPrice(token: string): number {
  const map = useTokenPrices([token]);
  const upper = (token || '').toUpperCase().trim();
  return map[upper] ?? getCachedTokenPrice(upper);
}
