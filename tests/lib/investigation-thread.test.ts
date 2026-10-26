import { describe, expect, it } from "vitest";
import { bringsItsOwnPlan, isStaleFinishedRun, runIsOnEarlierTurn, unfinishedRunOwnerIndex } from "@/lib/copilot/investigation/thread";
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
    // 7 Oct, live: a stated multi-step action has no candidate list, only the id of its plan; the old plan stayed and the new one never showed.
    expect(bringsItsOwnPlan({ candidates: null, proposalCandidateId: "requested_actions" })).toBe(true);
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

/**
 * 7 Oct, live (auto-approve on): the run this reply's own plan started was cleared the moment it completed, because "a finished run
 * is in the way" could not tell an earlier reply's run from this one's, and no summary was ever written for it.
 */
describe("a finished run that stands in the way of the next plan", () => {
  it("is one prepared for an earlier reply, never the run this reply's own plan started", () => {
    const done = { status: "completed" };
    expect(isStaleFinishedRun(done, "r1.earlier", "r1.now")).toBe(true);
    expect(isStaleFinishedRun(done, null, "r1.now")).toBe(true);
    expect(isStaleFinishedRun(done, "r1.now", "r1.now")).toBe(false);
  });

  it("is only ever a run that has finished", () => {
    for (const status of ["proposed", "approved", "running", "validating"]) expect(isStaleFinishedRun({ status }, "r1.earlier", "r1.now")).toBe(false);
    for (const status of ["completed", "cancelled", "blocked"]) expect(isStaleFinishedRun({ status }, "r1.earlier", "r1.now")).toBe(true);
    expect(isStaleFinishedRun(null, null, "r1.now")).toBe(false);
  });
});

describe("the card of an unfinished run stays under the reply that started it", () => {
  const receipt = (workflowId: string) => ({ workflowId, status: "awaiting_signature", network: "testnet", steps: [] }) as never;
  const user = { role: "user" as const };
  const owner = { role: "assistant" as const, executionReceipt: receipt("wf-1") };

  it("is that reply once a newer question has been answered (26 Oct: a refusal drew the deposit's card under itself)", () => {
    expect(unfinishedRunOwnerIndex([user, owner, user, { role: "assistant" as const }], "wf-1", false)).toBe(1);
  });

  it("is that reply while the next prompt is still pending, before its bubble is in the thread", () => {
    expect(unfinishedRunOwnerIndex([user, owner], "wf-1", true)).toBe(1);
    expect(unfinishedRunOwnerIndex([user, owner, user], "wf-1", true)).toBe(1);
  });

  it("stays at the end of the thread while its own reply is the newest", () => {
    expect(unfinishedRunOwnerIndex([user, owner], "wf-1", false)).toBe(-1);
  });

  it("is never found for another run, no run, or a reply that continues an account setup", () => {
    expect(unfinishedRunOwnerIndex([user, owner, user, { role: "assistant" as const }], "wf-2", false)).toBe(-1);
    expect(unfinishedRunOwnerIndex([user, owner, user, { role: "assistant" as const }], null, false)).toBe(-1);
    expect(unfinishedRunOwnerIndex([user, owner, { role: "assistant" as const }], "wf-1", false)).toBe(-1);
  });
});
