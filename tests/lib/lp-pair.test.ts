import { describe, expect, it } from "vitest";
import { applyLpFillToSteps, lpSides, lpStableFor, pairedFromSelected } from "@/lib/copilot/lp-pair";

describe("Farm-style LP pair sizing", () => {
  it("maps Aquarius / AQUSDC to AQUSDC and Soroswap / SOUSDC to SOUSDC", () => {
    expect(lpStableFor("AQUSDC")).toBe("AQUSDC");
    expect(lpStableFor("aquarius")).toBe("AQUSDC");
    expect(lpStableFor("SOUSDC")).toBe("SOUSDC");
    expect(lpStableFor("soroswap")).toBe("SOUSDC");
    expect(lpSides("AQUSDC")).toEqual(["XLM", "AQUSDC"]);
    expect(lpSides(null, null, "soroswap")).toEqual(["XLM", "SOUSDC"]);
  });

  it("sizes the other side from one input the way Farm does", () => {
    // 1 XLM ≈ 0.014 AQUSDC  →  1 AQUSDC ≈ 71.4286 XLM
    const otherPerXlm = 0.014;
    expect(pairedFromSelected("XLM", 10, otherPerXlm)).toEqual({
      xlm: 10,
      other: 0.14,
    });
    const fromStable = pairedFromSelected("AQUSDC", 1, otherPerXlm);
    expect(fromStable.other).toBe(1);
    expect(fromStable.xlm).toBeCloseTo(1 / 0.014, 6);
  });

  it("applyLpFillToSteps sizes add_liquidity on the chosen side without touching other ops", () => {
    const steps: Array<{
      op: string;
      asset: string | null;
      amount: number | null;
      args: Record<string, unknown>;
    }> = [
      { op: "swap", asset: "XLM", amount: 10, args: { token_out: "AQUSDC" } },
      { op: "add_liquidity", asset: "AQUSDC", amount: null, args: { venue: "aquarius" } },
    ];
    const filled = applyLpFillToSteps(steps, { asset: "XLM", amount: 20, venue: "aquarius" });
    expect(filled[0].amount).toBe(10);
    expect(filled[1].amount).toBe(20);
    expect(filled[1].asset).toBe("XLM");
    expect(filled[1].args?.amount_a).toBe(20);
    expect(filled[1].args?.amount_b).toBeNull();
    expect(filled[1].args?.token_b).toBe("AQUSDC");
  });
});
