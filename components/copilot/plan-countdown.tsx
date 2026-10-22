"use client";

import { useEffect, useState } from "react";

/**
 * The approval window beside a plan's Approve (as on the Solana Copilot): 5 minutes from when the plan's figures were
 * read, counting down from 4:59. At 0:00 Approve closes ("Expired: ask again") so a plan is approved on figures that
 * are minutes old, not hours. This is the window to approve in; the server's own record lifetime (`PLAN_TTL_MS`) is
 * unchanged, and Approve still re-reads live funds before anything is built.
 */
export const PLAN_APPROVAL_WINDOW_MS = 5 * 60_000;

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Remaining time as m:ss, counting whole seconds down (a fresh window reads 4:59, never 5:00). */
function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The window ending at `expiresAt` (epoch ms), ticking every second while `active`. Null `expiresAt`: no window. */
export function usePlanCountdown(expiresAt: number | null, active = true): { expired: boolean; clock: string } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || expiresAt == null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, expiresAt]);
  if (expiresAt == null) return { expired: false, clock: "" };
  const remaining = expiresAt - now;
  return { expired: remaining <= 0, clock: mmss(remaining) };
}

/** "Expires in 4:59" beside Approve; "Expired" once the window has passed. */
export function PlanCountdown({ expired, clock }: { expired: boolean; clock: string }) {
  return (
    <span
      aria-live="polite"
      className="inline-flex items-baseline gap-1.5 uppercase"
      style={{
        fontFamily: MONO,
        fontVariantNumeric: "tabular-nums",
        fontSize: 10.5,
        letterSpacing: ".16em",
        color: expired ? "var(--pc-danger-fg)" : "var(--pc-muted)",
      }}
    >
      {expired ? "Expired" : <>Expires in <span style={{ fontSize: 13, letterSpacing: ".04em", color: "var(--pc-heading)" }}>{clock}</span></>}
    </span>
  );
}
