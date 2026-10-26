import { computeMarginSnapshot, type MarginSnapshot } from "@/lib/account-snapshot";

/**
 * One account snapshot per turn, not one per consumer.
 *
 * `computeMarginSnapshot` is the slow read (6-13 s against the public RPC). It already joins reads that are IN FLIGHT together, but
 * not one that has just finished: the position seed, the sizing basis and the display read of one turn each started their own when
 * they ran one after another. A result younger than `SNAPSHOT_REUSE_MS` is handed to the next caller instead.
 *
 * What it never does:
 *  - serve a caller that knows about a newer on-chain event (`freshAfter`, the post-run read): that one always reads again, and its
 *    result becomes what the next caller reuses;
 *  - keep a failed read, or one that is older than the window;
 *  - change the website's own snapshot code or its semantics: this wraps the call on the copilot side only.
 * Off with `COPILOT_SNAPSHOT_REUSE=off`; under vitest it is off unless `COPILOT_SNAPSHOT_REUSE=on`.
 */
export const SNAPSHOT_REUSE_MS = 10_000;

const recent = new Map<string, { startedAt: number; snapshot: MarginSnapshot }>();

function enabled(): boolean {
  const setting = process.env.COPILOT_SNAPSHOT_REUSE?.toLowerCase();
  if (setting === "off") return false;
  if (process.env.VITEST) return setting === "on";
  return true;
}

export async function computeMarginSnapshotReused(
  smartAccount: string,
  opts?: { freshAfter?: string | null },
  now: () => number = Date.now,
): Promise<MarginSnapshot> {
  if (!enabled()) return computeMarginSnapshot(smartAccount, opts?.freshAfter ? { freshAfter: opts.freshAfter } : undefined);
  const startedAt = now();
  if (!opts?.freshAfter) {
    const held = recent.get(smartAccount);
    if (held && startedAt - held.startedAt >= 0 && startedAt - held.startedAt <= SNAPSHOT_REUSE_MS) {
      console.info("[copilot] account snapshot reused", { ageMs: startedAt - held.startedAt });
      return held.snapshot;
    }
  }
  const snapshot = await computeMarginSnapshot(smartAccount, opts?.freshAfter ? { freshAfter: opts.freshAfter } : undefined);
  recent.set(smartAccount, { startedAt, snapshot });
  for (const [key, entry] of recent) if (startedAt - entry.startedAt > SNAPSHOT_REUSE_MS) recent.delete(key);
  return snapshot;
}

/** Test seam. */
export function resetSnapshotReuse(): void {
  recent.clear();
}
