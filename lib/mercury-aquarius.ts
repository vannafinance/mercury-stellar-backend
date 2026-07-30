import { fetchContractEvents } from "./mercury-client";
import { enrichTimestampsByTx } from "./mercury-timestamps";
import type { AquariusLpEvent } from "./aquarius-utils";

// Aquarius LP history sourced from Mercury via the POOL's own deposit_liquidity /
// withdraw_liquidity events.
//
// The AccountManager used to emit account-scoped Trader_AquariusDeposit /
// Trader_AquariusWithdraw events (the original source this file read), but the
// 2026-07-19 Controller-Facade refactor removed ALL event publishing from the
// exec path (confirmed: exhaustive grep of account_manager.rs and
// AquariusControllerContract for `events().publish` turns up nothing on the
// exec/execute call paths) — so that event has not fired since, and Mercury/RPC
// queries against it silently go stale for any action taken after the port.
//
// The pool's own deposit_liquidity/withdraw_liquidity events are still real
// (Aquarius's own external contract, untouched by our refactor), but — unlike
// Soroswap's pair event, which carries `data.to` — the pool's event body is
// just `[share_amount, amountA, amountB]` with no account field at all. Some
// pool versions carry the depositor in a topic, some don't (confirmed in
// AquariusService.getAquariusEvents' own comment), so this can only do
// best-effort attribution: keep an event if none of its topics decode to an
// address at all (nothing to filter on), or if one of them matches. This is
// the same class of caveat Soroswap's un-scoped fetch already has, just via
// topics instead of a data field.
const SHARE_SCALE = 1e7;

interface AquariusLiquidityData {
  [index: number]: unknown;
}

export async function getAquariusPoolEventsFromMercury(
  poolAddress: string,
  marginAccountAddress: string,
): Promise<AquariusLpEvent[]> {
  // Un-scoped: Mercury's server-side `account` filter needs a reliable topic
  // position, which this event doesn't consistently have — walk the pool's
  // full event history and filter client-side, like Soroswap's pair events.
  const events = await fetchContractEvents({ contract: poolAddress });

  const mine = events
    .map((e) => {
      const kind = e.eventName;
      if (kind !== "deposit_liquidity" && kind !== "withdraw_liquidity") return null;

      const topicAddresses = e.topics
        .slice(1)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (topicAddresses.length > 0 && !topicAddresses.includes(marginAccountAddress)) {
        return null;
      }

      const body = (Array.isArray(e.data) ? e.data : null) as AquariusLiquidityData | null;
      if (!body) return null;
      const toHuman = (v: unknown) => (Number(v ?? 0) / SHARE_SCALE).toFixed(7);

      return {
        type: kind === "deposit_liquidity" ? "deposit" : "withdraw",
        shareAmount: toHuman(body[0]),
        amountA: toHuman(body[1]),
        amountB: toHuman(body[2]),
        timestamp: 0,
        txHash: e.tx ?? "",
        ledger: 0,
      } as AquariusLpEvent;
    })
    .filter((e): e is AquariusLpEvent => e !== null);

  await enrichTimestampsByTx(mine);
  return mine.sort((a, b) => b.timestamp - a.timestamp);
}
