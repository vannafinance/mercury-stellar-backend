"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Mirrors the defaults in the Vanna web-app:
 *   staleTime:            15 s (no refetch if another consumer mounts inside window)
 *   gcTime:               5 min (keep unused entries across page navigation)
 *   refetchOnWindowFocus: off  (we poll via useSmartPolling where we want freshness)
 *   retry:                2 with exponential backoff (capped at 10 s)
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  // Lazily instantiated per browser session. Under Next's dev StrictMode the
  // module is evaluated twice on mount, so keeping the client in state avoids
  // constructing two separate caches.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 2,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
