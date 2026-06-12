import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { fetchContractEvents } from "./mercury-client";
import { fetchTxTimestamps } from "./mercury-timestamps";

// Margin transaction history sourced from Mercury (full history — no ~7-day RPC
// cap). Same output shape as the old RPC path, so it's a drop-in for
// useMarginHistory.
//
// Event data fidelity (decoded from AccountManager) — forward-compatible across the
// 2026-06 contract upgrade (PR #4: Trader_Borrow gains token_amount, new Trader_Deposit,
// timestamps dropped by design — ledgerClosedAt is recovered from Horizon):
//   Trader_Repay_Event → { token_symbol, token_amount (WAD), timestamp }      → full
//   Trader_Deposit     → { token_symbol, amount (WAD) }                       → new event
//   Trader_Borrow      → OLD build: bare asset-symbol string (no amount) → "—", local
//                        overlay fills it; NEW build: { token_symbol, token_amount } (WAD).
// None of borrow/deposit carry a timestamp → enriched per-tx from Horizon (created_at),
// full history, deduped — same helper as the Soroswap/Blend adapters.

export interface MarginTxEntry {
  type: "borrow" | "repay" | "deposit";
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
    (e) =>
      e.eventName === "Trader_Borrow" ||
      e.eventName === "Trader_Repay_Event" ||
      e.eventName === "Trader_Deposit",
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
    if (e.eventName === "Trader_Deposit") {
      // New contract: { smart_account, token_symbol, amount } (WAD, no timestamp).
      const d = (e.data ?? {}) as Record<string, unknown>;
      return {
        type: "deposit",
        asset: String(d.token_symbol ?? ""),
        amount: wadToHuman(d.amount).toFixed(7),
        timestamp: 0,
        hash: e.tx ?? "",
      };
    }
    // Trader_Borrow — forward-compatible across the contract upgrade:
    //   OLD (live now): data is the bare asset symbol string → amount unknown ("—",
    //     filled by the useMarginHistory local overlay).
    //   NEW (post-deploy): data is { smart_account, token_symbol, token_amount } (WAD).
    // Neither carries a timestamp → Horizon enrich below.
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      return {
        type: "borrow",
        asset: String(d.token_symbol ?? ""),
        amount: wadToHuman(d.token_amount).toFixed(7),
        timestamp: 0,
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

  // Borrows + deposits carry no timestamp in the event — resolve the real ledger
  // close time per-tx from Horizon (full history, deduped). Repays already have a
  // payload timestamp, so only entries left at 0 need it.
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
