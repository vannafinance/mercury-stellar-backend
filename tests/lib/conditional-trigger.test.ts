/**
 * A future condition is refused only when the model names it and the quote is the user's.
 * A sizing phrase is `kind: "none"` and is not a refusal.
 */
import { describe, expect, it } from "vitest";
import { CONDITIONAL_REFUSAL, futureConditionRefusal } from "@/lib/copilot/conditional-guard";
import { parseDecision } from "@/lib/copilot/investigation/decision";

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
    expect(futureConditionRefusal(parsed.goal.trigger, [message])).toBe(CONDITIONAL_REFUSAL);
  });

  it("ignores a future-condition quote the user did not write", () => {
    const parsed = parseDecision(goal({ kind: "future_condition", sourceQuote: "when the price arrives" }));
    if (!parsed || parsed.kind !== "research_complete") throw new Error("decision did not parse");
    expect(futureConditionRefusal(parsed.goal.trigger, ["repay when XLM hits $0.30"])).toBeNull();
  });
});
