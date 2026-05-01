'use client';

import { useQuery } from '@tanstack/react-query';
import {
  BlendService,
  BlendReserveData,
  BlendUserPosition,
  BlendEvent,
} from '@/lib/blend-utils';
import {
  AquariusService,
  AquariusPoolStats,
  AquariusLpEvent,
  AQUARIUS_POOLS,
  AquariusPoolConfig,
} from '@/lib/aquarius-utils';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { useBlendStore } from '@/store/blend-store';

// ─────────────────────────────────────────────────────────────────────────────
// Pool stats
// ─────────────────────────────────────────────────────────────────────────────

export interface FarmPoolStats {
  XLM: BlendReserveData | null;
  USDC: BlendReserveData | null;
}

const EMPTY_STATS: FarmPoolStats = { XLM: null, USDC: null };

export const useBlendPoolStats = (enabled = true) => {
  const query = useQuery({
    queryKey: ['farm', 'blend', 'poolStats'],
    enabled,
    queryFn: async (): Promise<FarmPoolStats> => {
      const data = await BlendService.getAllBlendReserveStats();
      return { XLM: data.XLM, USDC: data.USDC };
    },
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
  });

  return {
    stats: query.data ?? EMPTY_STATS,
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// User Blend positions
// ─────────────────────────────────────────────────────────────────────────────

export interface UserBlendPositions {
  XLM: BlendUserPosition;
  USDC: BlendUserPosition;
  totalValueXLM: string;
}

const EMPTY_POSITION: BlendUserPosition = { bTokenBalance: '0', underlyingValue: '0', tokenSymbol: '' };
const EMPTY_USER: UserBlendPositions = {
  XLM: EMPTY_POSITION,
  USDC: EMPTY_POSITION,
  totalValueXLM: '0',
};

export const useUserBlendPositions = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    // refreshKey is included so mutations can bump the store → invalidate.
    queryKey: ['farm', 'blend', 'userPositions', marginAccountAddress, refreshKey],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<UserBlendPositions> => {
      if (!marginAccountAddress) return EMPTY_USER;
      const data = await BlendService.getAllUserBlendPositions(marginAccountAddress);
      const xlmVal = parseFloat(data.XLM?.underlyingValue ?? '0');
      const usdcVal = parseFloat(data.USDC?.underlyingValue ?? '0');
      return {
        XLM: data.XLM ?? { ...EMPTY_POSITION, tokenSymbol: 'XLM' },
        USDC: data.USDC ?? { ...EMPTY_POSITION, tokenSymbol: 'USDC' },
        totalValueXLM: (xlmVal + usdcVal).toFixed(4),
      };
    },
  });

  return {
    positions: query.data ?? EMPTY_USER,
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Blend events / position history
// ─────────────────────────────────────────────────────────────────────────────

export const useBlendEvents = (tokenSymbol?: string) => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['farm', 'blend', 'events', marginAccountAddress, tokenSymbol ?? null, refreshKey],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<BlendEvent[]> => {
      if (!marginAccountAddress) return [];
      const all = await BlendService.getBlendEvents(marginAccountAddress);
      return tokenSymbol ? all.filter((e) => e.tokenSymbol === tokenSymbol) : all;
    },
    refetchInterval: marginAccountAddress ? 10_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// All Aquarius pools stats
// ─────────────────────────────────────────────────────────────────────────────

export interface AquariusPoolWithStats {
  pool: AquariusPoolConfig;
  stats: AquariusPoolStats | null;
  isLoading: boolean;
}

export const useAllAquariusPoolStats = (): AquariusPoolWithStats[] => {
  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'allPoolStats'],
    queryFn: async () => {
      const results = await Promise.allSettled(
        AQUARIUS_POOLS.map((p) =>
          AquariusService.getAquariusPoolStats(p.poolAddress).then((s) => ({ id: p.id, stats: s }))
        )
      );
      const map: Record<string, AquariusPoolStats | null> = {};
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

  return AQUARIUS_POOLS.map((p) => ({
    pool: p,
    stats: statsMap[p.id] ?? null,
    isLoading: loading,
  }));
};

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius pool stats (single)
// ─────────────────────────────────────────────────────────────────────────────

export const useAquariusPoolStats = (poolAddress: string | null) => {
  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'poolStats', poolAddress],
    enabled: Boolean(poolAddress),
    queryFn: async (): Promise<AquariusPoolStats | null> => {
      if (!poolAddress) return null;
      return AquariusService.getAquariusPoolStats(poolAddress);
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return {
    stats: query.data ?? null,
    isLoading: query.isLoading || query.isFetching,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius LP position
// ─────────────────────────────────────────────────────────────────────────────

export const useAquariusLpPosition = (
  marginAccountAddress: string | null,
  poolAddress: string | null,
) => {
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'lpPosition', marginAccountAddress, poolAddress, refreshKey],
    enabled: Boolean(marginAccountAddress && poolAddress),
    queryFn: async () => {
      if (!marginAccountAddress || !poolAddress) return '0';
      return AquariusService.getUserLpBalance(marginAccountAddress, poolAddress);
    },
  });

  return {
    lpBalance: query.data ?? '0',
    isLoading: query.isLoading || query.isFetching,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// All Aquarius LP positions (one query for all pools)
// ─────────────────────────────────────────────────────────────────────────────

export const useAllAquariusLpPositions = (marginAccountAddress: string | null) => {
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'allLpPositions', marginAccountAddress, refreshKey],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<Record<string, string>> => {
      if (!marginAccountAddress) return {};
      const results = await Promise.allSettled(
        AQUARIUS_POOLS.map(async (pool) => ({
          poolId: pool.id,
          balance: await AquariusService.getUserLpBalance(
            marginAccountAddress,
            pool.poolAddress,
            pool.tokens[0],
            pool.tokens[1],
          ),
        }))
      );
      const map: Record<string, string> = {};
      results.forEach((r) => {
        if (r.status === 'fulfilled') map[r.value.poolId] = r.value.balance;
      });
      return map;
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  return { positions: query.data ?? {}, isLoading: query.isLoading || query.isFetching };
};

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius LP events
// ─────────────────────────────────────────────────────────────────────────────

export const useAquariusEvents = (poolAddress: string | null, marginAccountAddress?: string | null) => {
  const refreshKey = useBlendStore((s) => s.refreshKey);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'events', poolAddress, marginAccountAddress ?? null, refreshKey],
    enabled: Boolean(poolAddress && marginAccountAddress),
    queryFn: async (): Promise<AquariusLpEvent[]> => {
      if (!poolAddress || !marginAccountAddress) return [];
      return AquariusService.getAquariusEvents(poolAddress, marginAccountAddress);
    },
    refetchInterval: poolAddress && marginAccountAddress ? 10_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading || query.isFetching,
  };
};

// ---------- Aquarius LP chart helper ----------
// Builds cumulative LP balance chart from deposit/withdraw events.
// Accepts any event type that has type, shareAmount, and timestamp.
export const buildLpChartData = (
  events: Array<{ type: 'deposit' | 'withdraw'; shareAmount: string; timestamp: number }>,
  currentLpBalance: number
): Array<{ date: string; amount: number }> => {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  if (events.length === 0) {
    if (currentLpBalance <= 0) return [];
    // No event history — build a monthly flat-line series covering the last 12 months
    const points: Array<{ date: string; amount: number }> = [];
    for (let m = 12; m >= 1; m--) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - m);
      d.setDate(1);
      points.push({ date: d.toISOString().split('T')[0], amount: currentLpBalance });
    }
    points.push({ date: todayStr, amount: currentLpBalance });
    return points;
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  let running = 0;
  const points: Array<{ date: string; amount: number }> = [];

  const firstTs = sorted[0].timestamp;
  if (firstTs) {
    const startDate = new Date(firstTs - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    points.push({ date: startDate, amount: 0 });
  }

  for (const ev of sorted) {
    const delta = parseFloat(ev.shareAmount);
    running += ev.type === 'deposit' ? delta : -delta;
    running = Math.max(0, running);
    const date = ev.timestamp
      ? new Date(ev.timestamp).toISOString().split('T')[0]
      : todayStr;
    points.push({ date, amount: parseFloat(running.toFixed(7)) });
  }

  if (currentLpBalance > 0) {
    points.push({ date: todayStr, amount: parseFloat(currentLpBalance.toFixed(7)) });
  }

  return points;
};

export const buildSupplyChartData = (
  events: BlendEvent[],
  currentValue: number,
): Array<{ date: string; amount: number }> => {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  if (events.length === 0) {
    if (currentValue <= 0) return [];
    // No event history — build a monthly flat-line series covering the last 12 months
    // so all time-range filters ("3 Months", "6 Months", "1 Year") show data.
    const points: Array<{ date: string; amount: number }> = [];
    for (let m = 12; m >= 1; m--) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - m);
      d.setDate(1);
      points.push({ date: d.toISOString().split('T')[0], amount: currentValue });
    }
    points.push({ date: todayStr, amount: currentValue });
    return points;
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  let running = 0;
  const points: Array<{ date: string; amount: number }> = [];

  const firstTs = sorted[0].timestamp;
  if (firstTs) {
    const startDate = new Date(firstTs - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    points.push({ date: startDate, amount: 0 });
  }

  for (const ev of sorted) {
    const delta = parseFloat(ev.underlyingAmount);
    running += ev.type === 'supply' ? delta : -delta;
    running = Math.max(0, running);
    const date = ev.timestamp
      ? new Date(ev.timestamp).toISOString().split('T')[0]
      : todayStr;
    points.push({ date, amount: parseFloat(running.toFixed(4)) });
  }

  if (currentValue > 0) {
    points.push({ date: todayStr, amount: parseFloat(currentValue.toFixed(4)) });
  }

  return points;
};
