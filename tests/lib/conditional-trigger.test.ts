/**
 * A future condition is refused whenever the model names it (fail safe; the quote does not have to match).
 * A sizing phrase is `kind: "none"` and is not a refusal.
 */
import { describe, expect, it } from "vitest";
import { CONDITIONAL_REFUSAL, futureConditionRefusal } from "@/lib/copilot/conditional-guard";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { buildQuestionnaireSet } from "@/lib/copilot/investigation/questionnaire";

const goal = (trigger: unknown) => ({
  kind: "research_complete",
  goal: {
    objective: "act",
    constraints: [],
    borrowing: "unspecified",
    trigger,
  },
  findings: [{ summary: "noted", evidenceIds: [] }],
  openQuestions: [],
});

describe("future conditions are a field, not a phrase", () => {
  it("does not refuse a sizing limit", () => {
    const message = "borrow XLM until HF is 1.5";
    const parsed = parseDecision(goal({ kind: "none" }));
    if (!parsed || parsed.kind !== "research_complete") throw new Error("decision did not parse");
    expect(futureConditionRefusal(parsed.goal.trigger, [message])).toBeNull();
  });

  it("refuses a future condition whose quote the user wrote", () => {
    const message = "repay when XLM hits $0.30";
    const parsed = parseDecision(goal({ kind: "future_condition", sourceQuote: "when XLM hits $0.30" }));
    if (!parsed || parsed.kind !== "research_complete") throw new Error("decision did not parse");
    const text = futureConditionRefusal(parsed.goal.trigger, [message]);
    // In the user's own words, so they can see which clause was read as a condition (24 Oct, N7), and it says nothing was done.
    expect(text).toContain("“when XLM hits $0.30”");
    expect(text).toMatch(/so I did nothing/);
    expect(text).toMatch(/tell me the action itself/);
  });

  // Fails safe (Claude's audit, 24 Sep): a wrong pass would execute now what the user wanted later.
  it("still refuses a future condition whose quote the user did not write", () => {
    const parsed = parseDecision(goal({ kind: "future_condition", sourceQuote: "when the price arrives" }));
    if (!parsed || parsed.kind !== "research_complete") throw new Error("decision did not parse");
    expect(futureConditionRefusal(parsed.goal.trigger, ["repay when XLM hits $0.30"])).toBe(CONDITIONAL_REFUSAL);
  });

  it("still refuses a future condition that came with no quote at all", () => {
    const parsed = parseDecision(goal({ kind: "future_condition" }));
    if (!parsed || parsed.kind !== "research_complete") throw new Error("decision did not parse");
    expect(futureConditionRefusal(parsed.goal.trigger, ["repay when XLM hits $0.30"])).toBe(CONDITIONAL_REFUSAL);
  });

  it("seals a clarify trigger into the issued questionnaire", () => {
    const trigger = { kind: "future_condition" as const, sourceQuote: "when XLM hits $0.30" };
    const questionnaire = buildQuestionnaireSet(
      [{ op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "supply XLM" }],
      [{ id: "w", capability: "wallet_balances", args: {}, observedAt: Date.now(), status: "ok", data: {
        assets: [{ symbol: "XLM", balance: "10", decimals: 7, status: "ok" }], fee_reserve_xlm: "0",
      } }],
      Date.now(), ["supply XLM when XLM hits $0.30"], [], true, trigger,
    );
    expect(questionnaire?.trigger).toEqual(trigger);
  });
});

describe("the refusal names the clause it read as a condition", () => {
  const trigger = (quote: string) => ({ kind: "future_condition" as const, sourceQuote: quote });
  it("quotes it when the user wrote it, as in N7", () => {
    const text = futureConditionRefusal(trigger("when my debt is 2,400"), ["Repay 5,000 SoUSDC when my debt is 2,400."]);
    expect(text).toContain("\u201cwhen my debt is 2,400\u201d");
  });
  it("never quotes words the user did not write", () => {
    const text = futureConditionRefusal(trigger("when the moon rises"), ["Repay 5,000 SoUSDC when my debt is 2,400."]);
    expect(text).toBe(CONDITIONAL_REFUSAL);
    expect(text).not.toContain("moon");
  });
});
