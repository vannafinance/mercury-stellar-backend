/**
 * Windowed Soroban RPC `getEvents` reader for credit-layer events.
 *
 * The public testnet RPC scans at most ~10k ledgers per call (a single larger
 * request returns only its OLDEST slice plus a cursor) and busy stretches trip
 * "-32001 request exceeded processing limit" even on 10k windows, so reads go
 * out as 5k-ledger windows with an explicit endLedger, newest first, a few at a
 * time; a failing window is halved once (same approach as lib/spot-history.ts,
 * verified 2026-10-14). Retention is ~7 days on testnet.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { SOROBAN_RPC_URL } from './stellar-utils';

const RPC_WINDOW_LEDGERS = 5_000;
const RPC_WINDOW_CONCURRENCY = 4;

export type RpcEvent = StellarSdk.rpc.Api.EventResponse;

/** base64 XDR of a Symbol topic. */
export const symbolTopic = (name: string): string => StellarSdk.xdr.ScVal.scvSymbol(name).toXDR('base64');

/** base64 XDR of an Address topic. */
export const addressTopic = (address: string): string =>
  StellarSdk.xdr.ScVal.scvAddress(new StellarSdk.Address(address).toScAddress()).toXDR('base64');

/**
 * Reads events matching `filters` over the last `lookbackLedgers` ledgers (or
 * the node's full retention when omitted). Failed windows are skipped, so the
 * result is best-effort; never throws for a window error.
 */
export async function getEventsWindowed(
  filters: StellarSdk.rpc.Api.EventFilter[],
  lookbackLedgers?: number,
): Promise<RpcEvent[]> {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const health = await server.getHealth();
  const oldest = lookbackLedgers
    ? Math.max(health.oldestLedger, health.latestLedger - lookbackLedgers)
    : health.oldestLedger;

  const readWindow = async (start: number, end: number, canSplit = true): Promise<RpcEvent[]> => {
    try {
      const response = await server.getEvents({ filters, startLedger: start, endLedger: end, limit: 1000 });
      return response.events;
    } catch (error) {
      if (!canSplit || end - start < 2) throw error;
      const mid = Math.floor((start + end) / 2);
      const halves = await Promise.allSettled([readWindow(start, mid, false), readWindow(mid, end, false)]);
      return halves.flatMap((half) => (half.status === 'fulfilled' ? half.value : []));
    }
  };

  const windows: [number, number][] = [];
  for (let end = health.latestLedger + 1; end > oldest; end -= RPC_WINDOW_LEDGERS) {
    windows.push([Math.max(oldest, end - RPC_WINDOW_LEDGERS), end]);
  }
  const events: RpcEvent[] = [];
  for (let i = 0; i < windows.length; i += RPC_WINDOW_CONCURRENCY) {
    const batch = await Promise.allSettled(
      windows.slice(i, i + RPC_WINDOW_CONCURRENCY).map(([start, end]) => readWindow(start, end)),
    );
    batch.forEach((result) => {
      if (result.status === 'fulfilled') events.push(...result.value);
    });
  }
  return events;
}

/** topic[0] of an event as a string, or null. */
export function eventName(e: RpcEvent): string | null {
  try {
    const v = StellarSdk.scValToNative(e.topic[0]);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
