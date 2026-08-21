/**
 * Server-side idempotency for writes and approved plans.
 *
 * Confirmed live (Z-07, §16): two concurrent identical "lend 1 XLM" requests both
 * executed independently — two real transactions, not one deduped into the other.
 * The UI's Run button disables while loading, so an ordinary double-click never
 * reaches the server twice, but a retry, a second tab, or a replayed request below
 * that layer still could. This is the second gate, not the only one — the client-side
 * disabled button remains the first and cheapest line of defence.
 *
 * In-memory, single-process. Good enough for this app's current deployment (one Next.js
 * server, no horizontal scaling) and for exactly the class of race this closes — a
 * request repeated within seconds of itself. It is not a substitute for a persistent,
 * cross-instance idempotency key if this ever runs behind a load balancer.
 */

const DEDUPE_WINDOW_MS = 8_000;
const MAX_ENTRIES = 2_000;

const seen = new Map<string, number>();

function sweep(now: number): void {
  if (seen.size < MAX_ENTRIES) return;
  for (const [key, ts] of seen) {
    if (now - ts > DEDUPE_WINDOW_MS) seen.delete(key);
  }
}

/**
 * Claim a key for `windowMs` (defaults to `DEDUPE_WINDOW_MS`). Returns `true` the first time a key is claimed
 * (caller should proceed), `false` if the same key was already claimed inside the
 * window (caller should refuse — this is a repeat of a request already in flight or
 * just completed).
 */
export function claimOnce(
  key: string,
  now: number = Date.now(),
  windowMs: number = DEDUPE_WINDOW_MS,
): boolean {
  sweep(now);
  const last = seen.get(key);
  if (last != null && now - last < windowMs) {
    return false;
  }
  seen.set(key, now);
  return true;
}

/** Stable key for an approved plan — the plan_id is already a content fingerprint. */
export function planDedupeKey(planId: string): string {
  return `plan:${planId}`;
}

/**
 * Stable key for a single write — trader + op + asset + amount. Deliberately coarse:
 * this is only meant to catch the SAME instruction repeated within seconds, not to
 * distinguish "lend 1 XLM" said twice on purpose five minutes apart (that already
 * falls outside the window).
 */
export function writeDedupeKey(opts: {
  trader?: string | null;
  op?: string | null;
  asset?: string | null;
  amount?: number | null;
}): string {
  return [
    "write",
    opts.trader ?? "",
    opts.op ?? "",
    opts.asset ?? "",
    opts.amount ?? "",
  ].join(":");
}
