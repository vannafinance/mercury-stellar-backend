import { describe, it, expect } from "vitest";
import { extractPlanIR, extractConstraints } from "@/lib/copilot/step-extractor";
import { classifyCoverage, classifyResidueText, residueIsMaterial } from "@/lib/copilot/residue";
import { detectAutomationGap } from "@/lib/copilot/conditional-guard";

const ops = (m: string) => extractPlanIR(m).steps.map((s) => s.op);

describe("named-strategy overlay does not swallow the message", () => {
  /**
   * Both of these regressed once already, in opposite directions. First the carry was
   * ignored and only the deposit ran; the fix made the carry claim the whole message, so a
   * following leg was dropped instead. The overlay reads what it recognises and the
   * splitter runs on the remainder, so neither half can absorb the other.
   */
  it("keeps a follow-on Earn leg alongside a carry", () => {
    const ir = extractPlanIR(
      "Deposit 50 BLUSDC, run a delta-neutral XLM carry, and also lend 20 XLM on Earn",
    );
    expect(ir.steps.map((s) => s.op)).toEqual([
      "deposit_collateral",
      "borrow",
      "lend",
      "lend",
    ]);
    // The explicit 20 XLM lend is the leg that used to vanish.
    expect(ir.steps[3]).toMatchObject({ op: "lend", asset: "XLM", amount: 20 });
    expect(ir.source).toBe("merged");
    expect(ir.coverage.residue).toHaveLength(0);
  });

  it("keeps a follow-on Blend leg alongside a carry", () => {
    const ir = extractPlanIR(
      "run a delta-neutral XLM carry with 100 BLUSDC then farm 10 BLUSDC at 2x",
    );
    expect(ir.steps.map((s) => s.op)).toContain("deploy_to_blend");
    expect(ir.steps.find((s) => s.op === "deploy_to_blend")).toMatchObject({ amount: 10 });
    expect(ir.coverage.residue).toHaveLength(0);
  });

  it("still decomposes a bare carry into exactly three legs", () => {
    const ir = extractPlanIR(
      "Deposit my 50 BLUSDC and run a delta-neutral XLM carry, keep me above 1.4 health",
    );
    expect(ir.steps.map((s) => s.op)).toEqual(["deposit_collateral", "borrow", "lend"]);
    expect(ir.source).toBe("named_strategy");
    expect(ir.constraints.minHf).toBe(1.4);
    // The floor is claimed text, not leftovers.
    expect(ir.coverage.verdict).toBe("complete");
  });
});

describe("constraints are read once and carried", () => {
  it("claims the floor's span so it is never reported as residue", () => {
    const c = extractConstraints("borrow 50 XLM, keep my health factor above 1.4");
    expect(c.minHf).toBe(1.4);
    expect(c.spans.length).toBeGreaterThan(0);
  });

  it("never lets a floor become an amount", () => {
    const ir = extractPlanIR("deposit 20 BLUSDC and borrow XLM keeping HF above 1.4");
    expect(ir.constraints.minHf).toBe(1.4);
    for (const s of ir.steps) expect(s.amount).not.toBe(1.4);
  });
});

describe("coverage is complete on prompts that behave correctly", () => {
  it.each([
    "deposit 100 BLUSDC, borrow 50 XLM, lend 50 XLM",
    "deposit 100 BLUSDC and borrow 50 XLM",
    "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC",
    "park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4",
    "deposit and borrow 100 BLUSDC at 2x",
    "please deposit 50 BLUSDC for me if you can",
  ])("no unclaimed clause in %j", (prompt) => {
    expect(extractPlanIR(prompt).coverage.residue).toHaveLength(0);
  });

  it("preserves the deposit-and-borrow idiom as one levered op", () => {
    // Splitting the idiom would produce an unlevered deposit plus an unlevered borrow,
    // which executes differently from the levered op the phrase names.
    expect(ops("deposit and borrow 100 BLUSDC at 2x")).toEqual(["deposit_and_borrow"]);
  });
});

describe("residue classification surfaces unless proven safe", () => {
  it("drops politeness", () => {
    expect(classifyResidueText("please, for me, if you can").decision).toBe("drop");
  });

  it("notes reassurance without blocking", () => {
    expect(classifyResidueText("keep it safe").decision).toBe("note");
  });

  it("refuses a condition it cannot watch", () => {
    const d = classifyResidueText("unless XLM drops below 0.10");
    expect(d.class).toBe("condition");
    expect(d.decision).toBe("refuse");
  });

  it("treats a dropped action as an action, however politely worded", () => {
    // The exact hole the old cascade fell through: a courteous second goal.
    const d = classifyResidueText("and if you could also farm 10 BLUSDC at 2x");
    expect(d.class).toBe("action");
    expect(d.decision).toBe("parse_or_ask");
  });

  it("surfaces anything no safe pattern claims", () => {
    expect(classifyResidueText("rebalance into the basket").decision).toBe("surface");
  });

  it("does not absorb a health-factor floor as reassurance", () => {
    // "keep me above 1.4" must stay surfaced if constraint extraction ever misses it —
    // "above" is deliberately outside the reassurance adjective set.
    const d = classifyResidueText("keep me above 1.4");
    expect(d.class).not.toBe("sentiment");
    expect(d.decision).not.toBe("drop");
  });

  it("reports materiality only for residue that changes the plan", () => {
    const soft = extractPlanIR("deposit 50 BLUSDC and keep it safe");
    expect(residueIsMaterial(classifyCoverage(soft.coverage))).toBe(false);
  });
});

describe("unwatchable conditions cannot disappear", () => {
  it("records the condition and refuses the turn", () => {
    const msg = "deposit 50 BLUSDC unless XLM drops below 0.10";
    // "unless" is not a clause separator, so the condition rides inside a claimed clause.
    // It is still accounted for, and the routing gate independently refuses it.
    expect(extractPlanIR(msg).coverage.intraClause.map((r) => r.text)).toContain(
      "unless XLM drops below 0.10",
    );
    expect(detectAutomationGap(msg, true)?.kind).toBe("conditional");
  });
});
