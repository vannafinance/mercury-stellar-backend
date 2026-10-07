import { describe, expect, it } from "vitest";
import { bringsItsOwnPlan, runIsOnEarlierTurn } from "@/lib/copilot/investigation/thread";
import { inheritsThread, shownPlans } from "@/lib/copilot/investigation/thread-context";

/** Whether a message continues the plan on screen is the model's reading; these are the rules code applies to its answer. */
describe("what a follow-up inherits", () => {
  it("carries the thread for a refinement and for an answer to an open question, and for nothing else", () => {
    expect(inheritsThread("refine", null)).toBe(true);
    expect(inheritsThread(undefined, "Which USDC variant?")).toBe(true);
    expect(inheritsThread("new", "Which USDC variant?")).toBe(false);
    expect(inheritsThread("side", "Which USDC variant?")).toBe(false);
    expect(inheritsThread("new", null)).toBe(false);
    expect(inheritsThread("side", null)).toBe(false);
    expect(inheritsThread(undefined, null)).toBe(false);
  });

  it("names the plans on screen by the letters their cards show", () => {
    const shown = shownPlans([{ label: "Lend USDC", steps: [{ label: "Lend 5 BLUSDC to Earn" }] }, { label: "Supply XLM" }]);
    expect(shown).toEqual([
      { plan: "Plan A", title: "Lend USDC", steps: ["Lend 5 BLUSDC to Earn"] },
      { plan: "Plan B", title: "Supply XLM", steps: [] },
    ]);
  });
});

describe("what replaces the plan on screen", () => {
  it("is a reply that brings its own plans, write or form - never an answer or a question", () => {
    expect(bringsItsOwnPlan({ candidates: { feasible: [{} as never], rejected: [] } })).toBe(true);
    expect(bringsItsOwnPlan({ pendingWrite: { op: "create_account" } as never })).toBe(true);
    expect(bringsItsOwnPlan({ directAction: true })).toBe(true);
    expect(bringsItsOwnPlan({ candidates: null })).toBe(false);
    expect(bringsItsOwnPlan({ candidates: { feasible: [], rejected: [] } })).toBe(false);
    expect(bringsItsOwnPlan(null)).toBe(false);
  });
});

describe("a finished run on an earlier reply", () => {
  const receipt = (workflowId: string) => ({ workflowId, status: "completed", network: "testnet", steps: [] }) as never;
  const run = { id: "wf-1", finished: true };

  it("is history once a newer reply exists, so the thread draws its card", () => {
    const turns = [
      { role: "user" as const }, { role: "assistant" as const, executionReceipt: receipt("wf-1") },
      { role: "user" as const }, { role: "assistant" as const },
    ];
    expect(runIsOnEarlierTurn(turns, run)).toBe(true);
  });

  it("stays on the live card while its own reply is still the newest", () => {
    const turns = [{ role: "user" as const }, { role: "assistant" as const, executionReceipt: receipt("wf-1") }];
    expect(runIsOnEarlierTurn(turns, run)).toBe(false);
  });

  it("never treats a run still in progress as past", () => {
    const turns = [
      { role: "user" as const }, { role: "assistant" as const, executionReceipt: receipt("wf-1") },
      { role: "user" as const }, { role: "assistant" as const },
    ];
    expect(runIsOnEarlierTurn(turns, { id: "wf-1", finished: false })).toBe(false);
  });
});
