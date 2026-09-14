/**
 * The model's plan contract at the parse boundary: shapes and sizing words only.
 * A number anywhere but inside `literal`, an op or asset outside the vocabulary, or an
 * unknown sizing word drops THAT plan (counted, so the card can say so) — never the
 * research it rides on, and never a number into the sizer.
 */

import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { decisionFromFunctionCalls } from "@/lib/copilot/investigation/decls";

const base = {
  kind: "research_complete",
  goal: { intent: "strategy", objective: "farm", constraints: [], borrowing: "allowed" },
  findings: [{ summary: "s", evidenceIds: ["e1"] }],
  openQuestions: [],
};
const leg = (op: string, asset = "XLM", sizing: unknown = { kind: "all_idle" }) => ({ op, asset, sizing });
const plan = (legs: unknown[], over: Record<string, unknown> = {}) => ({ title: "t", rationale: "r", evidenceIds: ["e1"], legs, ...over });

describe("research_complete plans", () => {
  it("parses shapes with sizing words and a quoted literal", () => {
    const decision = parseDecision({ ...base, plans: [plan([
      leg("deposit_collateral"), leg("supply_blend", "XLM", { kind: "previous_leg" }), leg("borrow", "XLM", { kind: "to_floor" }),
      leg("lend", "BLUSDC", { kind: "literal", amount: "50", sourceQuote: "lend 50 BLUSDC" }),
    ])] });
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.plans).toHaveLength(1);
    expect(decision.plans![0].legs.map((l) => l.sizing)).toEqual([
      { kind: "all_idle" }, { kind: "previous_leg" }, { kind: "to_floor" }, { kind: "literal", amount: "50", sourceQuote: "lend 50 BLUSDC" },
    ]);
    expect(decision.droppedPlans).toBeUndefined();
  });

  it("accepts a bare sizing word, as a model without schema enforcement would send it", () => {
    const decision = parseDecision({ ...base, plans: [plan([leg("lend", "XLM", "all_idle")])] });
    expect(decision?.kind === "research_complete" && decision.plans?.[0].legs[0].sizing).toEqual({ kind: "all_idle" });
  });

  it.each([
    ["a number outside literal", [leg("borrow", "XLM", { kind: "to_floor", amount: "500" })]],
    ["a literal without its quote", [leg("borrow", "XLM", { kind: "literal", amount: "500" })]],
    ["a literal that is not a decimal", [leg("borrow", "XLM", { kind: "literal", amount: "max", sourceQuote: "borrow max" })]],
    ["an unknown sizing word", [leg("borrow", "XLM", { kind: "half" })]],
    ["an op outside the vocabulary", [leg("swap")]],
    ["an asset outside the registry", [leg("lend", "DOGE")]],
    ["seven legs", Array.from({ length: 7 }, () => leg("lend"))],
    ["no legs", []],
    ["an extra key", [{ ...leg("lend"), amount: "1" }]],
  ])("drops a plan with %s and keeps the research", (_name, legs) => {
    const decision = parseDecision({ ...base, plans: [plan(legs), plan([leg("lend")])] });
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.plans).toHaveLength(1);
    expect(decision.droppedPlans).toBe(1);
    expect(decision.goal.objective).toBe("farm");
  });

  it("keeps at most three plans and counts the rest as dropped", () => {
    const decision = parseDecision({ ...base, plans: Array.from({ length: 5 }, () => plan([leg("lend")])) });
    expect(decision?.kind === "research_complete" && decision.plans?.length).toBe(3);
    expect(decision?.kind === "research_complete" && decision.droppedPlans).toBe(2);
  });

  it("treats a non-array plans field as one dropped plan, not an invalid decision", () => {
    const decision = parseDecision({ ...base, plans: "deposit everything" });
    expect(decision?.kind === "research_complete" && decision.droppedPlans).toBe(1);
  });

  it("carries plans through the function-call form", () => {
    const decision = parseDecision(decisionFromFunctionCalls([{ name: "research_complete", args: {
      intent: "strategy", objective: "farm", constraints: [], borrowing: "allowed",
      findings: [{ summary: "s", evidenceIds: ["e1"] }], openQuestions: [],
      plans: [plan([leg("deposit_collateral"), leg("supply_blend", "XLM", { kind: "previous_leg" })])],
    } }]));
    expect(decision?.kind === "research_complete" && decision.plans?.[0].legs.length).toBe(2);
  });
});

describe("a fraction sizing", () => {
  it("is accepted with a percent, a base and a quote, and dropped when malformed", () => {
    const ok = parseDecision({ ...base, plans: [plan([leg("repay", "XLM", { kind: "fraction", percent: "25", of: "position", sourceQuote: "repay 25% of xlm debt" })])] });
    expect(ok?.kind === "research_complete" && ok.plans?.[0]?.legs[0]?.sizing).toEqual({ kind: "fraction", percent: "25", of: "position", sourceQuote: "repay 25% of xlm debt" });
    for (const bad of [
      { kind: "fraction", percent: "0", of: "idle", sourceQuote: "q" },
      { kind: "fraction", percent: "150", of: "idle", sourceQuote: "q" },
      { kind: "fraction", percent: "25", of: "debt", sourceQuote: "q" },
      { kind: "fraction", percent: "25", of: "idle" },
    ]) {
      const decision = parseDecision({ ...base, plans: [plan([leg("lend", "XLM", bad as never)])] });
      expect(decision?.kind === "research_complete" && decision.plans).toBeFalsy();
      expect(decision?.kind === "research_complete" && decision.droppedPlans).toBe(1);
    }
  });
});

describe("a malformed literal action", () => {
  it("is dropped and counted, and no longer voids the research or the plans beside it", () => {
    const decision = parseDecision({ ...base, goal: { ...base.goal, actions: [{ op: "redeem", asset: "AQUSDC", amount: "all", sourceQuote: "use my AqUSDC" }] },
      plans: [plan([leg("redeem", "AQUSDC", { kind: "all_position" }), leg("deposit_collateral", "AQUSDC", { kind: "previous_leg" })])] });
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.goal.actions).toBeUndefined();
    expect(decision.plans).toHaveLength(1);
    expect(decision.droppedPlans).toBe(1);
  });

  it("leaves a readable reason when a decision really is refused", async () => {
    const { lastDecisionRefusal } = await import("@/lib/copilot/investigation/decision");
    expect(parseDecision({ ...base, findings: [{ summary: "you hold 5000 AQUSDC in Earn", evidenceIds: [] }] })).toBeNull();
    expect(lastDecisionRefusal()).toMatch(/^findings: every finding stated a figure with no evidence \(1\)$/);
    expect(parseDecision({ ...base, findings: [{ summary: "s" }] })).toBeNull();
    expect(lastDecisionRefusal()).toMatch(/^finding: keys=summary evidence=\?$/);
    expect(parseDecision({ kind: "research_complete", goal: base.goal, findings: base.findings })).toBeNull();
    expect(lastDecisionRefusal()).toMatch(/^unknown kind or keys/);
  });
});

describe("a finding with nothing to cite", () => {
  /**
   * 13 Sep, "put my XLM and USDC into the Aquarius XLM/USDC LP": the model wrote the
   * limitation the prompt asks for — prose, no observation behind it — and the parser
   * refused the whole decision for the missing evidence id. The card said "invalid decision".
   */
  it("is kept when it states no figure — a limitation is prose, not a claim about the position", () => {
    const decision = parseDecision({ ...base, findings: [
      { summary: "Adding liquidity to the Aquarius XLM/USDC pool is not an operation this copilot can execute; LP receipts are not valued by the risk engine.", evidenceIds: [] },
      ...base.findings,
    ] });
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.findings).toHaveLength(base.findings.length + 1);
    expect(decision.droppedFindings).toBeUndefined();
  });

  it("is dropped and counted when it states a figure — a number needs a read behind it", () => {
    const decision = parseDecision({ ...base, findings: [
      { summary: "The pool holds 136024 XLM and 1546 AQUSDC.", evidenceIds: [] },
      ...base.findings,
    ] });
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.findings).toEqual(base.findings);
    expect(decision.droppedFindings).toBe(1);
  });
});
