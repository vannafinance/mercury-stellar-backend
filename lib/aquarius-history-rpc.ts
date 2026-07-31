import * as StellarSdk from '@stellar/stellar-sdk';
import { SOROBAN_RPC_URL } from './stellar-utils';
import type { AquariusLpEvent } from './aquarius-utils';

// Bounded RPC fallback for Aquarius LP history when Mercury is down/erroring
// for this pool. Originally read the AccountManager's Trader_AquariusDeposit/
// Trader_AquariusWithdraw events (server-side account-filterable, like margin),
// but the 2026-07-19 Controller-Facade refactor removed all event publishing
// from the exec path — that event hasn't fired since, so it can no longer be
// trusted as a data source (confirmed: no `events().publish` call for it
// anywhere in account_manager.rs or AquariusControllerContract).
//
// Falls back instead to the pool's OWN deposit_liquidity/withdraw_liquidity
// events (Aquarius's external contract, untouched by our refactor) — same
// source AquariusService.getAquariusEvents already reads elsewhere, but the
// account isn't reliably in a topic here (unlike margin), so this can only
// filter best-effort: keep an event if none of its topics decode to an
// address at all, or if one of them matches this account.

const SHARE_SCALE = 1e7;

export async function getAquariusLpEventsFromRpc(
  poolAddress: string,
  marginAccountAddress: string,
): Promise<AquariusLpEvent[]> {
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(1, latest.sequence - 9000);

    const depositTopic = StellarSdk.xdr.ScVal.scvSymbol('deposit_liquidity').toXDR('base64');
    const withdrawTopic = StellarSdk.xdr.ScVal.scvSymbol('withdraw_liquidity').toXDR('base64');

    const fetchByTopic = async (topic: string) => {
      const response = await server.getEvents({
        filters: [{ type: 'contract', contractIds: [poolAddress], topics: [[topic]] }],
        startLedger,
        limit: 100,
      });
      return response.events;
    };

    const [depositEvs, withdrawEvs] = await Promise.all([
      fetchByTopic(depositTopic),
      fetchByTopic(withdrawTopic),
    ]);

    const toHuman = (v: unknown) => (Number(v ?? 0) / SHARE_SCALE).toFixed(7);

    const parse = (e: (typeof depositEvs)[number], type: 'deposit' | 'withdraw'): AquariusLpEvent | null => {
      const topicAddresses = e.topic
        .slice(1)
        .map((t) => {
          try {
            return StellarSdk.scValToNative(t) as unknown;
          } catch {
            return null;
          }
        })
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (topicAddresses.length > 0 && !topicAddresses.includes(marginAccountAddress)) return null;

      const body = StellarSdk.scValToNative(e.value);
      if (!Array.isArray(body) || body.length < 3) return null;

      return {
        type,
        shareAmount: toHuman(body[0]),
        amountA: toHuman(body[1]),
        amountB: toHuman(body[2]),
        timestamp: new Date(e.ledgerClosedAt).getTime(),
        txHash: e.txHash,
        ledger: e.ledger,
      };
    };

    const entries = [
      ...depositEvs.map((e) => parse(e, 'deposit')),
      ...withdrawEvs.map((e) => parse(e, 'withdraw')),
    ].filter((e): e is AquariusLpEvent => e !== null);

    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}
