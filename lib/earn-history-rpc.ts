import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES, SOROBAN_RPC_URL } from './stellar-utils';
import type { EarnTxEntry } from './mercury-earn';

// Bounded RPC fallback for Earn history when Mercury is down/erroring for this
// wallet (confirmed live: Mercury returning a genuine 502 for every lending-pool
// contract query on a real account, not a "no data" response) — same pattern as
// getMarginHistoryFromRpc for margin history. RPC's retention window is short
// (recent ledgers only, not "full history" the way Mercury is meant to give),
// so this only ever fills in a RECENT gap; it reverts to Mercury alone once
// Mercury's own read succeeds again.
//
// Same event shape as getEarnTransactionsFromMercury: one query per lending
// pool contract, decoding deposit_event/withdraw_event, so callers can merge
// the two result sets directly (dedupe by hash+type+asset — a single supply
// tx only ever emits one deposit_event, but keep the same composite-key
// discipline the margin history merge already established).

const WAD = BigInt('1000000000000000000');
const wadToHuman = (raw: unknown): number => {
  try {
    const bi = BigInt(String(raw));
    return Number(bi / WAD) + Number(bi % WAD) / 1e18;
  } catch {
    return 0;
  }
};

const accountTopicXdr = (address: string): string => {
  const scVal = StellarSdk.xdr.ScVal.scvAddress(new StellarSdk.Address(address).toScAddress());
  return scVal.toXDR('base64');
};

const POOLS: { contract: string; asset: string }[] = [
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM, asset: 'XLM' },
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC, asset: 'USDC' },
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC, asset: 'AQUARIUS_USDC' },
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC, asset: 'SOROSWAP_USDC' },
];

async function readPoolEventsFromRpc(
  server: StellarSdk.rpc.Server,
  startLedger: number,
  contract: string,
  asset: string,
  walletAddress: string,
): Promise<EarnTxEntry[]> {
  const topicFilter = ['*', accountTopicXdr(walletAddress)];
  const response = await server.getEvents({
    filters: [{ type: 'contract', contractIds: [contract], topics: [topicFilter] }],
    startLedger,
    limit: 100,
  });

  const entries: EarnTxEntry[] = [];
  for (const e of response.events) {
    const eventName = StellarSdk.scValToNative(e.topic[0]) as string;
    if (eventName !== 'deposit_event' && eventName !== 'withdraw_event') continue;

    const d = (StellarSdk.scValToNative(e.value) ?? {}) as Record<string, unknown>;
    const isSupply = eventName === 'deposit_event';
    entries.push({
      type: isSupply ? 'supply' : 'withdraw',
      asset,
      amount: wadToHuman(isSupply ? d.amount : d.asset_amount).toFixed(7),
      timestamp: new Date(e.ledgerClosedAt).getTime(),
      hash: e.txHash,
      status: 'success',
    });
  }
  return entries;
}

export async function getEarnHistoryFromRpc(walletAddress: string): Promise<EarnTxEntry[]> {
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const latest = await server.getLatestLedger();
    // Same bounded window as margin history's RPC fallback — this node's
    // observed retention is roughly the last several hours of ledgers.
    const startLedger = Math.max(1, latest.sequence - 9000);

    const settled = await Promise.allSettled(
      POOLS.map(({ contract, asset }) =>
        readPoolEventsFromRpc(server, startLedger, contract, asset, walletAddress),
      ),
    );

    return settled
      .filter((r): r is PromiseFulfilledResult<EarnTxEntry[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    // RPC range/format errors, network hiccups, etc. — best-effort fallback;
    // failing silently just means we fall back to Mercury alone.
    return [];
  }
}
