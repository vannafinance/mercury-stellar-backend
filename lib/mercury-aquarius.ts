import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { fetchContractEvents } from "./mercury-client";
import { enrichTimestampsByTx } from "./mercury-timestamps";
import type { AquariusLpEvent } from "./aquarius-utils";

// Aquarius LP history sourced from Mercury via the AccountManager's margin-side
// Trader_AquariusDeposit / Trader_AquariusWithdraw events. The Aquarius *pool*
// event carries no depositor (unattributable), so the AM emits these instead
// with the smart account in a topic — meaning we can filter SERVER-SIDE by
// account (like margin/blend), no client-side scan.
//
// Verified shape on the new AM (CAWVGDG3…, 2026-06-19):
//   topic1 = "Trader_AquariusDeposit" | "Trader_AquariusWithdraw"   → e.eventName
//   topic2 = smart_account                                          → server-filtered
//   data   = { smart_account, token_symbol, amount_a, amount_b, shares }
//            amount_a / amount_b are WAD (÷1e18); shares is LP-token units (÷1e7).
//
// The AM event has no payload timestamp → recovered per-tx from Horizon.
const WAD = 1e18;
const SHARE_SCALE = 1e7;

export async function getAquariusEventsFromMercury(
  marginAccountAddress: string,
): Promise<AquariusLpEvent[]> {
  const events = await fetchContractEvents({
    contract: CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
    account: marginAccountAddress,
  });

  const mine = events
    .filter(
      (e) =>
        e.eventName === "Trader_AquariusDeposit" ||
        e.eventName === "Trader_AquariusWithdraw",
    )
    .map((e): AquariusLpEvent => {
      const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
      return {
        type: e.eventName === "Trader_AquariusDeposit" ? "deposit" : "withdraw",
        amountA: (Number(d.amount_a ?? 0) / WAD).toFixed(7),
        amountB: (Number(d.amount_b ?? 0) / WAD).toFixed(7),
        shareAmount: (Number(d.shares ?? 0) / SHARE_SCALE).toFixed(7),
        timestamp: 0,
        txHash: e.tx ?? "",
        ledger: 0,
      };
    });

  await enrichTimestampsByTx(mine);
  return mine.sort((a, b) => b.timestamp - a.timestamp);
}
