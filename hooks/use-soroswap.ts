'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SoroswapService,
  SoroswapPoolStats,
  SOROSWAP_POOLS,
  SoroswapPoolConfig,
} from '@/lib/soroswap-utils';
import { getSoroswapLpEventsFromMercury } from '@/lib/mercury-soroswap';
import { useLedgerTick } from '@/contexts/ledger-subscriber';

// ─────────────────────────────────────────────────────────────────────────────
// All Soroswap pools stats
// ─────────────────────────────────────────────────────────────────────────────

export interface SoroswapPoolWithStats {
  pool: SoroswapPoolConfig;
  stats: SoroswapPoolStats | null;
  isLoading: boolean;
}

export const useAllSoroswapPoolStats = (): SoroswapPoolWithStats[] => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['soroswap', 'allPoolStats'],
    queryFn: async () => {
      const results = await Promise.allSettled(
        SOROSWAP_POOLS.map((p) =>
          SoroswapService.getPoolStats().then((s) => ({ id: p.id, stats: s })),
        ),
      );
      const map: Record<string, SoroswapPoolStats | null> = {};
      results.forEach((r) => {
        if (r.status === 'fulfilled') map[r.value.id] = r.value.stats;
      });
      return map;
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['soroswap', 'allPoolStats'] });
  }, [tick, qc]);

  const statsMap = query.data ?? {};
  const loading = query.isLoading;

  return SOROSWAP_POOLS.map((p) => ({
    pool: p,
    stats: statsMap[p.id] ?? null,
    isLoading: loading,
  }));
};

// ─────────────────────────────────────────────────────────────────────────────
// Soroswap pool stats (single)
// ─────────────────────────────────────────────────────────────────────────────

export const useSoroswapPoolStats = (enabled = true) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['soroswap', 'poolStats'],
    enabled,
    queryFn: async (): Promise<SoroswapPoolStats | null> => {
      return SoroswapService.getPoolStats();
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['soroswap', 'poolStats'] });
  }, [tick, qc]);

  return {
    stats: query.data ?? null,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Soroswap LP position
// ─────────────────────────────────────────────────────────────────────────────

export const useSoroswapLpPosition = (marginAccountAddress: string | null) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['soroswap', 'lpPosition', marginAccountAddress],
    enabled: Boolean(marginAccountAddress),
    queryFn: async () => {
      if (!marginAccountAddress) return '0';
      return SoroswapService.getLpBalance(marginAccountAddress);
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['soroswap', 'lpPosition'] });
  }, [tick, qc]);

  return {
    lpBalance: query.data ?? '0',
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ---------- Soroswap LP events (position history + chart) ----------

export const useSoroswapEvents = (
  pairAddress?: string | null,
  marginAccountAddress?: string | null,
) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['soroswap', 'lpEvents', pairAddress ?? null, marginAccountAddress ?? null],
    enabled: Boolean(pairAddress && marginAccountAddress),
    queryFn: async () => {
      if (!pairAddress || !marginAccountAddress) return [];
      return getSoroswapLpEventsFromMercury(pairAddress, marginAccountAddress);
    },
    staleTime: 4_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['soroswap', 'lpEvents'] });
  }, [tick, qc]);

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ---------- Soroswap token balance in margin account ----------

export const useSoroswapTokenBalance = (
  marginAccountAddress: string | null,
  tokenSymbol: 'XLM' | 'USDC' | null,
) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['soroswap', 'tokenBalance', marginAccountAddress, tokenSymbol],
    enabled: Boolean(marginAccountAddress && tokenSymbol),
    queryFn: async () => {
      if (!marginAccountAddress || !tokenSymbol) return '0';
      return SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, tokenSymbol);
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['soroswap', 'tokenBalance'] });
  }, [tick, qc]);

  return {
    balance: query.data ?? '0',
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};
