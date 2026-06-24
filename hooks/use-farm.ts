'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { getBlendEventsFromMercury } from '@/lib/mercury-blend';
import { getAquariusEventsFromMercury } from '@/lib/mercury-aquarius';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { useLedgerTick } from '@/contexts/ledger-subscriber';

// Farm-page data hooks for the Blend, Aquarius, and Soroswap integrations. All
// the query hooks follow the same shape: a React Query keyed by resource, a 4s
// staleTime for stale-while-revalidate, and ledger-tick invalidation so data
// refreshes when the chain advances without flicker. Event hooks add window-focus
// refetch; per-account hooks gate on the margin account address.

// ─────────────────────────────────────────────────────────────────────────────
// Pool stats
// ─────────────────────────────────────────────────────────────────────────────

/** Blend reserve stats for the two supported assets, or null until loaded. */
export interface FarmPoolStats {
  XLM: BlendReserveData | null;
  USDC: BlendReserveData | null;
}

const EMPTY_STATS: FarmPoolStats = { XLM: null, USDC: null };

/**
 * Blend XLM/USDC reserve stats. Ledger-tick invalidated, 4s stale-while-
 * revalidate. Returns `{ stats, isLoading, isRefreshing, error, refresh }`.
 * @param enabled - Gate the query (e.g. only when the Blend tab is visible).
 */
export const useBlendPoolStats = (enabled = true) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'blend', 'poolStats'],
    enabled,
    queryFn: async (): Promise<FarmPoolStats> => {
      const data = await BlendService.getAllBlendReserveStats();
      return { XLM: data.XLM, USDC: data.USDC };
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'blend', 'poolStats'] });
  }, [tick, qc]);

  return {
    stats: query.data ?? EMPTY_STATS,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// User Blend positions
// ─────────────────────────────────────────────────────────────────────────────

/** The margin account's Blend positions per asset plus their combined value in XLM. */
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

/**
 * The connected margin account's Blend positions (XLM + USDC, plus total XLM
 * value). Gated on the margin account address; ledger-tick invalidated. Returns
 * `{ positions, isLoading, isRefreshing, error, refresh }`.
 */
export const useUserBlendPositions = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'blend', 'userPositions', marginAccountAddress],
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
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'blend', 'userPositions'] });
  }, [tick, qc]);

  return {
    positions: query.data ?? EMPTY_USER,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Blend events / position history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The margin account's Blend supply/withdraw event history from Mercury,
 * optionally filtered to one token. Gated on the margin account address;
 * ledger-tick invalidated and refetches on window focus. Returns
 * `{ events, isLoading, isRefreshing, error, refresh }`.
 * @param tokenSymbol - Optional token filter (e.g. "XLM").
 */
export const useBlendEvents = (tokenSymbol?: string) => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'blend', 'events', marginAccountAddress, tokenSymbol ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<BlendEvent[]> => {
      if (!marginAccountAddress) return [];
      const all = await getBlendEventsFromMercury(marginAccountAddress);
      return tokenSymbol ? all.filter((e) => e.tokenSymbol === tokenSymbol) : all;
    },
    refetchOnWindowFocus: true,
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'blend', 'events'] });
  }, [tick, qc]);

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// All Aquarius pools stats
// ─────────────────────────────────────────────────────────────────────────────

/** One configured Aquarius pool paired with its fetched stats (null until loaded) and a loading flag. */
export interface AquariusPoolWithStats {
  pool: AquariusPoolConfig;
  stats: AquariusPoolStats | null;
  isLoading: boolean;
}

/**
 * Stats for every configured Aquarius pool, fetched concurrently
 * (`Promise.allSettled`, so one failing pool doesn't sink the rest). Ledger-tick
 * invalidated. Returns one {@link AquariusPoolWithStats} per pool in config order.
 */
export const useAllAquariusPoolStats = (): AquariusPoolWithStats[] => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

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
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'aquarius', 'allPoolStats'] });
  }, [tick, qc]);

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

/**
 * Stats for a single Aquarius pool. Gated on `poolAddress`; ledger-tick
 * invalidated. Returns `{ stats, isLoading, isRefreshing }`.
 */
export const useAquariusPoolStats = (poolAddress: string | null) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'poolStats', poolAddress],
    enabled: Boolean(poolAddress),
    queryFn: async (): Promise<AquariusPoolStats | null> => {
      if (!poolAddress) return null;
      return AquariusService.getAquariusPoolStats(poolAddress);
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'aquarius', 'poolStats'] });
  }, [tick, qc]);

  return {
    stats: query.data ?? null,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius LP position
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The margin account's LP balance in a single Aquarius pool. Gated on both
 * addresses; ledger-tick invalidated. Returns `{ lpBalance, isLoading, isRefreshing }`.
 */
export const useAquariusLpPosition = (
  marginAccountAddress: string | null,
  poolAddress: string | null,
) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'lpPosition', marginAccountAddress, poolAddress],
    enabled: Boolean(marginAccountAddress && poolAddress),
    queryFn: async () => {
      if (!marginAccountAddress || !poolAddress) return '0';
      return AquariusService.getUserLpBalance(marginAccountAddress, poolAddress);
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'aquarius', 'lpPosition'] });
  }, [tick, qc]);

  return {
    lpBalance: query.data ?? '0',
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// All Aquarius LP positions (one query for all pools)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The margin account's LP balances across all Aquarius pools in one query
 * (concurrent `Promise.allSettled`, keyed by pool id). Gated on the account
 * address; ledger-tick invalidated. Returns `{ positions, isLoading, isRefreshing }`
 * where `positions` maps pool id → balance string.
 */
export const useAllAquariusLpPositions = (marginAccountAddress: string | null) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'allLpPositions', marginAccountAddress],
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
    staleTime: 4_000,
    gcTime: 5 * 60_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'aquarius', 'allLpPositions'] });
  }, [tick, qc]);

  return {
    positions: query.data ?? {},
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Aquarius LP events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The margin account's Aquarius deposit/withdraw event history from Mercury.
 *
 * Mercury-sourced and scoped by account: the Aquarius *pool* event has no
 * depositor, so it's unattributable per-account. Instead we read the
 * AccountManager's margin-side Trader_AquariusDeposit / Trader_AquariusWithdraw
 * events, which carry the smart account in a topic → Mercury scopes by account
 * server-side (see lib/mercury-aquarius.ts). `poolAddress` is no longer needed
 * for the query (the AM events aren't pool-scoped) but is kept in the signature
 * for the call sites. Gated on the account address; ledger-tick invalidated and
 * refetches on window focus. Returns `{ events, isLoading, isRefreshing }`.
 */
export const useAquariusEvents = (poolAddress: string | null, marginAccountAddress?: string | null) => {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['farm', 'aquarius', 'events', marginAccountAddress ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async (): Promise<AquariusLpEvent[]> => {
      if (!marginAccountAddress) return [];
      return getAquariusEventsFromMercury(marginAccountAddress);
    },
    refetchOnWindowFocus: true,
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['farm', 'aquarius', 'events'] });
  }, [tick, qc]);

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};

// ---------- Aquarius LP chart helper ----------
/**
 * Builds a cumulative LP-balance time series from deposit/withdraw events, for
 * charting. Accepts any event with `{ type, shareAmount, timestamp }`. With no
 * events but a positive balance, emits a 12-month flat line so all time-range
 * filters render. Running balance is floored at 0.
 *
 * @returns Sorted `{ date, amount }[]` (date = YYYY-MM-DD).
 */
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

/**
 * Builds a cumulative supplied-value time series from Blend supply/withdraw
 * events, for charting. With no events but a positive value, emits a 12-month
 * flat line so all time-range filters render. Running value is floored at 0.
 *
 * @returns Sorted `{ date, amount }[]` (date = YYYY-MM-DD).
 */
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
