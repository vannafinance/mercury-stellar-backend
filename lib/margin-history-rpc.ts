import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES, SOROBAN_RPC_URL } from './stellar-utils';
import type { MarginTxEntry } from './mercury-margin';

// Bounded fallback for margin history when Mercury has a real indexing gap for
// this account's AccountManager contract (confirmed 2026-07-21: Mercury's index
// for the CURRENT AccountManager address stalled at 2026-07-19 despite continuous
// on-chain activity since — see project memory). RPC's own event retention is
// short (a bounded ledger window, not "full history" the way Mercury is meant to
// give), so this fills in ONLY the recent gap Mercury is currently missing —
// it does not replace Mercury as the primary source once Mercury's index catches
// back up.
//
// Same three event names / same decoding shape as getMarginHistoryFromMercury,
// so callers can merge the two result sets directly.

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

export async function getMarginHistoryFromRpc(
  marginAccountAddress: string,
): Promise<MarginTxEntry[]> {
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const latest = await server.getLatestLedger();
    // RPC's retention window on this node has been observed to cover roughly
    // the last several hours (~9,000 ledgers at ~2s/ledger) — well short of
    // Mercury's intended "full history", but enough to cover activity from
    // the last few hours, which is exactly the kind of gap this fills.
    const startLedger = Math.max(1, latest.sequence - 9000);

    const topicFilter = ['*', accountTopicXdr(marginAccountAddress)];
    const response = await server.getEvents({
      filters: [
        {
          type: 'contract',
          contractIds: [CONTRACT_ADDRESSES.ACCOUNT_MANAGER],
          topics: [topicFilter],
        },
      ],
      startLedger,
      limit: 100,
    });

    const entries: MarginTxEntry[] = [];
    for (const e of response.events) {
      const eventName = StellarSdk.scValToNative(e.topic[0]) as string;
      if (
        eventName !== 'Trader_Borrow' &&
        eventName !== 'Trader_Deposit' &&
        eventName !== 'Trader_Withdraw' &&
        eventName !== 'Trader_Repay_Event'
      ) {
        continue;
      }

      const raw = StellarSdk.scValToNative(e.value);
      const timestamp = new Date(e.ledgerClosedAt).getTime();

      if (eventName === 'Trader_Repay_Event') {
        const d = (raw ?? {}) as Record<string, unknown>;
        entries.push({
          type: 'repay',
          asset: String(d.token_symbol ?? ''),
          amount: wadToHuman(d.token_amount).toFixed(7),
          timestamp,
          hash: e.txHash,
        });
      } else if (eventName === 'Trader_Deposit') {
        const d = (raw ?? {}) as Record<string, unknown>;
        entries.push({
          type: 'deposit',
          asset: String(d.token_symbol ?? ''),
          amount: wadToHuman(d.amount).toFixed(7),
          timestamp,
          hash: e.txHash,
        });
      } else if (eventName === 'Trader_Withdraw') {
        const d = (raw ?? {}) as Record<string, unknown>;
        entries.push({
          type: 'withdraw',
          asset: String(d.token_symbol ?? ''),
          amount: wadToHuman(d.amount).toFixed(7),
          timestamp,
          hash: e.txHash,
        });
      } else {
        // Trader_Borrow — forward-compatible with the older bare-symbol build,
        // same as getMarginHistoryFromMercury.
        if (raw && typeof raw === 'object') {
          const d = raw as Record<string, unknown>;
          entries.push({
            type: 'borrow',
            asset: String(d.token_symbol ?? ''),
            amount: wadToHuman(d.token_amount).toFixed(7),
            timestamp,
            hash: e.txHash,
          });
        } else {
          entries.push({
            type: 'borrow',
            asset: typeof raw === 'string' ? raw : '',
            amount: '—',
            timestamp,
            hash: e.txHash,
          });
        }
      }
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    // RPC range/format errors, network hiccups, etc. — this is a best-effort
    // fallback; failing silently just means we fall back to Mercury alone.
    return [];
  }
}
