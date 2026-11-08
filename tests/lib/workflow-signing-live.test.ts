import { expect, it } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES, SOROBAN_RPC_URL } from "@/lib/stellar-utils";
import { assertSigningTime, refreshSigningEnvelope } from "@/lib/copilot/workflow/signing-envelope";

/** Opt-in public Registry read with a disposable source. No user data, saved journals, secrets, signing or broadcast. */
it.skipIf(process.env.COPILOT_SIGNING_SYNTHETIC_LIVE_CHECK !== "1")("refreshes a synthetic expired envelope through real RPC preparation", async () => {
  const source = Keypair.random().publicKey();
  const old = new TransactionBuilder(new Account(source, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT_ADDRESSES.REGISTRY, function: "get_protocol_config", args: [] }))
    .setTimebounds(0, 1).build();
  const server = new rpc.Server(SOROBAN_RPC_URL);
  const fresh = assertSigningTime(await refreshSigningEnvelope(old.toXDR(), source, {
    getAccount: async () => new Account(source, "0"),
    prepareTransaction: tx => server.prepareTransaction(tx),
  }));
  expect(fresh.signatures).toHaveLength(0);
  expect(Number(fresh.fee)).toBeGreaterThan(0);
  expect(fresh.operations[0].type).toBe("invokeHostFunction");
}, 45_000);
