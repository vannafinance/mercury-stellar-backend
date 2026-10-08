// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatTurns } from "@/components/copilot/chat-message";
import { runningPlan, runningPlanText } from "@/components/copilot/running-plan";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";

afterEach(cleanup);

const options = [{ id: "first", label: "Lend XLM" }, { id: "second", label: "Supply BLUSDC" }];
const turns: ThreadTurn[] = [
  { role: "user", text: "Compare my options" },
  { role: "assistant", text: "Compare the two plans", blocks: [{ type: "paragraph", segments: [{ text: "Old comparison" }] }],
    executionReceipt: { workflowId: "current", status: "running", network: "testnet", steps: [] } },
];

describe("the chosen plan's running presentation", () => {
  it("uses the journal's selection after local component selection is lost on restore", () => {
    expect(runningPlan({ status: "awaiting_signature", candidateId: null,
      workflowCandidateId: "second", feasible: options })).toEqual({ letter: "B", title: "Supply BLUSDC" });
    expect(runningPlan({ status: "running", candidateId: "first",
      workflowCandidateId: "second", feasible: options })).toEqual({ letter: "B", title: "Supply BLUSDC" });
  });
  it("uses the selected candidate's position rather than its wording", () => {
    expect(runningPlan({ status: "running", candidateId: "second", feasible: options })).toEqual({ letter: "B", title: "Supply BLUSDC" });
    expect(runningPlanText({ letter: "B", title: "Supply BLUSDC." })).toBe("Running Plan B: Supply BLUSDC.");
  });

  it.each(["proposed", "completed", "blocked", "cancelled", "uncertain"])("keeps the original reply in %s", status => {
    expect(runningPlan({ status, candidateId: "second", feasible: options })).toBeNull();
  });

  it("does not infer a selection or label a single option", () => {
    expect(runningPlan({ status: "running", candidateId: "unknown", feasible: options })).toBeNull();
    expect(runningPlan({ status: "running", candidateId: "first", feasible: options.slice(0, 1) })).toBeNull();
  });

  it("replaces only the current run's comparison, then restores it when the override ends", () => {
    const view = render(<ChatTurns turns={turns} hideReceiptFor="current" runningPlanText="Running Plan B: Supply BLUSDC." />);
    expect(screen.getByText("Running Plan B: Supply BLUSDC.")).toBeTruthy();
    expect(screen.queryByText("Old comparison")).toBeNull();
    view.rerender(<ChatTurns turns={turns} hideReceiptFor="current" />);
    expect(screen.getByText("Old comparison")).toBeTruthy();
  });

  it("never overwrites a side reply, a pending turn or another workflow", () => {
    const view = render(<ChatTurns turns={turns} hideReceiptFor="other" runningPlanText="Wrong run" />);
    expect(screen.getByText("Old comparison")).toBeTruthy();
    view.rerender(<ChatTurns turns={turns} hideReceiptFor="current" runningPlanText="Wrong run" pendingUser="New question" />);
    expect(screen.getByText("Old comparison")).toBeTruthy();
    view.rerender(<ChatTurns turns={[...turns, { role: "user", text: "My health?" }, { role: "assistant", text: "Health is 2" }]} hideReceiptFor="current" runningPlanText="Wrong run" />);
    expect(screen.getByText("Health is 2")).toBeTruthy();
    expect(screen.queryByText("Wrong run")).toBeNull();
  });
});
