import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { CREDIT_EVENTS } from "./credit-layer";
import { symbolForToken } from "./margin-credit-reads";
import { fetchContractEvents } from "./mercury-client";
import { fetchTxTimestamps } from "./mercury-timestamps";

// Margin transaction history sourced from Mercury (full history — no ~7-day RPC
// cap). Same output shape as the RPC path, so it's a drop-in for
// useMarginHistory.
//
// Credit-layer events (testnet redeploy 2026-11-06), topic[0] = name,
// topic[1] = margin address, data = { margin, token (address), amount (WAD) }:
//   collateral_deposited → deposit
//   collateral_withdrawn → withdraw
//   borrowed             → borrow
//   repaid               → repay (amount = what was actually paid, capped at the debt)
// None carry a timestamp → enriched per-tx from Horizon (created_at), full
// history, deduped — same helper as the Soroswap/Blend adapters.

export interface MarginTxEntry {
  type: "borrow" | "repay" | "deposit" | "withdraw";
  asset: string;
  amount: string;
  timestamp: number;
  hash: string;
}

const WAD = BigInt("1000000000000000000");
const wadToHuman = (raw: unknown): number => {
  try {
    const bi = BigInt(String(raw));
    return Number(bi / WAD) + Number(bi % WAD) / 1e18;
  } catch {
    return 0;
  }
};

/** Event name → history row type, for the four credit-layer margin events. */
export const MARGIN_EVENT_TYPES: Record<string, MarginTxEntry["type"]> = {
  [CREDIT_EVENTS.deposited]: "deposit",
  [CREDIT_EVENTS.withdrawn]: "withdraw",
  [CREDIT_EVENTS.borrowed]: "borrow",
  [CREDIT_EVENTS.repaid]: "repay",
};

/**
 * Decodes one credit-layer margin event payload into a history row, or null
 * when it is not one of the four margin events (or belongs to another account).
 */
export function marginEventToEntry(
  eventName: string | null | undefined,
  data: unknown,
  hash: string,
  timestamp: number,
  marginAccountAddress?: string,
): MarginTxEntry | null {
  const type = eventName ? MARGIN_EVENT_TYPES[eventName] : undefined;
  if (!type) return null;
  const d = (data ?? {}) as Record<string, unknown>;
  if (marginAccountAddress && d.margin && String(d.margin) !== marginAccountAddress) return null;
  return {
    type,
    asset: symbolForToken(String(d.token ?? "")),
    amount: wadToHuman(d.amount).toFixed(7),
    timestamp,
    hash,
  };
}

export async function getMarginHistoryFromMercury(
  marginAccountAddress: string,
): Promise<MarginTxEntry[]> {
  // Mercury filters to this account SERVER-SIDE (by-contract + topics) and
  // returns full history via cursor pagination, newest-first.
  const events = await fetchContractEvents({
    contract: CONTRACT_ADDRESSES.CREDIT_LAYER,
    account: marginAccountAddress,
  });

  const mapped: MarginTxEntry[] = [];
  for (const e of events) {
    const row = marginEventToEntry(e.eventName, e.data, e.tx ?? "", 0, marginAccountAddress);
    if (row) mapped.push(row);
  }

  // No credit-layer event carries a timestamp — resolve the real ledger close
  // time per-tx from Horizon (full history, deduped).
  const pendingHashes = mapped.filter((e) => e.timestamp <= 0 && e.hash).map((e) => e.hash);
  if (pendingHashes.length > 0) {
    const byHash = await fetchTxTimestamps(pendingHashes);
    for (const entry of mapped) {
      if (entry.timestamp <= 0) {
        const hit = byHash.get(entry.hash);
        if (hit) entry.timestamp = hit.ts;
      }
    }
  }

  return mapped;
}
