"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Horizon, rpc as sorobanRpc } from "@stellar/stellar-sdk";
import {
  HORIZON_URL,
  SOROBAN_RPC_URL,
  CONTRACT_ADDRESSES,
} from "@/lib/stellar-utils";

type LedgerCtx = {
  /** Increments on every Stellar ledger close (~5s). Use as a queryKey dep. */
  tick: number;
  /** Latest ledger sequence observed via Horizon SSE. */
  latestLedger: number;
};

const Ctx = createContext<LedgerCtx>({ tick: 0, latestLedger: 0 });

export const useLedgerTick = () => useContext(Ctx);

// Contracts whose events should trigger query invalidation. Pulled from
// CONTRACT_ADDRESSES (env-backed) so test/staging/mainnet just swap addresses.
const WATCHED_CONTRACTS: string[] = [
  CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_EURC,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC,
];

const EVENTS_POLL_INTERVAL_MS = 5_000;
const EVENTS_LOOKBACK_LEDGERS = 5; // start a few ledgers back so we don't miss boot events

// Soroban RPC enforces a hard limit of 5 contractIds per filter.
// Chunk the watched list and submit one filter per chunk (filters are OR'd
// together by the RPC, so we still see events from every contract).
const MAX_CONTRACTS_PER_FILTER = 5;
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const EVENT_FILTERS = chunk(WATCHED_CONTRACTS, MAX_CONTRACTS_PER_FILTER).map(
  (ids) => ({ type: "contract" as const, contractIds: ids })
);

export function LedgerSubscriberProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);
  const [latestLedger, setLatestLedger] = useState(0);

  // ─────────────────────────────────────────────────────────────────
  // STREAM A — Horizon SSE: tick on every ledger close (~5 s)
  // ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const horizon = new Horizon.Server(HORIZON_URL);
    const close = horizon
      .ledgers()
      .cursor("now")
      .stream({
        onmessage: (ledger: { sequence: number | string }) => {
          setLatestLedger(Number(ledger.sequence));
          setTick((t) => t + 1);
          qc.invalidateQueries({ queryKey: ["snapshot"] });
          qc.invalidateQueries({ queryKey: ["accountView"] });
        },
        onerror: (err: unknown) => {
          console.warn("[ledger-subscriber] Horizon SSE error:", err);
        },
      });

    return () => {
      try {
        close();
      } catch {
        /* noop */
      }
    };
  }, [qc]);

  // ─────────────────────────────────────────────────────────────────
  // STREAM B — Soroban events poll (every 5 s) → Mercury / RQ invalidation
  // ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const soroban = new sorobanRpc.Server(SOROBAN_RPC_URL);
    let stop = false;
    let startLedger: number | undefined;

    async function loop() {
      while (!stop) {
        try {
          if (startLedger === undefined) {
            const latest = await soroban.getLatestLedger();
            startLedger = latest.sequence - EVENTS_LOOKBACK_LEDGERS;
          }

          const resp = await soroban.getEvents({
            startLedger,
            filters: EVENT_FILTERS,
            limit: 100,
          });

          for (const ev of resp.events) {
            handleEvent(ev as { topic?: unknown[] }, qc);
          }

          // Advance to one past the RPC's latest seen ledger so the next
          // poll picks up only fresh events. Avoids pagingToken/Number cast bugs.
          if (
            typeof resp.latestLedger === "number" &&
            resp.latestLedger >= startLedger
          ) {
            startLedger = resp.latestLedger + 1;
          }
        } catch (err) {
          console.warn("[ledger-subscriber] Soroban events error:", err);
        }
        await new Promise((r) => setTimeout(r, EVENTS_POLL_INTERVAL_MS));
      }
    }

    loop();

    return () => {
      stop = true;
    };
  }, [qc]);

  return (
    <Ctx.Provider value={{ tick, latestLedger }}>{children}</Ctx.Provider>
  );
}

function handleEvent(ev: { topic?: unknown[] }, qc: QueryClient) {
  const rawTopic = ev.topic?.[0];
  const topic =
    typeof rawTopic === "string"
      ? rawTopic
      : (rawTopic as { toString?: () => string } | undefined)?.toString?.() ??
        "";

  // Trader actions / lending pool deposits/withdraws/mints/burns
  if (topic.startsWith("Trader_") || topic.includes("event")) {
    qc.invalidateQueries({ queryKey: ["accountView"] });
    qc.invalidateQueries({ queryKey: ["mercury", "history"] });
    qc.invalidateQueries({ queryKey: ["snapshot"] });
  }

  // Smart account lifecycle (creation / activation / deactivation / closure)
  if (topic.includes("Smart_Account_") || topic === "Smart_account_creation") {
    qc.invalidateQueries({ queryKey: ["accounts"] });
  }
}
