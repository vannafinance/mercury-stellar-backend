import { describe, expect, it } from "vitest";
import { isIndependentGoal, isRefinement, runIsOnEarlierTurn, shouldContinueInvestigation, shouldReplacePlan } from "@/lib/copilot/investigation/thread";

describe("investigation thread continuation", () => {
  it("always continues when a question is open, including a one-word variant answer", () => {
    expect(shouldContinueInvestigation("SOUSDC", { question: "Which USDC variant?", status: "needs_input" })).toBe(true);
    expect(shouldContinueInvestigation("ok", { question: "May I borrow?", status: "needs_input" })).toBe(true);
  });

  it("continues a floor or amount refinement of a researched strategy", () => {
    const last = {
      question: null as string | null,
      status: "researched",
      understanding: { intent: "strategy" as const },
    };
    expect(shouldContinueInvestigation("make it 1.4 instead", last)).toBe(true);
    expect(isRefinement("make it 1.4 instead")).toBe(true);
    expect(shouldReplacePlan("make it 1.4 instead", last)).toBe(true);
  });

  it("does not inherit the objective for an independent goal, including over an open question", () => {
    const last = {
      question: null as string | null,
      status: "researched",
      understanding: { intent: "strategy" as const },
    };
    expect(shouldContinueInvestigation("what's my health factor", last)).toBe(false);
    expect(shouldContinueInvestigation("price of XLM", last)).toBe(false);
    expect(isIndependentGoal("repay 1 XLM")).toBe(true);
    expect(shouldReplacePlan("what's my health factor", last)).toBe(false);
    expect(shouldReplacePlan("repay 1 XLM", last)).toBe(true);
    expect(shouldContinueInvestigation("what's my health factor", {
      question: "Which USDC variant?", status: "needs_input",
    })).toBe(false);
    expect(shouldReplacePlan("what's my health factor", {
      question: "Which USDC variant?", status: "needs_input",
    })).toBe(false);
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
