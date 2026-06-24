import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { fetchContractEvents } from "./mercury-client";
import { enrichTimestampsByTx } from "./mercury-timestamps";
import type { BlendEvent } from "./blend-utils";

// Blend farm history sourced from Mercury (full history — no ~30-day RPC
// getEvents window). Drop-in for BlendService.getBlendEvents, so useBlendEvents
// keeps its BlendEvent[] shape.
//
// The Blend pool uses the margin/earn-style topic layout, so the account is
// filtered SERVER-SIDE via topics (no client-side scan like Soroswap):
//   topic1 = Symbol(action)            → e.eventName ("supply" | "withdraw" | …)
//   topic2 = reserve token address     → e.topics[1]
//   topic3 = the account               → matched by Mercury's topics filter
//   data   = [underlying, bToken]      (i128 ÷ 1e7)
// The pool also emits supply_collateral / withdraw_collateral / borrow / claim
// for the same account — we keep only supply/withdraw, parity with the RPC path.
//
// Blend is a third-party contract: its events carry NO payload timestamp, so
// timestamps come per-tx from Horizon (see enrichTimestampsByTx).

const assetMap: Record<string, string> = {
  [CONTRACT_ADDRESSES.BLEND_XLM]: "XLM",
  [CONTRACT_ADDRESSES.BLEND_USDC]: "USDC",
};

export async function getBlendEventsFromMercury(
  marginAccountAddress: string,
  blendPoolAddress?: string,
): Promise<BlendEvent[]> {
  const pool = blendPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;
  const events = await fetchContractEvents({ contract: pool, account: marginAccountAddress });

  const mine = events
    .filter((e) => e.eventName === "supply" || e.eventName === "withdraw")
    .map((e): BlendEvent => {
      const tokenAddress = typeof e.topics[1] === "string" ? (e.topics[1] as string) : "";
      const body = Array.isArray(e.data) ? (e.data as unknown[]) : [];
      return {
        type: e.eventName as "supply" | "withdraw",
        tokenAddress,
        tokenSymbol: assetMap[tokenAddress] ?? tokenAddress.slice(0, 8) ?? "?",
        underlyingAmount: (Number(body[0] ?? 0) / 1e7).toFixed(7),
        bTokenAmount: (Number(body[1] ?? 0) / 1e7).toFixed(7),
        timestamp: 0,
        txHash: e.tx ?? "",
        ledger: 0,
      };
    });

  await enrichTimestampsByTx(mine);
  return mine.sort((a, b) => b.timestamp - a.timestamp);
}
