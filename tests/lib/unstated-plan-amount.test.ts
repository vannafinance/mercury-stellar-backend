import { describe, expect, it } from "vitest";
import { askForUnstatedPlanAmounts } from "@/lib/copilot/investigation/unstated-amount";
import type { ProposedPlan } from "@/lib/copilot/investigation/types";
import { parseDecision } from "@/lib/copilot/investigation/decision";

/**
 * 7 Oct, live: "deposit XLM" came back as a plan that deposits the whole balance, because the model called a plain instruction a
 * strategy and the guard for stated actions never saw it. The model now says which operations the user named; an amount the copilot
 * would choose for a named operation is a missing amount, so the questionnaire asks for it - whatever the request was called.
 */
const leg = (op: string, asset: string, sizing: Record<string, unknown>) => ({ op, asset, sizing }) as never;
const plan = (title: string, ...legs: unknown[]): ProposedPlan => ({ title, rationale: "r", evidenceIds: [], legs }) as never;
const complete = (plans: ProposedPlan[], namedOps?: Array<{ op: string; sourceQuote: string }>) => ({
  kind: "research_complete" as const,
  goal: { objective: "o", constraints: [], borrowing: "unspecified" as const, intent: "strategy" as const, ...(namedOps ? { namedOps } : {}) },
  findings: [], openQuestions: [], plans,
}) as never;
const MESSAGES = ["deposit XLM"];

describe("a named operation with an amount the copilot would choose", () => {
  it("preserves an anchored allocation delegation across required venues without asking for amounts", () => {
    const message = "allocate my funds across LP and Blend";
    const input = parseDecision({ kind: "research_complete", goal: { objective: message, constraints: [], borrowing: "forbidden", intent: "strategy",
      allocationRequest: { sourceQuote: "allocate my funds" }, namedOps: [{ op: "supply_blend", sourceQuote: "Blend" }] },
      findings: [{ summary: "Review the allocation.", evidenceIds: [] }], openQuestions: [], plans: [plan("Allocation", leg("supply_blend", "XLM", { kind: "all_wallet" }))] });
    expect(input?.kind).toBe("research_complete");
    expect(askForUnstatedPlanAmounts(input!, [message])).toBe(input);
    const unanchored = structuredClone(input!) as any;
    unanchored.goal.allocationRequest.sourceQuote = "choose all amounts yourself";
    expect((askForUnstatedPlanAmounts(unanchored, [message]) as any).kind).toBe("clarify");
  });
  it("rejects malformed allocation delegation instead of disabling the amount guard", () => {
    expect(parseDecision({ kind: "research_complete", goal: { objective: "o", constraints: [], borrowing: "forbidden", intent: "strategy", allocationRequest: { sourceQuote: "" } }, findings: [], openQuestions: [] })).toBeNull();
  });
  it("retains a named operation sized by the user's anchored whole-wallet instruction", () => {
    const message = "supply my entire BLUSDC wallet balance";
    const input = complete([plan("Supply", leg("lend", "BLUSDC", { kind: "all_wallet", sourceQuote: "my entire BLUSDC wallet balance" }))], [{ op: "lend", sourceQuote: message }]);
    expect(askForUnstatedPlanAmounts(input, [message])).toBe(input);
    const unanchored = complete([plan("Supply", leg("lend", "BLUSDC", { kind: "all_wallet", sourceQuote: "made up instruction" }))], [{ op: "lend", sourceQuote: message }]);
    expect((askForUnstatedPlanAmounts(unanchored, [message]) as any).kind).toBe("clarify");
  });
  it("becomes a missing amount, with the user's own sentence", () => {
    const out: any = askForUnstatedPlanAmounts(
      complete([plan("Deposit XLM", leg("deposit_collateral", "XLM", { kind: "all_wallet" }))], [{ op: "deposit_collateral", sourceQuote: "deposit XLM" }]), MESSAGES);
    expect(out.kind).toBe("clarify");
    expect(out.missing).toEqual([{ op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit XLM" }]);
    expect(out.question).toBe("How much for deposit XLM?");
  });

  it("covers a split the copilot made as well as the whole balance", () => {
    const out: any = askForUnstatedPlanAmounts(
      complete([plan("Lend", leg("lend", "BLUSDC", { kind: "fraction", percent: "50", of: "wallet", sourceQuote: "", allocation: { reason: "split" } }))], [{ op: "lend", sourceQuote: "deposit XLM" }]), MESSAGES);
    expect(out.kind).toBe("clarify");
    expect(out.missing[0].op).toBe("lend");
  });

  it("asks once per operation and asset, however many alternative plans repeat it", () => {
    const out: any = askForUnstatedPlanAmounts(complete([
      plan("A", leg("lend", "BLUSDC", { kind: "all_wallet" })), plan("B", leg("lend", "AQUSDC", { kind: "all_wallet" })),
    ], [{ op: "lend", sourceQuote: "deposit XLM" }]), MESSAGES);
    expect(out.missing).toHaveLength(1);
  });

  it("leaves alone a plan whose amount the user gave, a goal with no named operation, and an unrelated quote", () => {
    const given = complete([plan("A", leg("deposit_collateral", "XLM", { kind: "literal", amount: "5", sourceQuote: "5 XLM" }))], [{ op: "deposit_collateral", sourceQuote: "deposit XLM" }]);
    expect(askForUnstatedPlanAmounts(given, MESSAGES)).toBe(given);
    const goal = complete([plan("A", leg("deposit_collateral", "XLM", { kind: "all_wallet" }))]);
    expect(askForUnstatedPlanAmounts(goal, MESSAGES)).toBe(goal);
    const invented = complete([plan("A", leg("deposit_collateral", "XLM", { kind: "all_wallet" }))], [{ op: "deposit_collateral", sourceQuote: "something the user never wrote" }]);
    expect(askForUnstatedPlanAmounts(invented, MESSAGES)).toBe(invented);
  });

  it("does not ask when only some alternatives are affected, and ignores an operation that was not named", () => {
    const mixed = complete([
      plan("A", leg("deposit_collateral", "XLM", { kind: "all_wallet" })),
      plan("B", leg("lend", "BLUSDC", { kind: "all_wallet" })),
    ], [{ op: "deposit_collateral", sourceQuote: "deposit XLM" }]);
    expect(askForUnstatedPlanAmounts(mixed, MESSAGES)).toBe(mixed);
    const unnamed = complete([plan("A", leg("lend", "BLUSDC", { kind: "all_wallet" }))], [{ op: "deposit_collateral", sourceQuote: "deposit XLM" }]);
    expect(askForUnstatedPlanAmounts(unnamed, MESSAGES)).toBe(unnamed);
  });
});
