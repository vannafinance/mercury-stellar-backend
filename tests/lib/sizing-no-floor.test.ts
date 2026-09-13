/**
 * `sizeLegs` with `floor: null`: the contract's liquidation line is the stop, nothing may
 * be sized to a max, and a health-raising sequence needs no floor at all.
 */
import { describe, expect, it } from "vitest";
import { sizeLegs } from "@/lib/copilot/investigation/sizing";

const base = { grossCollateralUsd: "6605.84", debtUsd: "5102.54" }; // HF 1.2946

describe("sizeLegs without a user floor", () => {
  it("projects a deposit and reports the health factor after it", () => {
    const result = sizeLegs(base, [{ op: "deposit_collateral", label: "deposit", amountUsd: "1837.14" }], null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Number(result.finalHealthFactor)).toBeCloseTo(1.6546, 3);
  });

  it("refuses to size a max borrow — a max needs a floor the user chose", () => {
    const result = sizeLegs(base, [{ op: "borrow", label: "borrow", amountUsd: "max" }], null);
    expect(result).toMatchObject({ ok: false, reason: "floor_required_for_max", failingLeg: "borrow" });
  });

  it("stops a sequence that would leave the account liquidatable", () => {
    // Withdrawing 1,200 USD of collateral: (6605.84 − 1200) / 5102.54 = 1.0594 ≤ 1.1.
    const result = sizeLegs(base, [{ op: "withdraw_collateral", label: "withdraw", amountUsd: "1200" }], null);
    expect(result).toMatchObject({ ok: false, reason: "would_be_liquidatable", failingLeg: "withdraw" });
  });

  it("still enforces a stated floor exactly as before", () => {
    expect(sizeLegs(base, [{ op: "deposit_collateral", label: "d", amountUsd: "1" }], "1.1")).toMatchObject({ ok: false, reason: "floor_below_liquidation_threshold" });
    expect(sizeLegs(base, [{ op: "borrow", label: "b", amountUsd: "max" }], "1.2").ok).toBe(true);
  });
});
