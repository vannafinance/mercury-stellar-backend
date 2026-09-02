/**
 * Live: a brand-new margin account (collateral $0, debt $0) answered
 * "URGENT: health factor 0.00 is below 1.00 — this account is liquidatable".
 *
 * deriveMarginHealth returns HF 0 for the empty case (∞ is only when there is
 * collateral and no debt). The guard treated any HF < 1 as liquidatable without
 * checking that liquidation requires debt.
 */
import { describe, expect, it } from "vitest";
import { withHfGuardrails } from "@/lib/copilot/handle";
import { deriveMarginHealth } from "@/lib/margin-health";

describe("empty account is not liquidatable", () => {
  it("deriveMarginHealth: no collateral, no debt → HF 0 (not ∞)", () => {
    expect(
      deriveMarginHealth({
        grossCollateralValue: 0,
        effectiveDebtValue: 0,
        totalBorrowedValue: 0,
      }).avgHealthFactor,
    ).toBe(0);
  });

  it("HF 0 with $0 debt does not append the liquidatable warning", () => {
    const out = withHfGuardrails("Health factor 0.00", 0, "what's my health factor?", 0);
    expect(out).not.toMatch(/liquidatable/i);
    expect(out).not.toMatch(/URGENT/i);
  });

  it("HF 0.8 with real debt still warns", () => {
    const out = withHfGuardrails("Health factor 0.80", 0.8, "what's my health factor?", 100);
    expect(out).toMatch(/URGENT/);
    expect(out).toMatch(/liquidatable/i);
  });
});
