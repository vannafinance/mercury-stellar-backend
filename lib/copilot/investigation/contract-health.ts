/**
 * The trusted simulator `validateHealthPath` requires.
 *
 * `health-path.ts` validates `ContractHealthState`s and explicitly refuses to accept them
 * from model JSON — but nothing produced them, so the floor check had no source. This is
 * that source: it resolves the RiskEngine from the on-chain registry, reads the account's
 * contract-side balance and debt, and asks the contract itself for the verdict.
 *
 * Why the contract and not the app's own figure: four collateral numbers are in
 * circulation (UI store, MCP `account_health`, MCP `account_collateral`, and the contract)
 * and they disagree materially — measured 2026-09-08, the app reported gross collateral
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
  /** True when the registry no longer resolves to the address compiled into the app. */
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

/**
 * Read one account's contract-side health state.
 *
 * `leg` names the step this state belongs to, so a caller projecting a sequence can label
 * which leg breached. `get_current_total_balance` and `get_current_total_borrows` must land
 * on the SAME ledger — `validateHealthPath` rejects mixed ledgers because a numerator and
 * denominator from different ledgers are not a health factor. One retry covers a ledger
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
    throw new ContractHealthError("invalid_smart_account", "Expected a smart-account contract address.");
  }
  const now = options.now ?? Date.now;
  const rpc = options.rpc ?? server();

  // The registry is the authority. The compiled-in address is only a divergence check:
  // an upgraded deployment must not be read through a stale constant.
  const resolved = await simulate(rpc, CONTRACT_ADDRESSES.REGISTRY, "get_risk_engine_address", [], options.signal);
  const engine = typeof resolved.value === "string" ? resolved.value : "";
  if (!StellarSdk.StrKey.isValidContract(engine)) {
    throw new ContractHealthError("risk_engine_unresolved", "The registry did not return a RiskEngine address.");
  }

  const instance = await rpc.getContractData(engine, StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance());
  const wasmHash = instance.val.contractData().val().instance().executable().wasmHash().toString("hex");
  if (!/^[a-f0-9]{64}$/.test(wasmHash)) {
    throw new ContractHealthError("wasm_hash_unavailable", "The RiskEngine's code hash could not be read.");
  }

  const account = StellarSdk.nativeToScVal(smartAccount, { type: "address" });
  const totals = async () => {
    const [balance, borrows] = await Promise.all([
      simulate(rpc, engine, "get_current_total_balance", [account], options.signal),
      simulate(rpc, engine, "get_current_total_borrows", [account], options.signal),
    ]);
    return { balance, borrows };
  };
  let reads = await totals();
  if (reads.balance.ledger !== reads.borrows.ledger) reads = await totals();
  if (reads.balance.ledger !== reads.borrows.ledger) {
    throw new ContractHealthError(
      "inconsistent_ledger",
      "Balance and debt could not be read from one ledger; a health factor across two ledgers is not comparable.",
    );
  }

  const balanceWad = u256(reads.balance.value, "get_current_total_balance");
  const debtWad = u256(reads.borrows.value, "get_current_total_borrows");
  const observedAt = now();

  // Ask the contract for the verdict rather than re-deriving it. The boundary is exclusive
  // — measured against testnet, exactly 1.100000 is unhealthy and 1.100001 is healthy — so
  // a locally recomputed comparison would disagree with the chain at the boundary.
  const verdict = await simulate(rpc, engine, "is_account_healthy", [
    StellarSdk.nativeToScVal(BigInt(balanceWad), { type: "u256" }),
    StellarSdk.nativeToScVal(BigInt(debtWad), { type: "u256" }),
  ], options.signal);
  if (typeof verdict.value !== "boolean") {
    throw new ContractHealthError("invalid_health_verdict", "is_account_healthy did not return a boolean.");
  }

  return {
    leg: options.leg ?? "current",
    balanceWad,
    debtWad,
    contractHealthy: verdict.value,
    ledger: reads.balance.ledger,
    observedAt,
    contract: engine,
    wasmHash,
    registryDiverged: engine !== CONTRACT_ADDRESSES.RISK_ENGINE,
  };
}
