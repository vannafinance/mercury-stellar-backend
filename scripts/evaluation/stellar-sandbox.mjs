import { Networks, TransactionBuilder, Keypair } from "@stellar/stellar-sdk";

/** Fail closed before any scenario can approve, build or sign. */
export async function verifyTestnet(rpcUrl, timeoutMs, fetcher = fetch) {
  const response = await fetcher(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  if (!response.ok || body.error || body.result?.passphrase !== Networks.TESTNET) throw new Error("RPC testnet verification failed.");
}

/** The caller must verify testnet first; this function signs but never broadcasts. */
export function makeTestnetSigner(secret, expectedWallet) {
  const pair = Keypair.fromSecret(secret);
  if (pair.publicKey() !== expectedWallet) throw new Error("Signer wallet mismatch.");
  return async (unsignedXdr) => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    if (tx.source !== expectedWallet) throw new Error("Envelope source mismatch.");
    tx.sign(pair);
    return tx.toXDR();
  };
}
