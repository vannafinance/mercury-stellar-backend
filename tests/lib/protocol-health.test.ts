import { describe, expect, it } from "vitest";
import { parseHealthPayload } from "@/lib/copilot/protocol-health";

describe("parseHealthPayload", () => {
  it("computes HF as collateral/debt and ignores liquidation_threshold 0.909", () => {
    const { hf, collateral, debt } = parseHealthPayload({
      collateral_usd: "1400",
      debt_usd: "1000",
      liquidation_threshold: "0.909",
      ltv_ratio: "0.714",
    });
    expect(collateral).toBe(1400);
    expect(debt).toBe(1000);
    expect(hf).toBeCloseTo(1.4, 10);
    expect(hf).not.toBeCloseTo(1.4 * 0.909, 3);
  });

  it("prefers C/D over a haircutted health_factor field", () => {
    const { hf } = parseHealthPayload({
      collateral_usd: "1400",
      debt_usd: "1000",
      health_factor: "1.2726",
    });
    expect(hf).toBeCloseTo(1.4, 10);
  });

  it("returns null HF when there is no debt", () => {
    expect(parseHealthPayload({ collateral_usd: "100", debt_usd: "0" }).hf).toBeNull();
  });
});
