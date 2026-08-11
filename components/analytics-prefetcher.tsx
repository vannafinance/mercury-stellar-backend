"use client";

import { useUserStore } from "@/store/user";
import { useAnalyticsSnapshot } from "@/hooks/use-analytics";

/**
 * Keeps the Analytics protocol snapshot warm app-wide, mounted once at the
 * layout level (like MarginAccountHydrator) instead of only inside
 * /analytics/overview2. `useAnalyticsSnapshot` is a plain React Query
 * `useQuery` call — mounting it here subscribes to the SAME cache entry the
 * Analytics page reads, so whichever page loads first (Earn, Margin, ...)
 * starts the fetch immediately, and by the time the user actually navigates
 * to Analytics the query is already warm (and kept warm via the existing
 * ledger-tick invalidation) instead of showing a cold "Loading margin
 * accounts from Soroban…" spinner on every fresh app load.
 */
export function AnalyticsPrefetcher() {
  const address = useUserStore((s) => s.address);
  useAnalyticsSnapshot(address);
  return null;
}
