"use client";

import { useUserStore } from "@/store/user";
import { useAnalyticsSnapshot } from "@/hooks/use-analytics";

/**
 * Warms the protocol-wide analytics snapshot query as soon as the app
 * mounts, regardless of which page the user lands on first. Without this,
 * `useAnalyticsSnapshot` only ran once the user actually navigated to
 * /analytics/overview2, so every first visit showed a "Loading margin
 * accounts from Soroban…" spinner even though the underlying scan is a
 * shared, edge-cached read that could have started the moment the app
 * mounted. React Query dedupes this against the Analytics page's own call to
 * the same hook (identical queryKey), so mounting it here doesn't double-fetch
 * — it just means the cache is already warm by the time the user gets there.
 */
export function AnalyticsPrefetcher() {
  const address = useUserStore((s) => s.address);
  useAnalyticsSnapshot(address);
  return null;
}
