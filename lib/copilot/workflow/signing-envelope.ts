import { BASE_FEE, Networks, Operation, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { SOROBAN_RPC_URL } from "@/lib/stellar-utils";
import { ResearchError } from "../investigation/scope";

/** A short-lived envelope is renewed on an explicit sign action, independently of plan retention. */
const configuredWindow = Number(process.env.COPILOT_SIGNING_WINDOW_SECONDS);
export const SIGNING_WINDOW_SECONDS = Number.isSafeInteger(configuredWindow) && configuredWindow > 0
  ? configuredWindow : 300;

export function assertSigningTime(xdr: string, now = Date.now()) {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  if (!(tx instanceof Transaction)) throw new ResearchError("transaction_mismatch", "This transaction requires a fresh plan.", 409);
  const time = Math.floor(now / 1000);
  if (tx.timeBounds && (Number(tx.timeBounds.minTime) > time ||
      Number(tx.timeBounds.maxTime) !== 0 && Number(tx.timeBounds.maxTime) <= time)) {
    throw new ResearchError("transaction_expired", "The wallet transaction expired before submission. Click Sign in wallet again to prepare a fresh transaction.", 409);
  }
  return tx;
}

/** Check mutable chain preconditions after a potentially long wallet popup, before recording a submission. */
export async function checkSigningPreconditions(xdr: string,
  server: Pick<rpc.Server, "getAccount" | "getLatestLedger"> = new rpc.Server(SOROBAN_RPC_URL)) {
  const tx = assertSigningTime(xdr);
  const [account, ledger] = await Promise.all([server.getAccount(tx.source), server.getLatestLedger()]);
  const sequence = BigInt(account.sequenceNumber());
  const inclusionLedger = ledger.sequence + 1;
  const validSequence = tx.minAccountSequence === undefined
    ? BigInt(tx.sequence) === sequence + BigInt(1)
    : BigInt(tx.minAccountSequence) <= sequence && sequence < BigInt(tx.sequence);
  if (!validSequence || tx.ledgerBounds && (inclusionLedger < tx.ledgerBounds.minLedger ||
      tx.ledgerBounds.maxLedger !== 0 && inclusionLedger >= tx.ledgerBounds.maxLedger)) {
    throw new ResearchError("transaction_expired", "The account or ledger changed while signing. Click Sign in wallet again to refresh the transaction.", 409);
  }
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction") continue;
    for (const auth of op.auth ?? []) {
      if (auth.credentials().switch().name !== "sorobanCredentialsAddress") continue;
      const credentials = auth.credentials().address();
      if (credentials.signatureExpirationLedger() !== 0 && credentials.signatureExpirationLedger() < inclusionLedger)
        throw new ResearchError("transaction_expired", "The transaction authorization expired while signing. Click Sign in wallet again to refresh it.", 409);
    }
  }
  assertSigningTime(xdr);
}

/** RPC preparation only: this function has no signing, MCP write, or broadcast capability. */
export async function refreshSigningEnvelope(unsignedXdr: string, wallet: string,
  server: Pick<rpc.Server, "getAccount" | "prepareTransaction"> = new rpc.Server(SOROBAN_RPC_URL)) {
  const old = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
  if (!(old instanceof Transaction) || old.source !== wallet || old.signatures.length ||
      old.operations.length !== 1 || old.operations[0].type !== "invokeHostFunction") {
    throw new ResearchError("transaction_mismatch", "This transaction cannot be refreshed safely. Prepare a fresh plan.", 409);
  }
  const account = await server.getAccount(wallet);
  const operation = old.operations[0];
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE, networkPassphrase: Networks.TESTNET, memo: old.memo,
    ledgerbounds: old.ledgerBounds,
    minAccountSequence: old.minAccountSequence,
    minAccountSequenceAge: old.minAccountSequenceAge,
    minAccountSequenceLedgerGap: old.minAccountSequenceLedgerGap,
    extraSigners: old.extraSigners,
  });
  // Re-simulation must generate current auth, resource data and fees. Contract arguments
  // (including any explicit protocol deadline or slippage floor) remain byte-for-byte identical.
  builder.addOperation(Operation.invokeHostFunction({ source: operation.source, func: operation.func, auth: [] }));
  const prepared = await server.prepareTransaction(builder.setTimeout(SIGNING_WINDOW_SECONDS).build());
  const fresh = prepared.operations[0];
  if (prepared.source !== old.source || prepared.signatures.length || prepared.operations.length !== 1 ||
      fresh.type !== "invokeHostFunction" || fresh.func.toXDR("base64") !== operation.func.toXDR("base64") ||
      fresh.source !== operation.source || prepared.memo.toXDRObject().toXDR("base64") !== old.memo.toXDRObject().toXDR("base64")) {
    throw new ResearchError("transaction_mismatch", "Transaction preparation changed the approved operation. Nothing was submitted.", 409);
  }
  assertSigningTime(prepared.toXDR());
  return prepared.toXDR();
}
