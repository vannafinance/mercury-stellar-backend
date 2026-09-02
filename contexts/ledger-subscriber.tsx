"use client";

import { createContext, useContext, useEffect, useState } from "react";
import * as StellarSdk from "@stellar/stellar-sdk";

import { HORIZON_URL } from "@/lib/stellar-utils";

type LedgerCtx = {
  tick: number;
  latestLedger: number;
};

const LedgerContext = createContext<LedgerCtx>({ tick: 0, latestLedger: 0 });

export const useLedgerTick = () => useContext(LedgerContext);

/**
 * Subscribes to Horizon's ledger-close stream and exposes a tick counter
 * plus the latest ledger sequence through React Context.
 *
 * Consumer hooks use a STABLE queryKey and call
 * `qc.invalidateQueries({ queryKey: [...] })` inside a `useEffect` on
 * `tick`. Do NOT put `tick` in the queryKey — a new key on every tick
 * creates fresh cache slots, forcing `isLoading: true` every ~5 s and
 * flickering the UI. See CLAUDE.md §1 for the canonical pattern.
 *
 * Reconnect is handled by the browser's EventSource: on transient network
 * failures it retries automatically and resumes the stream from the last
 * cursor, so no manual retry logic is required. The stream stays open when
 * the tab is hidden — browsers throttle background tabs, keeping bandwidth
 * cost negligible while ensuring the UI returns to fresh data without a
 * reconnect lag.
 */
export function LedgerSubscriberProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [tick, setTick] = useState(0);
  const [latestLedger, setLatestLedger] = useState(0);

  useEffect(() => {
    const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
    // Rate-limit error logs — Horizon SSE flaps constantly on public testnet
    // and was flooding the console / Next overlay without affecting correctness.
    let lastErrLog = 0;
    let closeStream: (() => void) | undefined;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (cancelled) return;
      try {
        closeStream = horizon
          .ledgers()
          .cursor("now")
          .stream({
            onmessage: (ledger) => {
              const record = ledger as StellarSdk.Horizon.ServerApi.LedgerRecord;
              setLatestLedger(Number(record.sequence));
              setTick((t) => t + 1);
            },
            onerror: () => {
              const now = Date.now();
              if (now - lastErrLog > 30_000) {
                lastErrLog = now;
                console.warn("[ledger-subscriber] Horizon SSE reconnecting…");
              }
              // EventSource auto-retries; no extra work required.
            },
          });
      } catch {
        retryTimer = setTimeout(connect, 10_000);
      }
    };
    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        closeStream?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return (
    <LedgerContext.Provider value={{ tick, latestLedger }}>
      {children}
    </LedgerContext.Provider>
  );
}
