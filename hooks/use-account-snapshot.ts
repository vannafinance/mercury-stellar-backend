"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { useLedgerTick } from "@/contexts/ledger-subscriber";
import type { MarginSnapshot } from "@/lib/account-snapshot";

export type AccountSnapshot = Partial<MarginSnapshot> & {
  hasMarginAccount: boolean;
  marginAccountAddress?: string;
};

// Nest under `margin` so every existing post-transaction
// invalidateQueries({ queryKey: ['margin'] }) also refreshes this snapshot.
export const ACCOUNT_SNAPSHOT_KEY = ["margin", "account-snapshot"] as const;

/**
 * Warm the account snapshot into the in-memory React Query cache as soon as the
 * wallet connects, BEFORE the user navigates to the
 * margin page — so the margin/MB views paint instantly from a warm cache instead
 * of waiting on the first cold RPC read. One-shot (not a subscription), and a
 * no-op if the data is already fresh in cache. Safe to call on every connect.
 */
export async function prefetchAccountSnapshot(
  qc: QueryClient,
  userAddress: string | null,
): Promise<void> {
  if (!userAddress) return;
  await qc
    .prefetchQuery({
      queryKey: [...ACCOUNT_SNAPSHOT_KEY, userAddress],
      queryFn: async () => {
        const res = await fetch(`/api/account/${userAddress}`);
        if (!res.ok) throw new Error(`account snapshot failed (${res.status})`);
        return (await res.json()) as AccountSnapshot;
      },
      staleTime: 12_000,
    })
    .catch(() => {
      // Prefetch is best-effort; the page's own useAccountSnapshot will retry.
    });
}

/**
 * Per-user account snapshot from the no-store `/api/account/[addr]` route.
 *
 * React Query keeps the snapshot warm across navigation, while a reload always
 * performs an authoritative chain-backed request. Ledger ticks and mutations
 * invalidate the stable query key.
 *
 * @param userAddress - Connected wallet; the snapshot is scoped to it.
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
    staleTime: 3_000,
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
