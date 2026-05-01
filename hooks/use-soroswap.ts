'use client';

import { useQuery } from '@tanstack/react-query';
import {
  SoroswapService,
  SoroswapPoolStats,
  SOROSWAP_POOLS,
  SoroswapPoolConfig,
} from '@/lib/soroswap-utils';
import { useBlendStore } from '@/store/blend-store';

// ─────────────────────────────────────────────────────────────────────────────
// All Soroswap pools stats
// ─────────────────────────────────────────────────────────────────────────────

export interface SoroswapPoolWithStats {
  pool: SoroswapPoolConfig;
  stats: SoroswapPoolStats | null;
  isLoading: boolean;
}

export const useAllSoroswapPoolStats = (): SoroswapPoolWithStats[] => {
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
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

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
  const query = useQuery({
    queryKey: ['soroswap', 'poolStats'],
    enabled,
    queryFn: async (): Promise<SoroswapPoolStats | null> => {
      return SoroswapService.getPoolStats();
    },
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
  });

  return {
    stats: query.data ?? null,
    isLoading: query.isLoading || query.isFetching,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Soroswap LP position
// ─────────────────────────────────────────────────────────────────────────────

export const useSoroswapLpPosition = (marginAccountAddress: string | null) => {
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['soroswap', 'lpPosition', marginAccountAddress, refreshKey],
    enabled: Boolean(marginAccountAddress),
    queryFn: async () => {
      if (!marginAccountAddress) return '0';
      return SoroswapService.getLpBalance(marginAccountAddress);
    },
  });

  return {
    lpBalance: query.data ?? '0',
    isLoading: query.isLoading || query.isFetching,
  };
};

// ---------- Soroswap LP events (position history + chart) ----------

export const useSoroswapEvents = (
  pairAddress?: string | null,
  marginAccountAddress?: string | null,
) => {
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['soroswap', 'lpEvents', pairAddress ?? null, marginAccountAddress ?? null, refreshKey],
    enabled: Boolean(pairAddress && marginAccountAddress),
    queryFn: async () => {
      if (!pairAddress || !marginAccountAddress) return [];
      return SoroswapService.getSoroswapLpEvents(pairAddress, marginAccountAddress);
    },
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    refetchInterval: pairAddress && marginAccountAddress ? 10_000 : false,
    refetchOnWindowFocus: true,
  });

  return { events: query.data ?? [], isLoading: query.isLoading || query.isFetching };
};

// ---------- Soroswap token balance in margin account ----------

export const useSoroswapTokenBalance = (
  marginAccountAddress: string | null,
  tokenSymbol: 'XLM' | 'USDC' | null,
) => {
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['soroswap', 'tokenBalance', marginAccountAddress, tokenSymbol, refreshKey],
    enabled: Boolean(marginAccountAddress && tokenSymbol),
    queryFn: async () => {
      if (!marginAccountAddress || !tokenSymbol) return '0';
      return SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, tokenSymbol);
    },
  });

  return {
    balance: query.data ?? '0',
    isLoading: query.isLoading || query.isFetching,
  };
};
