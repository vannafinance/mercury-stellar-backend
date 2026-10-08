// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { ChatTurns } from "@/components/copilot/chat-message";
import type { Candidate, CandidateSet } from "@/lib/copilot/investigation/candidates";
import { candidateId } from "@/lib/copilot/investigation/candidate-id";
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

// Plans the model composed from the wallet, written out the way `resolvePlans` returns them: the fixed
// generator no longer volunteers wallet options, but the card has to lay out any set of plans.
const walletPlan = (asset: string, apyPct: string): Candidate => ({
  id: candidateId("composed", `le.${asset}`), kind: "composed", label: `Lend ${asset} to Earn`, borrows: false, asset, venue: "earn",
  netAprPct: null, supplyAprPct: apyPct, supplyApyPct: apyPct, netApyPct: null, legs: [], finalHealthFactor: null,
  amountUsd: "680", evidenceIds: ["e1"], amountBasis: "stated",
});
const twoPlans = (): CandidateSet => ({ feasible: [walletPlan("SOUSDC", "4.20"), walletPlan("AQUSDC", "4.50")], rejected: [] });

const cardFor = (result: ResearchView, extra: Partial<Parameters<typeof InvestigationCard>[0]> = {}) =>
  render(<InvestigationCard prompt={result.originalRequest} result={result} progress={null} loading={false} error={null} {...extra} />);

afterEach(() => vi.useRealTimers());

describe("plan cards", () => {
  it("does not expose raw unavailable-read diagnostics or an empty Notes list", () => {
    const result = view({ warnings: ["asset price: data was unavailable. No value was assumed."] });
    cardFor(result);
    expect(screen.queryByRole("list", { name: "Notes" })).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });

  it("keeps actionable safety notes beside a filtered read diagnostic", () => {
    cardFor(view({ warnings: ["asset price: data was unavailable. No value was assumed.", "Sizing is unavailable; do not approve a borrow."] }));
    const notes = screen.getByRole("list", { name: "Notes" });
    expect(notes.textContent).toContain("do not approve a borrow");
    expect(notes.textContent).not.toContain("No value was assumed");
  });

  it("does not redisplay legacy diagnostic notes beneath a failed read response", () => {
    cardFor(view({ status: "incomplete", message: "Account data could not be loaded.", understanding: { intent: "answer", objective: "Read health", constraints: [], borrowing: "unspecified" }, warnings: ["Legacy unavailable-read diagnostic", "Legacy research pipeline diagnostic"] }), { turns: [{ role: "assistant", text: "Account data could not be loaded." }] });
    expect(screen.getByText("Account data could not be loaded.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Notes" })).toBeNull();
  });
  it("preserves safety warnings for an incomplete strategy", () => {
    cardFor(view({ status: "incomplete", understanding: { intent: "strategy", objective: "Compare plans", constraints: [], borrowing: "allowed" }, warnings: ["Sizing is unavailable; do not approve a borrow."] }));
    expect(screen.getByRole("list", { name: "Notes" }).textContent).toContain("Sizing is unavailable");
  });
  it("keeps progress wording, clock and previous server prose beside the loading mark", () => {
    vi.useFakeTimers();
    render(<InvestigationCard prompt="Review my position" result={null} progress={{ kind: "reviewing", turn: 1 }} loading error={null} turns={[{ role: "user", text: "Earlier question" }, { role: "assistant", text: "The server explanation stays in the conversation." }]} />);
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status").textContent).toContain("Working out what to check next");
    expect(screen.getByRole("status").textContent).toMatch(/\(.*\)/);
    expect(screen.getByText("The server explanation stays in the conversation.")).toBeTruthy();
  });

  it("gives the chosen plan one Approve and Cancel, and no Options heading, Ruled out list or figures explainer", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Approve/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Approve Plan A" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan A" }));
    expect(onApproveCandidate).toHaveBeenCalledWith(candidates.feasible[0].id);
    fireEvent.click(screen.getByRole("radio", { name: /Plan B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan B" }));
    expect(onApproveCandidate).toHaveBeenLastCalledWith(candidates.feasible[1].id);
    expect(onPropose).not.toHaveBeenCalled();
  });

  it("closes only the chosen plan on Cancel (owner, 24 Sep: Plan B's Cancel removed Plan A too)", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    fireEvent.click(screen.getByRole("radio", { name: /Plan B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Plan A")).toBeTruthy();
    expect(screen.queryByText("Plan B")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.queryByTestId("plans-cancelled")).toBeNull();
  });

  it("says nothing was submitted once every plan is cancelled", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    fireEvent.click(screen.getByRole("radio", { name: /Plan B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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

/**
 * How many plans decides the layout (mockup boards 5–9): one is a full card that previews
 * its first steps, two sit side by side with steps behind a toggle, three or more are a
 * compact list where only the opened plan carries Approve.
 */
describe("plan layouts by count", () => {
  const withSteps = (candidate: ReturnType<typeof twoPlans>["feasible"][number], count: number) => ({
    ...candidate,
    steps: Array.from({ length: count }, (_, i) => ({ id: `${candidate.id}-s${i}`, op: "lend", asset: "AQUSDC", amount: "1", label: `Step ${i + 1} of ${candidate.id}` })),
  }) as typeof candidate;

  it("previews a single plan's first four steps and offers the rest", () => {
    const base = twoPlans();
    const one = withSteps(base.feasible[0], 6);
    cardFor(view({ candidates: { ...base, feasible: [one] } }), { onPropose: vi.fn() });
    expect(screen.getAllByText(/^Step \d of /)).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 steps" }));
    expect(screen.getAllByText(/^Step \d of /)).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Hide steps" })).toBeTruthy();
  });

  it("offers two plans as a pick-one list, the chosen one open, with its steps behind a toggle", () => {
    const base = twoPlans();
    cardFor(view({ candidates: { ...base, feasible: base.feasible.map((c) => withSteps(c, 3)) } }), { onPropose: vi.fn() });
    expect(screen.getByRole("radiogroup", { name: "Choose a plan" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Plan A/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Plan B/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryAllByText(/^Step \d of /)).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Show the 3 steps" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: /Plan B/ }));
    expect(screen.getAllByRole("button", { name: "Show the 3 steps" })).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Plan B/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves the choice with the arrow keys", () => {
    cardFor(view({ candidates: twoPlans() }), { onPropose: vi.fn() });
    fireEvent.keyDown(screen.getByRole("radio", { name: /Plan A/ }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /Plan B/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Approve Plan B" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("radio", { name: /Plan B/ }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /Plan A/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps three or more plans in the same pick-one list, with one Approve for the chosen one", () => {
    const base = twoPlans();
    const third = { ...base.feasible[1], id: `${base.feasible[1].id}-c`, label: "A third plan" };
    cardFor(view({ candidates: { ...base, feasible: [...base.feasible, third] } }), { onPropose: vi.fn() });
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Approve/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: /A third plan/ }));
    expect(screen.getAllByRole("button", { name: /^Approve/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Approve Plan C" })).toBeTruthy();
  });
});

describe("a write choice", () => {
  it("opens a margin account only when its button is clicked", () => {
    const onWrite = vi.fn(); const onReply = vi.fn();
    cardFor(view({
      message: "You don't have a margin account yet.", understanding: null,
      choices: [{ id: "create_account", label: "Open a margin account", write: "create_account" }],
    }), { onWrite, onReply });
    expect(onWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open a margin account" }));
    expect(onWrite).toHaveBeenCalledWith("create_account");
    expect(onReply).not.toHaveBeenCalled();
  });
});
