"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useLedgerTick } from "@/contexts/ledger-subscriber";
import type { MarginSnapshot } from "@/lib/account-snapshot";

export type AccountSnapshot = Partial<MarginSnapshot> & {
  hasMarginAccount: boolean;
  marginAccountAddress?: string;
};

export const ACCOUNT_SNAPSHOT_KEY = ["account-snapshot"] as const;

// Per-account snapshot cache (stale-while-revalidate). Persisting the last
// snapshot KEYED BY WALLET lets a reload paint real values instantly instead of
// flashing an empty store, then revalidate in the background. It is safe
// precisely because it is per-account: the earlier balance-bleed bug came from
// blanket, wallet-agnostic persistence — here wallet B can only ever read
// wallet B's entry.
const LS_PREFIX = "vanna:account-snapshot:";

type CachedSnapshot = { data: AccountSnapshot; ts: number };

function readCachedSnapshot(wallet: string): CachedSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + wallet);
    return raw ? (JSON.parse(raw) as CachedSnapshot) : null;
  } catch {
    return null;
  }
}

function writeCachedSnapshot(wallet: string, data: AccountSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LS_PREFIX + wallet,
      JSON.stringify({ data, ts: Date.now() }),
    );
  } catch {
    // localStorage full / unavailable — non-fatal, we just lose instant reload.
  }
}

/**
 * Per-user account snapshot from the cached `/api/account/[addr]` edge route.
 *
 * First paint is instant: a reload seeds React Query from the per-account
 * localStorage entry (stale-while-revalidate), so real values show immediately
 * while a fresh snapshot loads in the background. A warm edge cache also makes
 * the network round-trip near-instant. The ledger tick revalidates; the route's
 * 15s s-maxage absorbs the per-tick checks (~1 on-chain read / 15s regardless of
 * how often this fires). The user's own mutations should also invalidate
 * ACCOUNT_SNAPSHOT_KEY for an immediate refresh.
 *
 * @param userAddress - Connected wallet; the snapshot is scoped to it.
 */
export function useAccountSnapshot(userAddress: string | null) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  // Read the persisted snapshot once per wallet so a reload has data to paint
  // before the network round-trip completes.
  const cached = useMemo(
    () => (userAddress ? readCachedSnapshot(userAddress) : null),
    [userAddress],
  );

  const query = useQuery<AccountSnapshot>({
    queryKey: [...ACCOUNT_SNAPSHOT_KEY, userAddress ?? "none"],
    queryFn: async () => {
      const res = await fetch(`/api/account/${userAddress}`);
      if (!res.ok) throw new Error(`account snapshot failed (${res.status})`);
      const data = (await res.json()) as AccountSnapshot;
      if (userAddress) writeCachedSnapshot(userAddress, data);
      return data;
    },
    enabled: Boolean(userAddress),
    staleTime: 12_000, // just under the route's 15s edge TTL
    // Stale-while-revalidate across reloads: seed from the per-account cache and
    // tell RQ how old it is, so a stale entry paints instantly AND triggers an
    // immediate background refetch.
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.ts,
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
