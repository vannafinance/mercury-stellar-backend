/**
 * Read-only tx lookup for the Assistant diagnosis lane.
 * One RPC call, short timeout — never waits for a ledger to close, never submits.
 */

import { extractTxHash } from "@/lib/assistant/packet";
import { describeFailedTx } from "@/lib/stellar-utils";

export type AssistantHorizonLookup = {
  hash: string;
  status: "SUCCESS" | "FAILED" | "NOT_FOUND" | "ERROR";
  detail: string;
};

export async function lookupAssistantTx(
  message: string,
  events: Array<{ tx_hash?: string | null }>,
): Promise<AssistantHorizonLookup | null> {
  const hash =
    extractTxHash(message) ||
    [...events].reverse().map((e) => e.tx_hash).find((h): h is string => Boolean(h)) ||
    null;
  if (!hash) return null;

  try {
    const [StellarSdk, { SOROBAN_RPC_URL }] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("@/lib/stellar-utils"),
    ]);
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const result = await Promise.race([
      server.getTransaction(hash),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("lookup timeout")), 8_000);
      }),
    ]);
    const status = String(result?.status || "NOT_FOUND").toUpperCase();
    if (status === "SUCCESS") {
      return { hash, status: "SUCCESS", detail: "The transaction is confirmed on testnet." };
    }
    if (status === "FAILED") {
      const decoded = describeFailedTx(result);
      return {
        hash,
        status: "FAILED",
        detail: decoded || "The transaction is on chain and failed.",
      };
    }
    return {
      hash,
      status: "NOT_FOUND",
      detail: "No ledger result yet — it may still be unconfirmed, or the hash is not on this network.",
    };
  } catch (e) {
    return {
      hash,
      status: "ERROR",
      detail: e instanceof Error ? e.message.slice(0, 200) : "lookup failed",
    };
  }
}
