import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES } from './stellar-utils';
import { addressTopic, eventName, getEventsWindowed } from './credit-events-rpc';
import { marginEventToEntry, type MarginTxEntry } from './mercury-margin';

// Bounded fallback for margin history when Mercury has an indexing gap for the
// CreditLayer contract (Mercury has stalled on a contract before — see project
// memory 2026-07-21). RPC's own event retention is short (~7 days on testnet),
// so this fills in ONLY the recent window; Mercury stays the primary source.
//
// Same four credit-layer event names / same decoding as
// getMarginHistoryFromMercury (shared `marginEventToEntry`), so callers can
// merge the two result sets directly by tx hash.

// Roughly three days of ledgers. Read as 5k-ledger windows (credit-events-rpc.ts):
// one large request only returns its oldest ~10k ledgers on the public RPC.
const RPC_LOOKBACK_LEDGERS = 50_000;

export async function getMarginHistoryFromRpc(
  marginAccountAddress: string,
): Promise<MarginTxEntry[]> {
  try {
    const events = await getEventsWindowed(
      [
        {
          type: 'contract',
          contractIds: [CONTRACT_ADDRESSES.CREDIT_LAYER],
          topics: [['*', addressTopic(marginAccountAddress)]],
        },
      ],
      RPC_LOOKBACK_LEDGERS,
    );

    const entries: MarginTxEntry[] = [];
    for (const e of events) {
      const name = eventName(e);
      if (!name) continue;
      const raw = StellarSdk.scValToNative(e.value);
      const row = marginEventToEntry(name, raw, e.txHash, new Date(e.ledgerClosedAt).getTime(), marginAccountAddress);
      if (row) entries.push(row);
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    // RPC range/format errors, network hiccups, etc. — this is a best-effort
    // fallback; failing silently just means we fall back to Mercury alone.
    return [];
  }
}
