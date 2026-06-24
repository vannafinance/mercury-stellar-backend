import { CONTRACT_ADDRESSES } from "./stellar-utils";
import { fetchContractEvents } from "./mercury-client";

// Earn pool transaction history sourced from Mercury (full history — no ~30-day
// RPC getEvents window). Drop-in for ContractService.getEarnPoolEvents, so
// useEarnTransactions keeps the same shape.
//
// Each lending-pool contract uses the AccountManager-style topic layout — and,
// unlike Soroswap, the event PAYLOAD carries its own timestamp, so this is a
// pure Mercury read with NO Horizon/RPC enrichment:
//   topic1 = Symbol("deposit_event" | "withdraw_event")   → e.eventName
//   topic2 = lender account (G…)                          → server-side scoped
//   data(deposit)  = { amount, asset_symbol, lender, timestamp }
//   data(withdraw) = { asset_symbol, lender, timestamp, vtoken_amount }
// amounts are i128 WAD (÷ 1e18); timestamp is unix seconds. The pool's asset is
// taken from the contract we queried (asset_symbol can't tell USDC / AQUARIUS_USDC
// / SOROSWAP_USDC apart — they all report "USDC").

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
        .filter((e) => e.eventName === "deposit_event" || e.eventName === "withdraw_event")
        .map((e): EarnTxEntry => {
          const d = (e.data ?? {}) as Record<string, unknown>;
          const isSupply = e.eventName === "deposit_event";
          return {
            type: isSupply ? "supply" : "withdraw",
            asset,
            amount: wadToHuman(isSupply ? d.amount : d.vtoken_amount).toFixed(7),
            timestamp: Number(d.timestamp ?? 0) * 1000,
            hash: e.tx ?? "",
            status: "success",
          };
        });
    }),
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<EarnTxEntry[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .sort((a, b) => b.timestamp - a.timestamp);
}
