/**
 * Short-lived caching for static service methods whose answer is the same for
 * every caller — Registry address lookups, a Blend reserve's b-rate. The
 * analytics scan calls the Blend / Soroswap / Aquarius position readers once
 * per margin account, and each of those re-read these globals: 16 RPC
 * simulations per account, ~9k for a full scan, which made it run past Cloud
 * Run's 300s request timeout on a rate-limited RPC. Caching them cuts the
 * per-account cost to the reads that actually depend on the account.
 *
 * Only settled, non-null/non-false results are kept, so a failed or empty
 * lookup is retried on the next call instead of being pinned for the TTL.
 * Concurrent callers share one in-flight promise.
 */
export function memoizeStatics<T extends object>(target: T, methods: (keyof T & string)[], ttlMs: number): void {
  for (const name of methods) {
    const original = (target as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    const cache = new Map<string, { at: number; value: Promise<unknown> }>();
    (target as Record<string, unknown>)[name] = function memoized(this: unknown, ...args: unknown[]) {
      const key = JSON.stringify(args);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const value = Promise.resolve((original as (...a: unknown[]) => unknown).apply(this, args));
      cache.set(key, { at: Date.now(), value });
      value.then(
        (v) => {
          if (v === null || v === undefined || v === false) cache.delete(key);
        },
        () => cache.delete(key),
      );
      return value;
    };
  }
}
