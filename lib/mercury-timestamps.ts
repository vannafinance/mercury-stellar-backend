import { HORIZON_URL } from "./stellar-utils";

// Mercury REST event rows carry no ledger close-time, and Mercury's GraphQL
// (which could join tx→ledger→closeTime) is dead on the testnet instance. For
// events whose payload doesn't already carry a timestamp (Soroswap pair, Blend
// pool — both third-party contracts), recover it per-tx from HORIZON. Horizon —
// not Soroban RPC getTransaction — because RPC retains only ~days of history,
// which would drop the historical events Mercury exists to provide. Deduped by
// tx hash (multiple events share one tx); misses leave timestamp at 0.

interface HorizonTx {
  created_at?: string;
  ledger?: number;
}

export async function enrichTimestampsByTx(
  events: { txHash: string; timestamp: number; ledger: number }[],
): Promise<void> {
  const hashes = Array.from(new Set(events.map((e) => e.txHash).filter(Boolean)));

  const byHash = new Map<string, { ts: number; ledger: number }>();
  await Promise.allSettled(
    hashes.map(async (hash) => {
      const res = await fetch(`${HORIZON_URL}/transactions/${hash}`);
      if (!res.ok) return;
      const tx = (await res.json()) as HorizonTx;
      if (tx.created_at) {
        byHash.set(hash, { ts: new Date(tx.created_at).getTime(), ledger: tx.ledger ?? 0 });
      }
    }),
  );

  for (const e of events) {
    const hit = byHash.get(e.txHash);
    if (hit) {
      e.timestamp = hit.ts;
      e.ledger = hit.ledger;
    }
  }
}
