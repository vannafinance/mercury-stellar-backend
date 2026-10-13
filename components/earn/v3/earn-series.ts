/**
 * History series for the Earn charts (Overall Deposit, Net Earnings, My Supply), rebuilt from the
 * wallet's indexed lending-pool events (Mercury, merged with the bounded RPC fallback, via
 * useEarnTransactions) plus today's live position — never from browser storage. Clearing the
 * browser's cache must not change what's shown; Mercury (and on-chain state) is the only source
 * of truth.
 *
 * Stellar's deposit_event carries only the underlying amount (no vToken shares), so the pool's
 * past exchange rate can't be pinned at each event the way the Solana design does. The value
 * line therefore replays the real supply / withdraw amounts (net supplied principal) for every
 * past point — the same simplification the pre-V3 Earn page used — and the last point is the
 * exact live position (interest included), so every chart ends on the headline figure. USD uses
 * today's oracle price, as the headline does.
 *
 * An asset is only replayed when its history has at least one event; an asset with a live
 * position but no indexed events can't be rebuilt, and the caller falls back to a flat line at
 * the live value — a past curve is never invented.
 */
import type { EarnTxEntry } from "@/lib/mercury-earn";

export const HOUR = 36e5;
export const DAY = 864e5;
/** Chart ranges (design TFS). */
export const TFS = ["1 Week", "1 Month", "3 Months", "All Time"] as const;
export type Tf = (typeof TFS)[number];

export interface SeriesPoint {
  t: number;
  v: number;
}

/** Inputs shared by the list and pool pages. */
export interface SeriesInput {
  /** Indexed supply / withdraw events (`asset` = pool key, amount in underlying units). */
  rows: EarnTxEntry[];
  /** Live supplied value (underlying units, interest included) per pool key. */
  live: Record<string, number>;
  /** USD price per pool key. */
  prices: Record<string, number>;
}

/** Result of a build: the points, or why the past can't be drawn. */
export interface SeriesResult {
  pts: SeriesPoint[];
  /** True when every pool with a position / history was replayed. */
  complete: boolean;
  /** Pool keys left out (no indexed history behind a live position, or no oracle price). */
  excluded: string[];
}

/** Ascending signed principal deltas for one pool. */
function eventsFor(key: string, rows: EarnTxEntry[]) {
  return rows
    .filter((r) => r.asset === key && r.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) => ({ t: r.timestamp, d: (r.type === "supply" ? 1 : -1) * (parseFloat(r.amount) || 0) }));
}

/** Time grid for a range (the design's `grid()`): 6 h steps for a week, daily otherwise, 50 steps for All Time. */
export function grid(tf: Tf, first: number | null, now: number): number[] {
  const pts: number[] = [];
  if (tf === "All Time") {
    const s = first !== null ? Math.min(first, now - HOUR) : now - DAY;
    const step = Math.max(HOUR, (now - s) / 50);
    for (let t = s; t < now - step / 2; t += step) pts.push(t);
    pts.push(now);
    return pts;
  }
  const d = new Date(now);
  if (tf === "1 Week") d.setDate(d.getDate() - 7);
  else d.setMonth(d.getMonth() - (tf === "1 Month" ? 1 : 3));
  d.setHours(0, 0, 0, 0);
  const step = tf === "1 Week" ? 6 * HOUR : DAY;
  for (let t = d.getTime(); t < now - step / 2; t += step) pts.push(t);
  pts.push(now);
  return pts;
}

/**
 * Value series in USD for `keys`: net supplied principal at each past grid point (clamped at 0),
 * the live position at `now`.
 */
export function buildValueSeries(tf: Tf, keys: readonly string[], inp: SeriesInput, now: number): SeriesResult {
  const excluded: string[] = [];
  const lines: { ev: { t: number; d: number }[]; live: number; price: number }[] = [];
  for (const key of keys) {
    const ev = eventsFor(key, inp.rows);
    const live = inp.live[key] ?? 0;
    if (!ev.length && !(live > 0)) continue;
    const price = inp.prices[key] ?? 0;
    if (!ev.length || !(price > 0)) {
      excluded.push(key);
      continue;
    }
    lines.push({ ev, live, price });
  }
  const firsts = lines.map((l) => l.ev[0].t);
  const first = firsts.length ? Math.min(...firsts) : null;
  const pts = grid(tf, first, now).map((t) => ({
    t,
    v: lines.reduce((s, l) => {
      if (t >= now) return s + l.live * l.price;
      let p = 0;
      for (const e of l.ev) {
        if (e.t > t) break;
        p += e.d;
      }
      return s + Math.max(0, p) * l.price;
    }, 0),
  }));
  return { pts, complete: excluded.length === 0, excluded };
}

/** A flat line at the live value across the range (used when the past can't be reconstructed). */
export function flatSeries(tf: Tf, value: number, now: number): SeriesPoint[] {
  const g = grid(tf, null, now);
  return [
    { t: g[0], v: value },
    { t: now, v: value },
  ];
}
