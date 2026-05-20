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
 * plus the latest ledger sequence through React Context. Consumer hooks
 * include the tick in their queryKey to drive ledger-paced cache
 * invalidation in TanStack Query.
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

    const closeStream = horizon
      .ledgers()
      .cursor("now")
      .stream({
        onmessage: (ledger) => {
          const record = ledger as StellarSdk.Horizon.ServerApi.LedgerRecord;
          setLatestLedger(Number(record.sequence));
          setTick((t) => t + 1);
        },
        onerror: (err) => {
          console.warn("[ledger-subscriber] Horizon SSE error", err);
        },
      });

    return () => {
      closeStream();
    };
  }, []);

  return (
    <LedgerContext.Provider value={{ tick, latestLedger }}>
      {children}
    </LedgerContext.Provider>
  );
}
