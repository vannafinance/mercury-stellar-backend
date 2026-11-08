import { fetchContractEvents } from "./mercury-client";
import { enrichTimestampsByTx } from "./mercury-timestamps";
import type { SoroswapLpEvent } from "./soroswap-utils";

// Soroswap LP history sourced from Mercury (full history — no ~30-day RPC
// getEvents window). Drop-in for SoroswapService.getSoroswapLpEvents, so
// useSoroswapEvents keeps its SoroswapLpEvent[] shape.
//
// IMPORTANT — this is NOT the margin (AccountManager) shape. The Soroswap pair
// emits its rich liquidity events as:
//   topic1 = Symbol("SoroswapPair")           ← namespace, NOT the event name
//   topic2 = Symbol("deposit" | "withdraw")   ← the actual event name
//   data   = { amount_0, amount_1, liquidity, new_reserve_0, new_reserve_1, to }
// The account lives in `data.to`, NOT in a topic — so Mercury's server-side
// `topics` account filter (which the margin adapter relies on) does NOT match
// these. We therefore fetch the pair's events un-scoped and filter by `data.to`
// client-side. (The topic-scopable mint/burn events carry only the share amount
// and don't reliably identify the user — mint→user in topic3, but burn→pair.)
//
// Fidelity vs the RPC getEvents path:
//   shares / amount_0 / amount_1 → full (i128 ÷ 1e7 STROOP; amount_0=XLM token_0)
//   timestamp / ledger           → NOT obtainable from Mercury. The REST event row
//     has no ledger/close-time column, and every Mercury GraphQL path that could
//     join one (allContractEvents, txInfoByTxHash, ledgerBySequence, allLedgers)
//     returns a server error on the testnet instance (verified 2026-06-10). So we
//     recover close-time per-tx from HORIZON (deduped by hash). Horizon — not
//     Soroban RPC getTransaction — because RPC retains txs only ~days, which would
//     drop exactly the historical events Mercury exists to provide (the chart filters
//     `timestamp <= 0`). Horizon keeps full history; LP actions per account are sparse,
//     so this is a handful of requests. A Retroshade table that indexes events WITH
//     closeTime is the eventual zero-external-call fix (mainnet path).

const STROOP = 1e7;
const toHuman = (raw: unknown): string => {
  try {
    return (Number(BigInt(String(raw))) / STROOP).toFixed(7);
  } catch {
    return "0";
  }
};

interface SoroswapLiquidityData {
  amount_0?: unknown;
  amount_1?: unknown;
  liquidity?: unknown;
  to?: unknown;
}

export async function getSoroswapLpEventsFromMercury(
  pairAddress: string,
  marginAccountAddress: string,
): Promise<SoroswapLpEvent[]> {
  // Un-scoped: the account is in data.to, not a topic, so Mercury can't filter
  // it. Walk the pair's full event history and keep this account's lp actions.
  const events = await fetchContractEvents({ contract: pairAddress });

  const mine = events
    .map((e) => {
      const kind = e.topics[1]; // topic2 = "deposit" | "withdraw" | "sync" | "swap"
      if (kind !== "deposit" && kind !== "withdraw") return null;
      const d = (e.data ?? {}) as SoroswapLiquidityData;
      if (d.to !== marginAccountAddress) return null;
      return {
        type: kind as "deposit" | "withdraw",
        shareAmount: toHuman(d.liquidity),
        amountXLM: toHuman(d.amount_0), // token_0 = XLM on the XLM/USDC pair
        amountUSDC: toHuman(d.amount_1),
        timestamp: 0,
        txHash: e.tx ?? "",
        ledger: 0,
      } as SoroswapLpEvent;
    })
    .filter((e): e is SoroswapLpEvent => e !== null);

  await enrichTimestampsByTx(mine);
  return mine.sort((a, b) => b.timestamp - a.timestamp);
}
