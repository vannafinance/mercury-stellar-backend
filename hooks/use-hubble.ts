"use client";

import { useQuery } from "@tanstack/react-query";

// Client hooks for the Hubble analytics routes. Hubble data is batch/aggregate
// and cached server-side for 5 min, so this uses a plain React Query with a
// matching staleTime — NOT the ledger tick (that's for live chain state).

/** Thrown when a Hubble route returns 503 (the Hubble backend isn't configured). Not retried. */
export class HubbleNotConfiguredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "HubbleNotConfiguredError";
  }
}

async function fetchHubble<T>(path: string): Promise<T[]> {
  const res = await fetch(path);
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    throw new HubbleNotConfiguredError(body?.detail ?? "Hubble not configured");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T[];
}

/**
 * Generic React Query hook for a Hubble analytics route returning an array of T.
 * Hubble data is aggregate and server-cached for 5 min, so this uses a plain
 * 5-min staleTime (NOT the ledger tick — that's for live chain state). A 503
 * surfaces as {@link HubbleNotConfiguredError} and is not retried; other errors
 * retry up to twice.
 *
 * @param key - Cache-key suffix under `["hubble", key]`.
 * @param path - Route to fetch.
 */
export function useHubble<T>(key: string, path: string) {
  return useQuery<T[]>({
    queryKey: ["hubble", key],
    queryFn: () => fetchHubble<T>(path),
    staleTime: 300_000, // matches the route's s-maxage=300
    retry: (count, err) => !(err instanceof HubbleNotConfiguredError) && count < 2,
  });
}
