import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { fetchContractEvents } from "./mercury-client";

// Margin transaction history sourced from Mercury (full history — no ~7-day RPC
// cap). Same output shape as the old RPC path, so it's a drop-in for
// useMarginHistory.
//
// Event data fidelity (decoded from AccountManager):
//   Trader_Repay_Event → { token_symbol, token_amount (1e18 WAD), timestamp }  → full
//   Trader_Borrow      → asset symbol only (no amount, no timestamp in event)
//                        → amount "—" (parity with the old RPC path); display
//                          time uses carry-forward ordering (below).
//
// PERF: this is ONE Mercury REST call — no per-event RPC enrichment. (An earlier
// version resolved each borrow's timestamp via getTransaction; that was 1 RPC per
// borrow, which slowed page load and contended with margin-state RPC. Dropped.)
// Exact borrow timestamps will arrive for free once the contract emits
// timestamp+amount on Trader_Borrow (see the contract-gap note / Notion).

export interface MarginTxEntry {
  type: "borrow" | "repay";
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

export async function getMarginHistoryFromMercury(
  marginAccountAddress: string,
): Promise<MarginTxEntry[]> {
  // Mercury filters to this account SERVER-SIDE (by-contract + topics) and
  // returns full history via cursor pagination, newest-first — so the order is
  // already chronological and there is no global-limit cap.
  const events = await fetchContractEvents({
    contract: CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
    account: marginAccountAddress,
  });

  // Account already filtered by Mercury; just keep the event types we render.
  const mine = events.filter(
    (e) => e.eventName === "Trader_Borrow" || e.eventName === "Trader_Repay_Event",
  );

  const mapped: MarginTxEntry[] = mine.map((e) => {
    if (e.eventName === "Trader_Repay_Event") {
      const d = (e.data ?? {}) as Record<string, unknown>;
      return {
        type: "repay",
        asset: String(d.token_symbol ?? ""),
        amount: wadToHuman(d.token_amount).toFixed(7),
        timestamp: Number(d.timestamp ?? 0) * 1000,
        hash: e.tx ?? "",
      };
    }
    return {
      type: "borrow",
      asset: typeof e.data === "string" ? e.data : "",
      amount: "—",
      timestamp: 0,
      hash: e.tx ?? "",
    };
  });

  // Carry-forward (list is newest-first): a borrow has no timestamp in its event,
  // so it inherits the nearest more-recent event's time. Keeps chronological
  // ordering without any RPC. Exact times come with the contract fix.
  let lastTs = Date.now();
  for (const entry of mapped) {
    if (entry.timestamp > 0) lastTs = entry.timestamp;
    else entry.timestamp = lastTs;
  }

  return mapped;
}
