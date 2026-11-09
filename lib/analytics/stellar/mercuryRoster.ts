// Margin-account roster from Mercury's index of AccountManager events.
//
// Why: the Registry's `SmartAccountsList` stopped growing on 2026-11-04 (the
// list hit Soroban's 64 KiB entry cap and the contracts no longer append to
// it), so every account created since then is missing from it. The list is
// also append-only, so its tail is "most recently CREATED", not "most
// recently USED" — the deep-scan cap was spending its whole budget on old,
// emptied test accounts while active ones were skipped.
//
// Mercury keeps the full AccountManager event history (≈5k events, ~10s to
// page through). From it we take:
//   • every `Smart_account_creation` [name, trader] → data.smart_account,
//     which gives the account AND its owner without one RPC read per account;
//   • the newest event id per account across `Trader_*` events (topic[1] is
//     the smart account), used to order accounts by recent activity;
//   • whether the account's newest `Trader_Borrow` is later than its newest
//     `Trader_Liquidate_Event` — i.e. it may still carry debt. These accounts
//     go to the END of the list so a `slice(-N)` deep-scan cap reaches
//     debtors first instead of freshly created or just-liquidated (empty)
//     accounts, which dominate "most recent activity".
//
// Server-only: needs MERCURY_URL / MERCURY_KEY. Returns null when Mercury is
// not configured or unreachable, so callers fall back to the Registry list.

import * as StellarSdk from "@stellar/stellar-sdk";

import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

export interface RosterEntry {
  account: string;
  owner: string;
  /** Mercury event id of the account's newest event (creation or Trader_*). */
  lastActivityId: number;
  /** Borrowed after its last liquidation (or never liquidated): may hold debt. */
  mayHaveDebt: boolean;
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 200; // 40k events — far above today's ~5.4k
const ROSTER_TTL_MS = 60_000;

let cached: { at: number; entries: RosterEntry[] } | null = null;

function decode(xdrB64: string | undefined): unknown {
  if (!xdrB64) return undefined;
  try {
    return StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(xdrB64, "base64"));
  } catch {
    return undefined;
  }
}

/**
 * Every margin account the AccountManager ever created, with its owner.
 * Ordered so `slice(-N)` keeps the most relevant N: possible debtors (most
 * recently active first), then everything else by recent activity.
 * Null when Mercury is unavailable.
 */
export async function readMarginRosterFromMercury(): Promise<RosterEntry[] | null> {
  if (typeof window !== "undefined") return null;
  const url = process.env.MERCURY_URL;
  const key = process.env.MERCURY_KEY;
  if (!url || !key) return null;
  if (cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.entries;

  const base = url.replace(/\/graphql\/?$/, "");
  const contract = CONTRACT_ADDRESSES.ACCOUNT_MANAGER;
  const owners = new Map<string, string>();
  const lastActivity = new Map<string, number>();
  const lastBorrow = new Map<string, number>();
  const lastLiquidation = new Map<string, number>();

  try {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const u = new URL(`${base}/rest/events/by-contract/${contract}`);
      u.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor) u.searchParams.set("cursor", cursor);
      const res = await fetch(u, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const events = (await res.json()) as Array<{ id: number; topic1?: string; topic2?: string; data?: string }>;
      if (!Array.isArray(events) || events.length === 0) break;

      for (const ev of events) {
        const name = decode(ev.topic1);
        if (name === "Smart_account_creation") {
          const trader = decode(ev.topic2);
          const data = decode(ev.data) as { smart_account?: unknown } | undefined;
          const account = data?.smart_account ? String(data.smart_account) : "";
          if (account && trader) {
            owners.set(account, String(trader));
            lastActivity.set(account, Math.max(lastActivity.get(account) ?? 0, ev.id));
          }
        } else if (typeof name === "string" && name.startsWith("Trader_")) {
          const account = decode(ev.topic2);
          if (typeof account === "string" && account.startsWith("C")) {
            lastActivity.set(account, Math.max(lastActivity.get(account) ?? 0, ev.id));
            if (name === "Trader_Borrow") {
              lastBorrow.set(account, Math.max(lastBorrow.get(account) ?? 0, ev.id));
            } else if (name === "Trader_Liquidate_Event") {
              lastLiquidation.set(account, Math.max(lastLiquidation.get(account) ?? 0, ev.id));
            }
          }
        }
      }

      // Events come newest → oldest; the last id is the next cursor.
      cursor = String(events[events.length - 1].id);
      if (events.length < PAGE_LIMIT) break;
    }
  } catch {
    return null;
  }

  if (owners.size === 0) return null;
  const entries: RosterEntry[] = [...owners.entries()]
    .map(([account, owner]) => ({
      account,
      owner,
      lastActivityId: lastActivity.get(account) ?? 0,
      mayHaveDebt: (lastBorrow.get(account) ?? 0) > (lastLiquidation.get(account) ?? 0),
    }))
    // Possible debtors last (so a tail cap reaches them first), each group by activity.
    .sort((a, b) => Number(a.mayHaveDebt) - Number(b.mayHaveDebt) || a.lastActivityId - b.lastActivityId);
  cached = { at: Date.now(), entries };
  return entries;
}
