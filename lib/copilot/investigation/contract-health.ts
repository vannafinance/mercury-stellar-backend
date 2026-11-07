/**
 * The trusted simulator `validateHealthPath` requires.
 *
 * `health-path.ts` validates `ContractHealthState`s and explicitly refuses to accept them
 * from model JSON - but nothing produced them, so the floor check had no source. This is
 * that source: it reads the account's contract-side collateral and debt from the CreditLayer
 * (`margin_value`, Liquidation prices) and asks the contract itself for the verdict
 * (`is_healthy`, healthy iff collateral / debt > 1.2). The RiskEngine and its registry are
 * gone (credit-layer redeploy 2026-11-06).
 *
 * Why the contract and not the app's own figure: four collateral numbers are in
 * circulation (UI store, MCP `account_health`, MCP `account_collateral`, and the contract)
 * and they disagree materially - measured 2026-09-08, the app reported gross collateral
 * 2858.90 while the contract reported 3201.70 for the same account. Only the contract's
 * number decides liquidation, so a health floor sized against any other one is sized
 * against a number that cannot liquidate anybody.
 *
 * Read-only by construction: every call is `simulateTransaction` from a throwaway source
 * account. Nothing here signs, submits, or mutates state.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES, NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from "@/lib/stellar-utils";
import type { ContractHealthState } from "./health-path";

/** Simulation needs a syntactically valid source; this one holds nothing and signs nothing. */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class ContractHealthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface ContractHealthReading extends ContractHealthState {
  /** Always false now: the CreditLayer address is compiled in and there is no registry to diverge from. Kept for callers. */
  registryDiverged: boolean;
}

/** Only the two read methods this module uses, so a test can supply a stub. */
type ReadOnlyRpc = Pick<StellarSdk.rpc.Server, "simulateTransaction" | "getContractData">;

function server(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

async function simulate(
  rpc: ReadOnlyRpc,
  contract: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  signal?: AbortSignal,
): Promise<{ value: unknown; ledger: number }> {
  signal?.throwIfAborted();
  const source = new StellarSdk.Account(SIMULATION_SOURCE, "0");
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new StellarSdk.Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const result = await rpc.simulateTransaction(tx);
  signal?.throwIfAborted();
  if (!StellarSdk.rpc.Api.isSimulationSuccess(result) || !result.result?.retval) {
    const detail = StellarSdk.rpc.Api.isSimulationError(result) ? result.error : "no result";
    throw new ContractHealthError("simulation_failed", `${method} could not be simulated: ${detail}`);
  }
  return { value: StellarSdk.scValToNative(result.result.retval), ledger: Number(result.latestLedger) };
}

/** u256 arrives as bigint or string depending on the value; both must round-trip exactly. */
function u256(value: unknown, method: string): string {
  const text = typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.trim() : "";
  if (!/^(0|[1-9]\d{0,77})$/.test(text)) {
    throw new ContractHealthError("invalid_contract_amount", `${method} did not return a u256`);
  }
  return text;
}

/** The CreditLayer's code hash, so a validated state names the exact code that produced it. */
async function creditLayerCodeHash(rpc: ReadOnlyRpc, contract: string): Promise<string> {
  const instance = await rpc.getContractData(contract, StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance());
  const hash = instance.val.contractData().val().instance().executable().wasmHash().toString("hex");
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new ContractHealthError("wasm_hash_unavailable", "The CreditLayer's code hash could not be read.");
  }
  return hash;
}

/** Decodes the `margin_value` (collateral, debt) tuple. */
function marginValueTuple(value: unknown): { collateralWad: string; debtWad: string } {
  if (!Array.isArray(value) || value.length < 2) {
    throw new ContractHealthError("invalid_margin_value", "margin_value did not return a (collateral, debt) pair.");
  }
  return { collateralWad: u256(value[0], "margin_value"), debtWad: u256(value[1], "margin_value") };
}

/**
 * Read one account's contract-side health state.
 *
 * `leg` names the step this state belongs to, so a caller projecting a sequence can label
 * which leg breached. `margin_value` returns collateral and debt from ONE call (so they
 * always share a ledger); the `is_healthy` verdict is a second call and must land on the
 * same ledger - `validateHealthPath` rejects mixed ledgers. One retry covers a ledger
 * closing between the two reads.
 */
export async function readContractHealthState(
  smartAccount: string,
  options: {
    leg?: string;
    signal?: AbortSignal;
    now?: () => number;
    /** Injected only by tests; production always builds its own read-only client. */
    rpc?: ReadOnlyRpc;
  } = {},
): Promise<ContractHealthReading> {
  if (!StellarSdk.StrKey.isValidContract(smartAccount)) {
    throw new ContractHealthError("invalid_smart_account", "Expected a margin-account contract address.");
  }
  signalCheck(options.signal);
  const now = options.now ?? Date.now;
  const rpc = options.rpc ?? server();
  const contract = CONTRACT_ADDRESSES.CREDIT_LAYER;

  const wasmTask = creditLayerCodeHash(rpc, contract);
  wasmTask.catch(() => { /* awaited below */ });

  const account = StellarSdk.nativeToScVal(smartAccount, { type: "address" });
  const reads = async () => {
    const [value, verdict] = await Promise.all([
      simulate(rpc, contract, "margin_value", [account], options.signal),
      simulate(rpc, contract, "is_healthy", [account], options.signal),
    ]);
    return { value, verdict };
  };
  let r = await reads();
  if (r.value.ledger !== r.verdict.ledger) r = await reads();
  const wasmHash = await wasmTask;
  if (r.value.ledger !== r.verdict.ledger) {
    throw new ContractHealthError(
      "inconsistent_ledger",
      "Collateral/debt and the health verdict could not be read from one ledger; they are not comparable.",
    );
  }

  const { collateralWad, debtWad } = marginValueTuple(r.value.value);
  // Ask the contract for the verdict rather than re-deriving it: the boundary is exclusive
  // (shared math::is_healthy is collateral/debt > 1.2), so a locally recomputed comparison
  // could disagree with the chain at the boundary.
  if (typeof r.verdict.value !== "boolean") {
    throw new ContractHealthError("invalid_health_verdict", "is_healthy did not return a boolean.");
  }

  return {
    leg: options.leg ?? "current",
    balanceWad: collateralWad,
    debtWad,
    contractHealthy: r.verdict.value,
    ledger: r.value.ledger,
    observedAt: now(),
    contract,
    wasmHash,
    registryDiverged: false,
  };
}

function signalCheck(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function wadUsd(wad: string, method: string): number {
  const usd = Number(BigInt(wad)) / 1e18;
  if (!Number.isFinite(usd) || usd < 0) {
    throw new ContractHealthError("invalid_contract_amount", `${method} did not convert to a USD amount`);
  }
  return usd;
}

/**
 * CreditLayer.margin_value - the (collateral USD, debt USD) pair that decides liquidation
 * (Liquidation prices; liquidatable when collateral / debt <= 1.2).
 *
 * Used as a sizing fallback when the live MCP dispatcher does not yet expose
 * the audited read. Same simulate path as `readContractHealthState`; never a write.
 * `unpriceablePlain` is always false: the credit layer's oracle prices every allowed asset
 * (an unpriceable asset makes margin_value fail instead).
 */
export async function readLiquidationSnapshot(
  smartAccount: string,
  options: {
    signal?: AbortSignal;
    rpc?: ReadOnlyRpc;
  } = {},
): Promise<{ collateralUsd: number; debtUsd: number; unpriceablePlain: boolean; ledger: number }> {
  if (!StellarSdk.StrKey.isValidContract(smartAccount)) {
    throw new ContractHealthError("invalid_smart_account", "Expected a margin-account contract address.");
  }
  const rpc = options.rpc ?? server();
  const account = StellarSdk.nativeToScVal(smartAccount, { type: "address" });
  const snap = await simulate(rpc, CONTRACT_ADDRESSES.CREDIT_LAYER, "margin_value", [account], options.signal);
  const { collateralWad, debtWad } = marginValueTuple(snap.value);
  return {
    collateralUsd: wadUsd(collateralWad, "margin_value"),
    debtUsd: wadUsd(debtWad, "margin_value"),
    unpriceablePlain: false,
    ledger: snap.ledger,
  };
}
