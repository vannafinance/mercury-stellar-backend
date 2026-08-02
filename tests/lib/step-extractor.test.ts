import { describe, it, expect } from "vitest";
import {
  extractOrderedPlan,
  preferExtractedPlan,
  splitStrategyClauses,
} from "@/lib/copilot/step-extractor";

describe("step-extractor", () => {
  it("splits on then", () => {
    const c = splitStrategyClauses("swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC");
    expect(c.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts swap then farm without lend", () => {
    const p = extractOrderedPlan("swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC");
    expect(p?.kind).toBe("plan");
    const ops = p!.steps.map((s) => s.op);
    expect(ops).not.toContain("lend");
    expect(ops[0]).toBe("swap");
    expect(ops).toContain("deploy_to_blend");
    const swap = p!.steps.find((s) => s.op === "swap");
    expect(swap?.args?.token_out).toBe("BLUSDC");
  });

  it("extracts park then farm", () => {
    const p = extractOrderedPlan(
      "park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4",
    );
    expect(p?.kind).toBe("plan");
    const ops = p!.steps.map((s) => s.op);
    expect(ops).toContain("lend");
    expect(ops).toContain("deploy_to_blend");
    const lend = p!.steps.find((s) => s.op === "lend");
    expect(lend?.amount).toBe(20);
  });

  it("upgrades a collapsed single write to a plan", () => {
    const single = {
      kind: "write" as const,
      op: "swap",
      asset: "XLM",
      amount: 10,
      multi_leg: false,
      requires_account: true,
      requires_amount: true,
      template_id: "swap",
    };
    const out = preferExtractedPlan(
      single,
      "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC",
    );
    expect(out.kind).toBe("plan");
  });
});
