"use client";

/**
 * A chain step goes out once per subject, not once per mount.
 *
 * The effects that carry an investigation onward — prepare the nominated plan, post the
 * pending lifecycle write, press Approve for an armed session — were guarded by `useRef`s
 * inside `CopilotWorkspace`. That component unmounts on any navigation away from /copilot,
 * while the state feeding those effects does not: the investigation lives in the root
 * layout so a run survives leaving the page, and the journal id lives in `localStorage`.
 * Returning to /copilot therefore met an empty guard holding a finished turn, and the last
 * prompt was sent a second time.
 *
 * The guard is kept where the data is, so the two have the same lifetime. The in-memory set
 * is what makes a remount idempotent; the mirror in storage extends that across a reload,
 * where the thread is rehydrated from sessionStorage and would otherwise replay too.
 * A claim is handed back when the dispatch it covered did not happen, so a failure is still
 * retryable.
 */
const LIMIT = 64;

const claimed = new Map<string, Set<string>>();

function storeKey(owner: string | null): string {
  return `vanna-copilot-dispatched:${owner ?? "guest"}`;
}

function memory(owner: string | null): Set<string> {
  const existing = claimed.get(storeKey(owner));
  if (existing) return existing;
  const fresh = new Set<string>();
  claimed.set(storeKey(owner), fresh);
  return fresh;
}

function stored(owner: string | null): string[] {
  try {
    const raw = localStorage.getItem(storeKey(owner));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function persist(owner: string | null, keys: readonly string[]): void {
  try {
    localStorage.setItem(storeKey(owner), JSON.stringify(keys.slice(-LIMIT)));
  } catch {
    /* the in-memory set still covers this page load */
  }
}

/** True for the one caller that may dispatch; false once this subject has been sent. */
export function claimDispatch(owner: string | null, key: string): boolean {
  const seen = memory(owner);
  if (seen.has(key)) return false;
  const keys = stored(owner);
  if (keys.includes(key)) {
    seen.add(key);
    return false;
  }
  seen.add(key);
  persist(owner, [...keys, key]);
  return true;
}

/** Give the claim back: the dispatch it covered did not happen, so it may be tried again. */
export function releaseDispatch(owner: string | null, key: string): void {
  memory(owner).delete(key);
  const keys = stored(owner);
  if (!keys.includes(key)) return;
  persist(owner, keys.filter((entry) => entry !== key));
}

/** Test seam: this module's memory outlives a component, so a test must be able to clear it. */
export function forgetDispatchClaims(): void {
  claimed.clear();
}
