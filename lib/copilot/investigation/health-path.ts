/**
 * Deterministic validation of contract-valued states, including intermediate legs.
 * This does not value positions, choose allocations, or authorize execution.
 * Callers must obtain these states from a trusted simulator, never model JSON.
 */
export interface ContractHealthState {
  leg: string;
  balanceWad: string;
  debtWad: string;
  contractHealthy: boolean;
  ledger: number;
  observedAt: number;
  contract: string;
  wasmHash: string;
}

const WAD = BigInt(10) ** BigInt(18);
const U256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
function uint(value: string): bigint | null {
  if (!/^(0|[1-9]\d{0,77})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= U256_MAX ? parsed : null;
}

/** Exact user decimal, not a float or a model-selected default. */
export function healthFloorWad(value: string): bigint | null {
  if (!/^[1-9]\d{0,3}(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * WAD + BigInt(fraction.padEnd(18, "0"));
  return result > BigInt(11) * WAD / BigInt(10) ? result : null;
}

export function validateHealthPath(states: readonly ContractHealthState[], input: {
  floor: string;
  boundary: "at_least" | "strictly_above";
  contract: string;
  wasmHash: string;
  now: number;
  maxAgeMs: number;
}): { valid: boolean; reason: string | null; failingLeg: string | null } {
  const fail = (reason: string, leg: string | null = null) => ({ valid: false, reason, failingLeg: leg });
  const floor = healthFloorWad(input.floor);
  if (floor === null) return fail("invalid_health_floor");
  if (!states.length) return fail("missing_contract_states");
  if (!Number.isFinite(input.now) || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0 || input.maxAgeMs > 60_000 ||
    !/^C[A-Z2-7]{55}$/.test(input.contract) || !/^[a-f0-9]{64}$/.test(input.wasmHash)) return fail("invalid_evidence_policy");
  let ledger: number | null = null;
  for (const state of states) {
    if (state.contract !== input.contract || state.wasmHash !== input.wasmHash) return fail("contract_changed", state.leg);
    if (!Number.isFinite(state.observedAt) || state.observedAt > input.now || input.now - state.observedAt > input.maxAgeMs)
      return fail("stale_contract_state", state.leg);
    // Sequential projections must share one baseline, not unrelated live snapshots.
    if (!Number.isSafeInteger(state.ledger) || state.ledger <= 0 || ledger !== null && ledger !== state.ledger)
      return fail("inconsistent_ledger", state.leg);
    ledger = state.ledger;
    const balance = uint(state.balanceWad), debt = uint(state.debtWad);
    if (balance === null || debt === null) return fail("invalid_contract_amount", state.leg);
    if (state.contractHealthy !== true) return fail("contract_rejected", state.leg);
    if (debt === BigInt(0)) continue;
    // Cross multiplication preserves tiny differences around a user floor.
    const difference = balance * WAD - debt * floor;
    if (difference < BigInt(0) || input.boundary === "strictly_above" && difference === BigInt(0))
      return fail("health_floor_breached", state.leg);
  }
  return { valid: true, reason: null, failingLeg: null };
}
