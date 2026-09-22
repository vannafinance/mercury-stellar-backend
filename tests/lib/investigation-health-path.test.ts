import { describe, expect, it } from "vitest";
import { healthFloorWad, validateHealthPath, type ContractHealthState } from "@/lib/copilot/investigation/health-path";

const WAD = BigInt(10) ** BigInt(18);
const policy = { floor: "1.3", boundary: "at_least" as const, contract: `C${"A".repeat(55)}`, wasmHash: "a".repeat(64), now: 10_000, maxAgeMs: 1000 };
const state = (overrides: Partial<ContractHealthState> = {}): ContractHealthState => ({
  leg: "baseline", balanceWad: String(BigInt(130) * WAD), debtWad: String(BigInt(100) * WAD), contractHealthy: true,
  ledger: 123, observedAt: 9500, contract: policy.contract, wasmHash: policy.wasmHash, ...overrides,
});

describe("contract health path gate", () => {
  it("distinguishes at least from strictly above without floating point rounding", () => {
    expect(validateHealthPath([state()], policy).valid).toBe(true);
    expect(validateHealthPath([state()], { ...policy, boundary: "strictly_above" }).valid).toBe(false);
    expect(validateHealthPath([state({ balanceWad: String(BigInt(130) * WAD - BigInt(1)) })], policy).valid).toBe(false);
    expect(validateHealthPath([state({ balanceWad: String(BigInt(130) * WAD + BigInt(1)) })], { ...policy, boundary: "strictly_above" }).valid).toBe(true);
  });
  it("rejects an unsafe intermediate leg even if the final state recovers", () => {
    expect(validateHealthPath([state(), state({ leg: "deploy", balanceWad: String(BigInt(120) * WAD) }), state({ leg: "repay" })], policy))
      .toMatchObject({ valid: false, failingLeg: "deploy", reason: "health_floor_breached" });
  });
  it("preserves contract rejections including tiny debt", () => {
    expect(validateHealthPath([state({ balanceWad: "0", debtWad: "1", contractHealthy: false })], policy).reason).toBe("contract_rejected");
    expect(validateHealthPath([state({ balanceWad: "0", debtWad: "0" })], policy).valid).toBe(true);
  });
  it.each([
    [{ wasmHash: "b".repeat(64) }, "contract_changed"],
    [{ observedAt: 8999 }, "stale_contract_state"],
    [{ observedAt: 10_001 }, "stale_contract_state"],
    [{ debtWad: "1e18" }, "invalid_contract_amount"],
    [{ balanceWad: String(BigInt(1) << BigInt(256)) }, "invalid_contract_amount"],
    [{ ledger: 124 }, "inconsistent_ledger"],
  ] as const)("rejects unusable evidence %o", (change, reason) => {
    expect(validateHealthPath([state(), state(change)], policy).reason).toBe(reason);
  });
  it("requires evidence and a valid explicit floor", () => {
    expect(validateHealthPath([], policy).valid).toBe(false);
    for (const value of ["", "1.1", "1.0", "NaN", "1e3", "1.3000000000000000001"]) expect(healthFloorWad(value)).toBeNull();
    expect(healthFloorWad("1.30")).toBe(BigInt(13) * WAD / BigInt(10));
  });
});
