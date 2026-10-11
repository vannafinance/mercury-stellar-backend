import { describe, expect, it } from "vitest";
import { directPositionPlan } from "@/lib/copilot/investigation/direct-position";
import type { GoalUnderstanding, ProposedPlan } from "@/lib/copilot/investigation/types";

const request = "remove USDC position from blend farm";
const goal: GoalUnderstanding = { intent: "strategy", objective: request, constraints: [], borrowing: "forbidden", namedOps: [{ op: "blend_withdraw", sourceQuote: request }] };
const plan: ProposedPlan = { title: "Exit Blend", rationale: "Return the held position.", evidenceIds: [], legs: [{ op: "blend_withdraw", asset: "BLUSDC", sizing: { kind: "all_position" } }] };

describe("direct position provenance", () => {
  it("recognizes the user's named whole position regardless of the model's leg channel", () => {
    expect(directPositionPlan(goal, [plan], [request])).toBe(0);
  });
  it("preserves a requested position exit duplicated in both model channels", () => {
    const actions = [{ ...plan.legs[0], sourceQuote: request }];
    expect(directPositionPlan({ ...goal, actions }, [plan], [request])).toBe(0);
  });
  it("does not discard additional requested steps when a plan contains only one", () => {
    const actions = [{ ...plan.legs[0], sourceQuote: request }, { ...plan.legs[0], asset: "XLM", sourceQuote: request }];
    expect(directPositionPlan({ ...goal, actions }, [plan], [request])).toBe(-1);
  });
  it("does not choose between alternatives or authorize unquoted operations", () => {
    expect(directPositionPlan(goal, [plan, plan], [request])).toBe(-1);
    expect(directPositionPlan({ ...goal, namedOps: [] }, [plan], [request])).toBe(-1);
    expect(directPositionPlan(goal, [plan], ["what are the Blend rates?"])).toBe(-1);
  });
  it("does not convert an answer or full portfolio exit into a direct position action", () => {
    expect(directPositionPlan({ ...goal, intent: "answer" }, [plan], [request])).toBe(-1);
    expect(directPositionPlan({ ...goal, portfolioExit: { destination: "wallet", sourceQuote: request } }, [plan], [request])).toBe(-1);
  });
  it("preserves asset ambiguity for a venue with multiple USDC variants", () => {
    const quote = "redeem my USDC";
    expect(directPositionPlan({ ...goal, namedOps: [{ op: "redeem", sourceQuote: quote }] }, [{ ...plan, legs: [{ op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } }] }], [quote])).toBe(-1);
  });
  it("recognizes a named asset in a position held in a multi-asset venue", () => {
    const quote = "redeem my AQUSDC";
    expect(directPositionPlan({ ...goal, namedOps: [{ op: "redeem", sourceQuote: quote }] }, [{ ...plan, legs: [{ op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } }] }], [quote])).toBe(0);
  });
});
