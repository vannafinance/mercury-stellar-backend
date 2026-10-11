"use client";

import { useUserStore } from "@/store/user";
import { useAnalyticsSnapshot } from "@/hooks/use-analytics";
import { usePathname } from "next/navigation";

/**
 * Keeps the Analytics protocol snapshot warm outside Copilot, mounted once at the
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
  const pathname = usePathname();
  // Protocol-wide scans are unrelated to Copilot and can occupy its request connections.
  // Other routes retain the same shared-cache preload and ledger subscriptions.
  if (pathname === "/copilot") return null;
  return <ConnectedAnalyticsPrefetcher />;
}

function ConnectedAnalyticsPrefetcher() {
  const address = useUserStore((s) => s.address);
  useAnalyticsSnapshot(address);
  return null;
}
