import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { fetchContractEvents } from "./mercury-client";
import { fetchTxTimestamps } from "./mercury-timestamps";

// Earn pool transaction history sourced from Mercury (full history — no ~7-day
// RPC getEvents window). Drop-in for ContractService.getEarnPoolEvents, so
// useEarnTransactions keeps the same shape.
//
// Each credit-layer Reserve (one per asset; it is also the share token)
// emits, for lenders:
//   topic1 = Symbol("supplied" | "redeemed")              → e.eventName
//   topic2 = lender account (G…)                          → server-side scoped
//   data   = LenderEvent { lender, assets, shares }
// `assets` / `shares` are U256 WAD (÷ 1e18). `assets` is the real underlying
// moved (for `redeemed`, the payout actually transferred, which the reserve
// caps at available cash), so it — not `shares` — is the amount recorded;
// the two only match 1:1 at a 1.0 exchange rate, and using shares would
// misstate net-deposited once interest has accrued. The reserve's asset is
// taken from the contract we queried. The reserve's own token events
// (mint / burn / transfer) are ignored.
//
// Unlike the retired lending pools, these events carry NO timestamp, so the
// ledger close time is recovered per tx hash from Horizon
// (lib/mercury-timestamps.ts); a miss leaves timestamp 0 and the caller
// prefers the RPC fallback's ledgerClosedAt for the same tx.

export interface EarnTxEntry {
  type: "supply" | "withdraw";
  asset: string;
  amount: string;
  timestamp: number;
  hash: string;
  status: "success";
}

const POOLS: { contract: string; asset: string }[] = [
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM, asset: "XLM" },
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC, asset: "USDC" },
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC, asset: "AQUARIUS_USDC" },
  { contract: CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC, asset: "SOROSWAP_USDC" },
];

const WAD = BigInt("1000000000000000000");
const wadToHuman = (raw: unknown): number => {
  try {
    const bi = BigInt(String(raw));
    return Number(bi / WAD) + Number(bi % WAD) / 1e18;
  } catch {
    return 0;
  }
};

export async function getEarnTransactionsFromMercury(
  walletAddress: string,
): Promise<EarnTxEntry[]> {
  // One server-side-scoped Mercury call per pool (account filtered via topics),
  // tolerant of a single pool's transient failure.
  const settled = await Promise.allSettled(
    POOLS.map(async ({ contract, asset }) => {
      const events = await fetchContractEvents({ contract, account: walletAddress });
      return events
        .filter((e) => e.eventName === "supplied" || e.eventName === "redeemed")
        .map((e): EarnTxEntry => {
          const d = (e.data ?? {}) as Record<string, unknown>;
          return {
            type: e.eventName === "supplied" ? "supply" : "withdraw",
            asset,
            amount: wadToHuman(d.assets).toFixed(7),
            timestamp: 0,
            hash: e.tx ?? "",
            status: "success",
          };
        });
    }),
  );

  const entries = settled
    .filter((r): r is PromiseFulfilledResult<EarnTxEntry[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);

  const times = await fetchTxTimestamps(entries.map((e) => e.hash));
  for (const e of entries) {
    const hit = times.get(e.hash);
    if (hit) e.timestamp = hit.ts;
  }

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}
