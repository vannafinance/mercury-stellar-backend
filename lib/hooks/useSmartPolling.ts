/**
 * useSmartPolling – a polling hook that:
 *   • pauses when the browser tab is hidden
 *   • pauses when the user has been idle for 2 minutes
 *   • resumes instantly when the tab becomes visible again
 *   • supports on-demand refresh via `trigger()`
 */
import { useEffect, useRef, useCallback } from "react";

// ────────────────────────────────────────────────────────────────────
// Visibility / Idle Helpers (inlined — no rpc-cache dependency in Stellar)
// ────────────────────────────────────────────────────────────────────

/** Returns `true` when the browser tab is hidden. SSR-safe. */
function isTabHidden(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden";
}

let lastActivity = typeof Date !== "undefined" ? Date.now() : 0;

function trackActivity() {
  lastActivity = Date.now();
}

// Attach once (module scope — idempotent across imports)
if (typeof window !== "undefined") {
  for (const evt of ["mousemove", "keydown", "scroll", "touchstart"]) {
    window.addEventListener(evt, trackActivity, { passive: true });
  }
}

/** Returns `true` when the user hasn't interacted for `thresholdMs`. */
function isUserIdle(thresholdMs = 120_000): boolean {
  return Date.now() - lastActivity > thresholdMs;
}

// ────────────────────────────────────────────────────────────────────

interface SmartPollingOptions {
  /** Polling interval in ms (default 15 000 — 15 s) */
  interval?: number;
  /** Whether polling is enabled (pass false to pause externally) */
  enabled?: boolean;
  /** User-idle threshold in ms before pausing (default 120 000 — 2 min) */
  idleThreshold?: number;
}

export function useSmartPolling(
  fn: () => void | Promise<void>,
  deps: unknown[],
  opts: SmartPollingOptions = {},
) {
  const { interval = 15_000, enabled = true, idleThreshold = 120_000 } = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Trigger callback for on-demand refresh
  const trigger = useCallback(() => {
    fnRef.current();
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Fire once immediately
    fnRef.current();

    const tick = () => {
      if (isTabHidden() || isUserIdle(idleThreshold)) return;
      fnRef.current();
    };

    timerRef.current = setInterval(tick, interval);

    // Resume on visibility change
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fnRef.current(); // immediate refresh
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, interval, idleThreshold, ...deps]);

  return { trigger };
}
