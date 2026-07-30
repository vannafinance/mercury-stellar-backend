import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES } from './stellar-utils';
import type { BlendEvent } from './blend-utils';
import { SOROBAN_RPC_URL } from './stellar-utils';

// Bounded RPC fallback for Blend farm history when Mercury is down/erroring
// for this account — same pattern as getMarginHistoryFromRpc. The Blend pool
// uses the margin/earn-style topic layout (documented in mercury-blend.ts):
//   topic0 = Symbol(action)        ("supply" | "withdraw" | …)
//   topic1 = reserve token address
//   topic2 = the account
// so this is a direct, server-side-filterable topic query on topic2 (RPC
// requires an exact positional filter, unlike Mercury's "match any topic"
// behavior — hence the two leading wildcards).

const assetMap: Record<string, string> = {
  [CONTRACT_ADDRESSES.BLEND_XLM]: 'XLM',
  [CONTRACT_ADDRESSES.BLEND_USDC]: 'USDC',
};

const accountTopicXdr = (address: string): string => {
  const scVal = StellarSdk.xdr.ScVal.scvAddress(new StellarSdk.Address(address).toScAddress());
  return scVal.toXDR('base64');
};

export async function getBlendEventsFromRpc(
  marginAccountAddress: string,
  blendPoolAddress?: string,
): Promise<BlendEvent[]> {
  try {
    const pool = blendPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(1, latest.sequence - 9000);

    const topicFilter = ['*', '*', accountTopicXdr(marginAccountAddress)];
    const response = await server.getEvents({
      filters: [{ type: 'contract', contractIds: [pool], topics: [topicFilter] }],
      startLedger,
      limit: 100,
    });

    const entries: BlendEvent[] = [];
    for (const e of response.events) {
      const eventName = StellarSdk.scValToNative(e.topic[0]) as string;
      if (eventName !== 'supply' && eventName !== 'withdraw') continue;

      const tokenAddress = StellarSdk.scValToNative(e.topic[1]) as string;
      const body = StellarSdk.scValToNative(e.value);
      const [underlying, bToken] = Array.isArray(body) ? body : [0, 0];

      entries.push({
        type: eventName as 'supply' | 'withdraw',
        tokenAddress,
        tokenSymbol: assetMap[tokenAddress] ?? tokenAddress.slice(0, 8) ?? '?',
        underlyingAmount: (Number(underlying ?? 0) / 1e7).toFixed(7),
        bTokenAmount: (Number(bToken ?? 0) / 1e7).toFixed(7),
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
