// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { preparingStatedRun } from "@/components/copilot/preparing-run";
import { REQUESTED_ACTIONS_ID } from "@/lib/copilot/investigation/candidate-id";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * A stated action has no plan card.
 *
 * 8 Oct, live, "deposit 5 XLM" with auto-approve ON: for about 13 s the screen showed the PLAN FOR
 * APPROVAL card with a disabled "Checking..." button, then jumped to the execution card. The owner's
 * rule (24 Sep) is that an action the user stated shows the execution card, in both auto-approve states.
 * The journal reads `proposed` while the live check runs, and that state used to draw the plan card.
 */

const base = { status: "proposed", hasSwap: false, withdrawn: false, busy: false, approvalQueued: false };

describe("preparingStatedRun", () => {
  it("stands in for the plan card while a stated action's approval is in flight or queued", () => {
    expect(preparingStatedRun({ ...base, stated: true, busy: true })).toBe(true);
    expect(preparingStatedRun({ ...base, stated: true, approvalQueued: true })).toBe(true);
  });
  it("leaves a strategy option to its plan card", () => {
    expect(preparingStatedRun({ ...base, stated: false, busy: true })).toBe(false);
    expect(preparingStatedRun({ ...base, stated: false, approvalQueued: true })).toBe(false);
  });
  it("shows Approve again when a stated action's approval failed and nothing is in flight", () => {
    expect(preparingStatedRun({ ...base, stated: true })).toBe(false);
  });
  it("keeps a swap on its own review card, a withdrawn plan on its notice, and a started run on its stepper", () => {
    expect(preparingStatedRun({ ...base, stated: true, busy: true, hasSwap: true })).toBe(false);
    expect(preparingStatedRun({ ...base, stated: true, busy: true, withdrawn: true })).toBe(false);
    expect(preparingStatedRun({ ...base, stated: true, busy: true, status: "running" })).toBe(false);
  });
});

function result(candidateId: string): ResearchView {
  return {
    status: "researched", message: "Deposit 5 XLM as collateral. Approve to run this step.", originalRequest: "deposit 5 XLM", refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [], continuation: "c1", executionAllowed: false,
    proposalCandidateId: candidateId,
    scope: { wallet: null, smartAccount: null, network: "testnet" },
  } as unknown as ResearchView;
}

const proposed = {
  id: "wf-1", revision: 1, digest: "d", status: "proposed", objective: "Deposit 5 XLM as collateral", expiresAt: 0,
  assumptions: [], constraints: [], message: "",
  steps: [{ id: "s1", op: "deposit_collateral", asset: "XLM", amount: "5", label: "Deposit 5 XLM as collateral", status: "pending" }],
} as unknown as WorkflowView;

function card(candidateId: string, extra: { workflowLoading?: boolean; approvalQueued?: boolean }) {
  return render(
    <InvestigationCard prompt="deposit 5 XLM" result={result(candidateId)} progress={null} loading={false} error={null}
      omitTranscript workflow={proposed} onApprove={() => {}} {...extra} />,
  );
}

describe("InvestigationCard while a plan is proposed", () => {
  it("draws the execution card, not the plan card, for a stated action being approved", () => {
    card(REQUESTED_ACTIONS_ID, { workflowLoading: true });
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /plan for approval/i })).toBeNull();
    expect(screen.getByText(/Checking it before it is sent/i)).toBeTruthy();
  });
  it("does the same in the frame before the approval request leaves", () => {
    card(REQUESTED_ACTIONS_ID, { approvalQueued: true });
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /plan for approval/i })).toBeNull();
  });
  it("keeps the plan card for a strategy option, whatever is in flight", () => {
    card("composed:le.XLM", { workflowLoading: true });
    expect(screen.queryByRole("region", { name: /plan for approval/i })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeNull();
  });
  it("offers Approve again for a stated action whose approval did not go through", () => {
    card(REQUESTED_ACTIONS_ID, {});
    expect(screen.queryByRole("region", { name: /plan for approval/i })).toBeTruthy();
  });
});
