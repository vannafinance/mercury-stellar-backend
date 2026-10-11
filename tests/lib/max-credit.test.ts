import { describe, expect, it } from "vitest";
import { directMaximumCreditPlan, requestsMaximumCredit } from "@/lib/copilot/investigation/max-credit";
import type { GoalUnderstanding, ProposedPlan } from "@/lib/copilot/investigation/types";

const goal: GoalUnderstanding = { objective: "requested credit", constraints: [], borrowing: "required", intent: "strategy", namedOps: [{ op: "borrow", sourceQuote: "Take the largest loan" }] };
const plan: ProposedPlan = { title: "Largest loan", rationale: "Requested credit", evidenceIds: [], legs: [{ op: "borrow", asset: "AQUSDC", sizing: { kind: "to_floor" } }] };
describe("maximum credit survives either structured leg channel", () => {
  it("uses protocol sizing when a continuation comes back as a plan", () => {
    expect(requestsMaximumCredit(goal, [plan], ["Take the largest loan", "AQUSDC"])).toBe(true);
    expect(directMaximumCreditPlan(goal, [plan], ["Take the largest loan", "AQUSDC"])).toBe(0);
  });
  it("does not invent an asset or choose among alternatives", () => {
    expect(requestsMaximumCredit({ ...goal, namedOps: [] }, [plan])).toBe(false);
    expect(directMaximumCreditPlan(goal, [plan], ["Take the largest loan"])).toBe(-1);
    expect(directMaximumCreditPlan(goal, [plan, plan], ["AQUSDC"])).toBe(-1);
    expect(directMaximumCreditPlan(goal, [plan], ["AQUSDC or XLM"])).toBe(-1);
    expect(directMaximumCreditPlan({ ...goal, borrowing: "allowed" }, [plan], ["AQUSDC"])).toBe(-1);
    expect(directMaximumCreditPlan({ ...goal, namedOps: [] }, [plan], ["Take the largest loan", "AQUSDC"])).toBe(-1);
  });
});
