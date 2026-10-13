import { describe, expect, it } from "vitest";
import { askForUnchosenActionAssets } from "@/lib/copilot/investigation/unstated-amount";
import type { ResearchDecision } from "@/lib/copilot/investigation/types";

const message = "lend 5 usdc to earn";
const action = { op: "lend" as const, asset: "BLUSDC", sizing: { kind: "literal" as const, amount: "5", sourceQuote: message }, sourceQuote: message };
function complete(actions = [action]): ResearchDecision {
  return { kind: "research_complete", goal: { intent: "strategy", objective: message, constraints: [], borrowing: "forbidden", actions }, findings: [], openQuestions: [] };
}

describe("stated action asset clarification", () => {
  it("retains supplied sizing and asks only for the unresolved asset", () => {
    expect(askForUnchosenActionAssets(complete(), [message])).toMatchObject({ kind: "clarify", intent: "action", actions: [],
      missing: [{ op: "lend", asset: "USDC", slots: ["asset"], knownSizing: action.sizing, sourceQuote: message }] });
  });
  it("uses the same asset family for a model's structured clarification", () => {
    const decision = { kind: "clarify" as const, question: "Which?", missing: [{ op: "lend" as const, asset: "BLUSDC", slots: ["asset" as const], knownSizing: action.sizing, sourceQuote: message }] };
    expect(askForUnchosenActionAssets(decision, [message]).missing?.[0]).toMatchObject({ asset: "USDC", knownSizing: action.sizing });
  });
  it("leaves an explicitly selected asset and a general strategy untouched", () => {
    const explicit = complete([{ ...action, sourceQuote: "lend 5 BLUSDC to earn" }]);
    expect(askForUnchosenActionAssets(explicit, ["lend 5 BLUSDC to earn"])).toBe(explicit);
    const strategy = complete([]);
    expect(askForUnchosenActionAssets(strategy, ["compare my usdc yields"])).toBe(strategy);
  });
  it("does not accept unanchored action provenance or duplicate the stated action", () => {
    const unanchored = complete([{ ...action, sourceQuote: "another request" }]);
    expect(askForUnchosenActionAssets(unanchored, [message])).toBe(unanchored);
  });
  it("does not preserve a model-selected whole-wallet amount", () => {
    const decision: ResearchDecision = { ...complete(), kind: "research_complete", goal: { intent: "strategy", objective: "lend USDC", constraints: [], borrowing: "forbidden",
      actions: [{ ...action, sizing: { kind: "all_wallet" } }] }, findings: [], openQuestions: [] };
    expect(askForUnchosenActionAssets(decision, [message])).toMatchObject({ missing: [{ slots: ["asset", "amount"] }] });
    expect((askForUnchosenActionAssets(decision, [message]) as unknown as Extract<ResearchDecision, { kind: "clarify" }>).missing?.[0].knownSizing).toBeUndefined();
  });
});
