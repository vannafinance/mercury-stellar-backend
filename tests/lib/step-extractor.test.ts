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

  it("decomposes a delta-neutral carry with no 'then' separator", () => {
    // This exact prompt has no clause-split marker ("then"/"after that"/";"), so it used
    // to arrive at clauseToStep as ONE clause, whose first matching rule (bare "deposit")
    // collapsed the whole strategy to a single deposit_collateral write — the borrow and
    // lend legs were silently dropped, and the run finished after one transaction.
    const p = extractOrderedPlan(
      "Deposit my 50 BLUSDC and run a delta-neutral XLM carry, keep me above 1.4 health",
    );
    expect(p?.kind).toBe("plan");
    expect(p?.template_id).toBe("delta_neutral_carry");
    expect(p!.steps.map((s) => s.op)).toEqual(["deposit_collateral", "borrow", "lend"]);
    expect(p!.steps[0]).toMatchObject({ asset: "BLUSDC", amount: 50 });
    // The carry asset is XLM, not BLUSDC — borrowing the deposited asset back would not
    // be delta-neutral. This is the second bug already seen on this exact prompt.
    expect(p!.steps[1]).toMatchObject({ op: "borrow", asset: "XLM" });
    expect(p!.steps[2]).toMatchObject({ op: "lend", asset: "XLM" });
    // Never invented: the user gave no borrow/lend amount, so neither leg gets one.
    expect(p!.steps[1].amount).toBeNull();
    expect(p!.steps[2].amount).toBeNull();
  });

  it("recognizes carry-trade phrasing without an adjacent asset", () => {
    const p = extractOrderedPlan("run a carry trade with 200 USDC, borrowing and lending XLM");
    expect(p?.kind).toBe("plan");
    expect(p?.template_id).toBe("delta_neutral_carry");
    expect(p!.steps.map((s) => s.op)).toEqual(["deposit_collateral", "borrow", "lend"]);
    expect(p!.steps[0]).toMatchObject({ asset: "USDC", amount: 200 });
    expect(p!.steps[1].asset).toBe("XLM");
  });

  it("does not treat an unrelated 'and ... health' prompt as a carry strategy", () => {
    const p = extractOrderedPlan("deposit 10 XLM and check my health factor");
    // No "carry"/"delta-neutral" vocabulary present — must fall through to the
    // ordinary clause extractor, which finds only one write and returns null.
    expect(p).toBeNull();
  });

  it("splits a comma-separated action list", () => {
    const p = extractOrderedPlan("deposit 100 BLUSDC, borrow 50 XLM, lend 50 XLM");
    expect(p?.kind).toBe("plan");
    expect(p!.steps.map((s) => s.op)).toEqual(["deposit_collateral", "borrow", "lend"]);
    expect(p!.steps[0]).toMatchObject({ asset: "BLUSDC", amount: 100 });
    expect(p!.steps[1]).toMatchObject({ asset: "XLM", amount: 50 });
    expect(p!.steps[2]).toMatchObject({ asset: "XLM", amount: 50 });
  });

  it("splits on a bare 'and' when each verb owns an amount", () => {
    const p = extractOrderedPlan("deposit 100 BLUSDC and borrow 50 XLM");
    expect(p?.kind).toBe("plan");
    expect(p!.steps.map((s) => s.op)).toEqual(["deposit_collateral", "borrow"]);
    expect(p!.steps[1]).toMatchObject({ asset: "XLM", amount: 50 });
  });

  it("keeps 'deposit and borrow' as one levered op", () => {
    // Splitting the idiom would leave a bare "deposit" clause with no amount.
    const c = splitStrategyClauses("deposit and borrow 100 BLUSDC at 2x");
    expect(c).toHaveLength(1);
    expect(c[0]).toBe("deposit and borrow 100 BLUSDC at 2x");
  });

  it("does not split a thousands separator", () => {
    const c = splitStrategyClauses("borrow 1,240 XLM");
    expect(c).toHaveLength(1);
    const p = extractOrderedPlan("deposit 2,000 BLUSDC, borrow 1,240 XLM");
    expect(p!.steps[0]).toMatchObject({ amount: 2000 });
    expect(p!.steps[1]).toMatchObject({ amount: 1240, asset: "XLM" });
  });

  it("reads a thousands-separated amount at full magnitude", () => {
    // Regression: the amount matcher's \d+ could not span "1,240", so the scan slid to
    // the tail and produced 240 — a silent 10x error on a real borrow, with no
    // clarification raised. Asserted on its own because a wrong amount that still
    // executes is worse than a parse failure.
    const p = extractOrderedPlan("deposit 10,000 BLUSDC, borrow 1,240 XLM");
    expect(p!.steps[0].amount).toBe(10000);
    expect(p!.steps[1].amount).toBe(1240);
  });

  it("does not split a decimal", () => {
    const c = splitStrategyClauses("park 0.5 XLM for yield keep HF above 1.4");
    expect(c).toHaveLength(1);
  });

  it("splits on sentence periods", () => {
    const p = extractOrderedPlan("Deposit 50 BLUSDC. Borrow 20 XLM.");
    expect(p!.steps.map((s) => s.op)).toEqual(["deposit_collateral", "borrow"]);
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
