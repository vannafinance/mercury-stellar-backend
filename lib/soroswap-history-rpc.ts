import * as StellarSdk from '@stellar/stellar-sdk';
import { SOROBAN_RPC_URL } from './stellar-utils';
import type { SoroswapLpEvent } from './soroswap-utils';

// Bounded RPC fallback for Soroswap LP history when Mercury is down/erroring
// for this pair — same reasoning as getMarginHistoryFromRpc, but the account
// isn't in a topic here (it's in the event's `to` data field, same limitation
// getSoroswapLpEventsFromMercury already documents), so this queries the pair
// contract UNSCOPED and filters client-side, exactly like the Mercury version.
// RPC's own ledgerClosedAt gives real timestamps directly, no Horizon
// enrichment needed.

const STROOP = 1e7;
const toHuman = (raw: unknown): string => {
  try {
    return (Number(BigInt(String(raw))) / STROOP).toFixed(7);
  } catch {
    return '0';
  }
};

interface SoroswapLiquidityData {
  amount_0?: unknown;
  amount_1?: unknown;
  liquidity?: unknown;
  to?: unknown;
}

export async function getSoroswapLpEventsFromRpc(
  pairAddress: string,
  marginAccountAddress: string,
): Promise<SoroswapLpEvent[]> {
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(1, latest.sequence - 9000);

    const response = await server.getEvents({
      filters: [{ type: 'contract', contractIds: [pairAddress] }],
      startLedger,
      limit: 100,
    });

    const entries: SoroswapLpEvent[] = [];
    for (const e of response.events) {
      const kind = StellarSdk.scValToNative(e.topic[1]) as string; // topic2 = "deposit" | "withdraw" | "sync" | "swap"
      if (kind !== 'deposit' && kind !== 'withdraw') continue;

      const d = (StellarSdk.scValToNative(e.value) ?? {}) as SoroswapLiquidityData;
      if (d.to !== marginAccountAddress) continue;

      entries.push({
        type: kind as 'deposit' | 'withdraw',
        shareAmount: toHuman(d.liquidity),
        amountXLM: toHuman(d.amount_0),
        amountUSDC: toHuman(d.amount_1),
        timestamp: new Date(e.ledgerClosedAt).getTime(),
        txHash: e.txHash,
        ledger: e.ledger,
      });
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}
