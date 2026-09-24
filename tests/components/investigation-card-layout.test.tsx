// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { ChatTurns } from "@/components/copilot/chat-message";
import { generateCandidates } from "@/lib/copilot/investigation/candidates";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * The owner's layout (23 Sep sketch): user bubble, the reply, then ONE card. A plan card
 * carries Approve and Cancel; on Approve the same card becomes the execution card; several
 * alternatives are Plan A / B / C, each with its own Approve. No extra jargon.
 */

function view(over: Partial<ResearchView> = {}): ResearchView {
  return {
    status: "researched", message: "Plans below.", originalRequest: "supply my usdc",
    refinements: [], understanding: { objective: "Supply USDC", constraints: [], borrowing: "unspecified" },
    question: null, facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
    warnings: [], scope: { wallet: "G", smartAccount: "C", network: "testnet" },
    continuation: "sealed", executionAllowed: false, ...over,
  };
}

const twoPlans = () => generateCandidates({
  grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30", borrowingAllowed: false,
  idleWalletUsd: "77665",
  idleWalletByAssetUsd: { SOUSDC: "74985", AQUSDC: "2680" },
  idleWalletByAssetTokens: { SOUSDC: "74985", AQUSDC: "2680" },
  comparisons: (["SOUSDC", "AQUSDC"] as const).map((asset, i) => ({
    asset, earnSupplyApr: i ? "4.5" : "4.2", blendSupplyApr: null, marginBorrowApr: null,
    spreadApr: null, verdict: "earn_only" as const, evidenceIds: ["e1"],
  })),
});

const cardFor = (result: ResearchView, extra: Partial<Parameters<typeof InvestigationCard>[0]> = {}) =>
  render(<InvestigationCard prompt={result.originalRequest} result={result} progress={null} loading={false} error={null} {...extra} />);

describe("plan cards", () => {
  it("gives every plan Approve and Cancel, and no Options heading, Ruled out list or figures explainer", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: /^Options?$/ })).toBeNull();
    expect(screen.queryByText(/How these figures are made/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Prepare this plan|Use the other option/ })).toBeNull();
  });

  it("names a single plan without a Plan A label", () => {
    const one = twoPlans();
    cardFor(view({ candidates: { ...one, feasible: one.feasible.slice(0, 1) } }), { onPropose: vi.fn() });
    expect(screen.queryByText("Plan A")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("prefers the one-click approve when the workspace provides it", () => {
    const onApproveCandidate = vi.fn(); const onPropose = vi.fn();
    const candidates = twoPlans();
    cardFor(view({ candidates }), { onApproveCandidate, onPropose });
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    expect(onApproveCandidate).toHaveBeenCalledWith(candidates.feasible[0].id);
    expect(onPropose).not.toHaveBeenCalled();
  });

  it("closes only the plan whose Cancel was pressed (owner, 24 Sep: Plan B's Cancel removed Plan A too)", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
    expect(screen.getByText("Plan A")).toBeTruthy();
    expect(screen.queryByText("Plan B")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.queryByTestId("plans-cancelled")).toBeNull();
  });

  it("says nothing was submitted once every plan is cancelled", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByTestId("plans-cancelled").textContent).toMatch(/Nothing was submitted/);
  });
});

describe("Understood as", () => {
  // Owner, 24 Sep (live): no restatement block at all; the plan card shows what will run.
  it("is never drawn, even when the understanding differs from what was typed", () => {
    cardFor(view({ originalRequest: "lend me 30xlm", understanding: { objective: "Borrow 30 XLM on margin", constraints: ["No new borrowing"], borrowing: "forbidden" }, candidates: twoPlans() }));
    expect(screen.queryByText("Understood as")).toBeNull();
    expect(screen.queryByText("No new borrowing")).toBeNull();
  });
});

describe("did-you-mean choices", () => {
  it("renders each choice as a button that sends its text as the next turn", () => {
    const onReply = vi.fn();
    cardFor(view({ question: "Did you mean AQUSDC or SOUSDC?", choices: [
      { id: "AQUSDC", label: "AQUSDC", send: "swap 100 xlm to AQUSDC" },
      { id: "SOUSDC", label: "SOUSDC", send: "swap 100 xlm to SOUSDC" },
    ] }), { onReply });
    fireEvent.click(screen.getByRole("button", { name: "SOUSDC" }));
    expect(onReply).toHaveBeenCalledWith("swap 100 xlm to SOUSDC");
  });
});

describe("one run, drawn in the plan card's place", () => {
  const run: WorkflowView = {
    id: "wf-1", revision: 1, digest: "d", status: "running", objective: "Supply 100 XLM to Blend",
    expiresAt: 0, assumptions: [], constraints: [], slippageAccepted: false, message: "Running step 1.",
    steps: [{ id: "s1", op: "supply_blend", asset: "XLM", amount: "100", label: "Supply 100 XLM to Blend", status: "invoking" }],
  } as WorkflowView;
  const turns: ThreadTurn[] = [
    { role: "user", text: "supply 100 xlm to blend" },
    { role: "assistant", text: "Supply 100 XLM to Blend.", executionReceipt: {
      workflowId: "wf-1", status: "running", network: "testnet",
      steps: [{ operation: "supply_blend", asset: "XLM", amount: "100", status: "invoking" }],
    } },
  ];

  it("draws the execution stepper in the card when the thread defers its receipt", () => {
    render(<InvestigationCard prompt="supply 100 xlm to blend" result={view()} progress={null} loading={false} error={null}
      turns={turns} omitTranscript workflow={run} threadDefersReceipt />);
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeTruthy();
  });

  it("leaves that receipt out of the thread, and keeps other runs' receipts", () => {
    const { rerender } = render(<ChatTurns turns={turns} hideReceiptFor="wf-1" />);
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeNull();
    rerender(<ChatTurns turns={turns} hideReceiptFor="wf-other" />);
    expect(screen.queryByRole("region", { name: /execution progress/i })).toBeTruthy();
  });
});
