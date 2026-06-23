"use client";

// Analytics live-feed hooks. A shared `useTickQuery` primitive centralises the
// oracle/pool-stats/event-feed readers onto the ledger tick (replacing per-page
// setTimeout polling) so they dedupe across pages and refresh without flicker.

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { buildAnalyticsSnapshots } from "@/lib/analytics/stellar/buildSnapshots";
import {
  readOracleSnapshot,
  readAllPoolStats,
  type StellarPoolStats,
  type StellarAnalyticsSource,
} from "@/lib/analytics/stellar/rpcReader";
import { readLiveEventFeed, type LiveEventFeed } from "@/lib/analytics/stellar/eventFeed";
import type { AllAccountsResult } from "@/lib/analytics/onchain/types";

const STELLAR_CHAIN_ID = 0;
const QUERY_KEY = ["analytics", "snapshot"] as const;

/**
 * Shared ledger-tick + React Query primitive for the analytics live feeds.
 * Each feed reader (`readOracleSnapshot`, `readAllPoolStats`,
 * `readLiveEventFeed`) was previously polled from its own page-level
 * `setTimeout(…, 30_000)`. This centralises them on the ledger tick so they
 * refresh when the chain advances, dedupe across pages via the shared cache,
 * and never flicker (stale-while-revalidate).
 */
function useTickQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({ queryKey: key, queryFn, staleTime: 4_000 });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: key });
    // key is a stable module-level literal per hook; spreading it would
    // re-run this effect every render, so we intentionally exclude it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, qc]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: () => query.refetch(),
  };
}

type OracleSnapshot = StellarAnalyticsSource["oracle"];

/** Live oracle snapshot (prices + heartbeat). Polled by oracles/alerts/risk-explorer. */
export function useOracleSnapshot() {
  return useTickQuery<OracleSnapshot>(["analytics", "oracle"], readOracleSnapshot);
}

/** Live lending-pool stats. Polled by the alerts page. */
export function usePoolStats() {
  return useTickQuery<StellarPoolStats[]>(["analytics", "poolStats"], readAllPoolStats);
}

/** Live Soroban event feed (liquidations + whale activity). Polled by liquidations/whales. */
export function useLiveEventFeed() {
  return useTickQuery<LiveEventFeed>(["analytics", "eventFeed"], () => readLiveEventFeed());
}

/**
 * Protocol-wide analytics snapshot on the locked ledger-tick + React Query
 * pattern. Replaces the bespoke `useAnalyticsOnchainStore` (manual TTL +
 * inflight dedup).
 *
 * The protocol-wide scan is fetched from the shared edge-cached route
 * `/api/analytics/accounts` (s-maxage 30s), so the bounded RPC fan-out runs
 * ~once per 30s GLOBALLY rather than in every visitor's browser. The ~5s ledger
 * tick invalidates the client query, but most ticks resolve to a near-free edge
 * cache hit. The connected wallet's own account is refreshed live each time
 * (from the in-memory store) and merged over the cached protocol snapshot.
 */
export function useAnalyticsSnapshot(userAddress: string | null) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: [...QUERY_KEY, userAddress ?? "anon"],
    queryFn: async (): Promise<AllAccountsResult> => {
      const { accounts, realAccountCount } = await buildAnalyticsSnapshots(userAddress);
      return {
        chainId: STELLAR_CHAIN_ID,
        accounts,
        fetchedAt: Date.now(),
        accountCount: accounts.length,
        realAccountCount,
        skippedCount: 0,
      };
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: QUERY_KEY });
  }, [tick, qc]);

  return {
    result: query.data ?? null,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    // The protocol-wide scan is now server-cached (/api/analytics/accounts); a
    // refetch re-runs the connected-wallet self-refresh immediately and pulls
    // the protocol snapshot from the edge cache (≤30s old).
    refresh: () => query.refetch(),
  };
}
