import { describe, expect, it } from "vitest";
import { askForUnstatedAmounts } from "@/lib/copilot/investigation/unstated-amount";
import { parseSizing } from "@/lib/copilot/investigation/decision";

/**
 * 25 Sep, live: "lend 20 blusdc and deposit xlm" became "lend 20, then deposit 7,648 XLM", the
 * whole idle balance, because the model sized the deposit `all_wallet`. A stated action's amount
 * is never chosen for the user: it is asked.
 */
const goal = (actions: unknown[], plans?: unknown[]) => ({
  kind: "research_complete" as const,
  goal: { objective: "x", constraints: [], borrowing: "unspecified" as const, intent: "strategy" as const, actions },
  findings: [], openQuestions: [], ...(plans ? { plans } : {}),
});
const lend20 = { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "lend 20 blusdc" }, sourceQuote: "lend 20 blusdc" };
const depositIdle = { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_wallet" }, sourceQuote: "deposit xlm" };

describe("a stated action's all-idle amount is asked, never spent", () => {
  it("preserves an explicitly requested wallet balance while asking for the borrow asset", () => {
    const message = "deposit my idle XLM and borrow as much as I safely can";
    const action = { ...depositIdle, sourceQuote: "deposit my idle XLM", sizing: { kind: "all_wallet", sourceQuote: "my idle XLM" } };
    expect(parseSizing(action.sizing)).toEqual(action.sizing);
    const input = { kind: "clarify", question: "Which asset?", actions: [action], missing: [{ op: "borrow", slots: ["asset"], sizing: "to_floor" }] };
    expect(askForUnstatedAmounts(input as never, [message])).toBe(input);
  });

  it("does not trust an unanchored whole-wallet sizing quote", () => {
    const action = { ...depositIdle, sizing: { kind: "all_wallet", sourceQuote: "my entire balance" } };
    expect((askForUnstatedAmounts(goal([action]) as never, ["deposit xlm"]) as any).kind).toBe("clarify");
  });

  it("rejects malformed provenance and fields from other sizing modes", () => {
    expect(parseSizing({ kind: "all_wallet", sourceQuote: "" })).toBeNull();
    expect(parseSizing({ kind: "all_wallet", sourceQuote: "all my balance", amount: "10" })).toBeNull();
    expect(parseSizing({ kind: "to_floor", sourceQuote: "all my balance" })).toBeNull();
    expect(parseSizing({ kind: "all_wallet" })).toEqual({ kind: "all_wallet" });
  });
  it("turns the idle deposit into a question and keeps the stated lend", () => {
    const out = askForUnstatedAmounts(goal([lend20, depositIdle]) as never) as unknown as {
      kind: string; actions: typeof lend20[]; missing: Array<{ op: string; asset: string; slots: string[] }>;
    };
    expect(out.kind).toBe("clarify");
    expect(out.actions).toEqual([lend20]);
    expect(out.missing).toEqual([{ op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" }]);
  });

  it("does the same inside a clarify turn", () => {
    const out = askForUnstatedAmounts({ kind: "clarify", question: "?", actions: [lend20, depositIdle] } as never) as unknown as {
      actions: unknown[]; missing: unknown[];
    };
    expect(out.actions).toEqual([lend20]);
    expect(out.missing).toHaveLength(1);
  });

  it("leaves stated amounts, model-composed plans, and other outcomes alone", () => {
    const stated = goal([lend20]);
    expect(askForUnstatedAmounts(stated as never)).toBe(stated);
    const withPlans = goal([depositIdle], [{ title: "p", rationale: "r", evidenceIds: [], legs: [depositIdle] }]);
    expect(askForUnstatedAmounts(withPlans as never)).toBe(withPlans);
    const stopped = { kind: "stopped", reason: "deadline" };
    expect(askForUnstatedAmounts(stopped as never)).toBe(stopped);
  });
});
