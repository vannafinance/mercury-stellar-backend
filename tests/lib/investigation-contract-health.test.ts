import { describe, expect, it, vi } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { readContractHealthState, ContractHealthError } from "@/lib/copilot/investigation/contract-health";
import { validateHealthPath } from "@/lib/copilot/investigation/health-path";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

/**
 * The trusted simulator behind the health floor.
 *
 * `validateHealthPath` refuses states from model JSON, so this is the only sanctioned
 * source. Everything here is offline: the RPC client is injected, and no test reaches
 * the network. What matters is that a partial or inconsistent read becomes an ERROR
 * rather than a health factor — a numerator and denominator from two different ledgers
 * are not a health factor, and neither is a balance with a missing debt.
 */

const ENGINE = "CCSCBA4WSUMVGA4CWC7QKBZXXEL4TO2YCCFPGHX5SJCYKHQLQUKAVUAY";
const ACCOUNT = "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ";
const WASM = "3e9d1180d2fb4efa4629000000000000000000000000000000000000000000aa";

/** Minimal shape `rpc.Api.isSimulationSuccess` accepts, plus the retval it reads. */
function success(retval: StellarSdk.xdr.ScVal, latestLedger: number) {
  return {
    latestLedger,
    minResourceFee: "0",
    transactionData: {},
    events: [],
    result: { retval, auth: [] },
  };
}

function contractInstance(wasmHex: string) {
  const wasmHash = { toString: (enc: string) => (enc === "hex" ? wasmHex : wasmHex) };
  const executable = () => ({ wasmHash: () => wasmHash });
  return { val: { contractData: () => ({ val: () => ({ instance: () => ({ executable }) }) }) } };
}

/**
 * Answer each contract method in order of the module's call sequence:
 * registry resolve → totals (parallel) → is_account_healthy.
 */
function rpcStub(options: {
  engine?: string;
  balance?: string;
  debt?: string;
  healthy?: boolean;
  balanceLedger?: number | number[];
  debtLedger?: number | number[];
  wasm?: string;
}) {
  const balanceLedgers = [options.balanceLedger ?? 100].flat();
  const debtLedgers = [options.debtLedger ?? 100].flat();
  let balanceCall = 0;
  let debtCall = 0;
  const at = (list: number[], index: number) => list[Math.min(index, list.length - 1)];
  const simulateTransaction = vi.fn(async (tx: StellarSdk.Transaction) => {
    // The invoked function name is the only thing this stub needs to dispatch on.
    const op = tx.operations[0] as { func?: { invokeContract?: () => { functionName: () => { toString: () => string } } } };
    const name = op.func?.invokeContract?.().functionName().toString() ?? "";
    if (name === "get_risk_engine_address") {
      return success(StellarSdk.nativeToScVal(options.engine ?? ENGINE, { type: "address" }), 100);
    }
    if (name === "get_current_total_balance") {
      return success(StellarSdk.nativeToScVal(BigInt(options.balance ?? "3201700390866888623283"), { type: "u256" }),
        at(balanceLedgers, balanceCall++));
    }
    if (name === "get_current_total_borrows") {
      return success(StellarSdk.nativeToScVal(BigInt(options.debt ?? "1752018314227471074759"), { type: "u256" }),
        at(debtLedgers, debtCall++));
    }
    if (name === "is_account_healthy") {
      return success(StellarSdk.nativeToScVal(options.healthy ?? true, { type: "bool" }), 100);
    }
    throw new Error(`unexpected method ${name}`);
  });
  return {
    simulateTransaction: simulateTransaction as never,
    getContractData: vi.fn(async () => contractInstance(options.wasm ?? WASM) as never),
  };
}

describe("contract health simulator", () => {
  it("reports the contract's own balance, debt and verdict", async () => {
    const rpc = rpcStub({});
    const state = await readContractHealthState(ACCOUNT, { rpc, now: () => 1_000, leg: "current" });

    expect(state).toMatchObject({
      leg: "current",
      balanceWad: "3201700390866888623283",
      debtWad: "1752018314227471074759",
      contractHealthy: true,
      ledger: 100,
      observedAt: 1_000,
      contract: ENGINE,
      wasmHash: WASM,
      registryDiverged: false,
    });
  });

  it("produces a state validateHealthPath accepts, and enforces the floor on it", async () => {
    const rpc = rpcStub({});
    const state = await readContractHealthState(ACCOUNT, { rpc, now: () => 5_000 });
    const policy = { contract: ENGINE, wasmHash: WASM, now: 5_000, maxAgeMs: 30_000 } as const;

    // 3201.70 / 1752.02 = 1.827, so a 1.30 floor holds and a 2.00 floor does not.
    expect(validateHealthPath([state], { ...policy, floor: "1.30", boundary: "at_least" }))
      .toEqual({ valid: true, reason: null, failingLeg: null });
    expect(validateHealthPath([state], { ...policy, floor: "2.00", boundary: "at_least" }))
      .toMatchObject({ valid: false, reason: "health_floor_breached" });
  });

  it("refuses a balance and debt read from two different ledgers", async () => {
    // Both attempts straddle a ledger close, so there is no consistent pair to report.
    const rpc = rpcStub({ balanceLedger: [100, 102], debtLedger: [101, 103] });
    await expect(readContractHealthState(ACCOUNT, { rpc })).rejects.toThrow("one ledger");
  });

  it("retries once when a ledger closes mid-read, then reports the consistent pair", async () => {
    const rpc = rpcStub({ balanceLedger: [100, 102], debtLedger: [101, 102] });
    const state = await readContractHealthState(ACCOUNT, { rpc });
    expect(state.ledger).toBe(102);
  });

  it("passes the contract's unhealthy verdict through instead of re-deriving it", async () => {
    // The boundary is exclusive on chain (exactly 1.100000 is unhealthy), so the verdict
    // is the contract's to give — a local ratio would disagree at the boundary.
    const rpc = rpcStub({ balance: "110", debt: "100", healthy: false });
    const state = await readContractHealthState(ACCOUNT, { rpc });
    expect(state.contractHealthy).toBe(false);
    expect(validateHealthPath([state], {
      floor: "1.30", boundary: "at_least", contract: ENGINE, wasmHash: WASM, now: state.observedAt, maxAgeMs: 30_000,
    })).toMatchObject({ valid: false, reason: "contract_rejected" });
  });

  it("flags a registry that no longer resolves to the compiled-in address", async () => {
    const other = "CAZLR6EHZXQNZJIFNP6F7SIJQC3P64MKHHQNZSSG5BNAEFCYTTGTDZXB";
    const rpc = rpcStub({ engine: other });
    const state = await readContractHealthState(ACCOUNT, { rpc });
    expect(state.contract).toBe(other);
    expect(state.registryDiverged).toBe(true);
    expect(other).not.toBe(CONTRACT_ADDRESSES.RISK_ENGINE);
  });

  it("rejects a wallet address, and anything that is not a smart account", async () => {
    const rpc = rpcStub({});
    for (const bad of ["GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52", "", "not-an-address"]) {
      await expect(readContractHealthState(bad, { rpc })).rejects.toBeInstanceOf(ContractHealthError);
    }
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unreadable code hash rather than reporting an unverifiable state", async () => {
    const rpc = rpcStub({ wasm: "not-a-hash" });
    await expect(readContractHealthState(ACCOUNT, { rpc })).rejects.toThrow("code hash");
  });

  it("stops before any read when already cancelled", async () => {
    const rpc = rpcStub({});
    const controller = new AbortController();
    controller.abort();
    await expect(readContractHealthState(ACCOUNT, { rpc, signal: controller.signal })).rejects.toThrow();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
});
