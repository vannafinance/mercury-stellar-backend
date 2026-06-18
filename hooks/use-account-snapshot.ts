"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useLedgerTick } from "@/contexts/ledger-subscriber";
import type { MarginSnapshot } from "@/lib/account-snapshot";

export type AccountSnapshot = Partial<MarginSnapshot> & {
  hasMarginAccount: boolean;
  marginAccountAddress?: string;
};

export const ACCOUNT_SNAPSHOT_KEY = ["account-snapshot"] as const;

/**
 * Per-user account snapshot from the cached `/api/account/[addr]` edge route.
 * First paint is instant on a warm edge cache; the ledger tick revalidates
 * (the route's s-maxage=15 absorbs the per-tick checks, so on-chain reads stay
 * ~1 per 15s no matter how often this fires). The user's own mutations should
 * also invalidate ACCOUNT_SNAPSHOT_KEY for an immediate refresh.
 */
export function useAccountSnapshot(userAddress: string | null) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery<AccountSnapshot>({
    queryKey: [...ACCOUNT_SNAPSHOT_KEY, userAddress ?? "none"],
    queryFn: async () => {
      const res = await fetch(`/api/account/${userAddress}`);
      if (!res.ok) throw new Error(`account snapshot failed (${res.status})`);
      return (await res.json()) as AccountSnapshot;
    },
    enabled: Boolean(userAddress),
    staleTime: 12_000, // just under the route's 15s edge TTL
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ACCOUNT_SNAPSHOT_KEY });
  }, [tick, qc]);

  return {
    snapshot: query.data,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => query.refetch(),
  };
}
