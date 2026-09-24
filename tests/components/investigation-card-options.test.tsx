// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { generateCandidates, type Candidate } from "@/lib/copilot/investigation/candidates";
import { candidateId } from "@/lib/copilot/investigation/candidate-id";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";
import { strategyReply } from "@/lib/copilot/investigation/answer";

/**
 * The Options block, rendered.
 *
 * `investigation-candidates.test.ts` proves the sizing and the ranking; this proves the
 * numbers survive the trip to the screen. The gap matters: a candidate set that generates
 * correctly and renders as an empty div is indistinguishable, to the person reading it,
 * from "nothing was considered" — which is the exact false impression the rejected-with-a-
 * reason rule exists to prevent.
 *
 * Deliberately built from `generateCandidates` rather than hand-written candidate
 * literals, so a change to the generated shape fails here instead of quietly rendering a
 * stale fixture that no longer resembles what the service produces.
 */

const comparison = (over: Partial<RateComparison> = {}): RateComparison => ({
  asset: "BLUSDC",
  earnSupplyApr: "25.41",
  blendSupplyApr: "10",
  marginBorrowApr: "4",
  spreadApr: "6",
  verdict: "positive_before_costs",
  evidenceIds: ["e1"],
  ...over,
});

function view(over: Partial<ResearchView> = {}): ResearchView {
  return {
    status: "researched",
    message: "I’ve compared the reported supply and borrowing rates below.",
    originalRequest: "Use USDC and XLM so the health factor does not go below 1.3.",
    refinements: [],
    understanding: { objective: "Build a yield position", constraints: ["Health factor at or above 1.3"], borrowing: "allowed" },
    question: null,
    facts: [],
    capacity: null,
    candidates: null,
    rateComparisons: [],
    checks: [],
    warnings: [],
    scope: { wallet: "GDW3B2", smartAccount: "CAHLZM", network: "testnet" },
    continuation: "sealed",
    executionAllowed: false,
    ...over,
  };
}

const card = (result: ResearchView) =>
  render(
    <InvestigationCard
      prompt={result.originalRequest}
      result={result}
      progress={null}
      loading={false}
      error={null}
    />,
  );

describe("investigation card / options", () => {
  it("renders each sized candidate with its net carry and resulting health factor", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    });
    card(view({ candidates }));

    // Owner layout (23 Sep): plan cards, named Plan A / B when there are several; no "Options" heading.
    expect(screen.getByRole("region", { name: /^Plans?$/ })).toBeTruthy();
    expect(screen.getByText(/Borrow BLUSDC to the 1.30 floor and supply it to Blend/)).toBeTruthy();
    // Quoted as APY (23 Sep, owner): the figure is the candidate's own, not a restated constant.
    const levered = candidates.feasible.find((c) => c.borrows)!;
    expect(screen.getByText(`+${Number(levered.netApyPct).toFixed(2)}% net APY`)).toBeTruthy();
    // The full-precision $6,541.043333… reads at the precision a person uses, and the
    // projected floor is shown next to it — a size with no health consequence beside it
    // is the number that gets approved without being understood.
    expect(screen.getByText("$6,537.46")).toBeTruthy();
    expect(screen.getAllByText("Health factor after")[0].nextElementSibling?.textContent).toBe("1.30");
  });

  it("says a ruled-out shape WITH its reason in the reply, never as a silent omission", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30", idleWalletUsd: null,
      comparisons: [comparison({ blendSupplyApr: "3", marginBorrowApr: "7", spreadApr: "-4", verdict: "cost_exceeds_supply" })],
    });
    card(view({ candidates }));
    // UI-FIX-LIST 12/16 (owner): no "Ruled out" card; the reply states it once.
    expect(screen.queryByText(/Ruled out: Borrow BLUSDC to supply to Blend/)).toBeNull();
    const reply = strategyReply({ status: "researched", facts: [], candidates, capacity: null, question: null });
    expect(reply).toMatch(/Borrow BLUSDC to supply to Blend/);
    expect(reply).toMatch(/loses money before any fees/);
  });

  it("renders the non-borrowing alternative without inventing a health-factor change", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30",
      // Per-token, not a combined total: only BLUSDC actually held can fund a BLUSDC supply.
      idleWalletUsd: "680", idleWalletByAssetUsd: { BLUSDC: "680" }, comparisons: [comparison()],
    });
    card(view({ candidates }));

    expect(screen.getByText(/Supply idle BLUSDC to Blend — no new borrowing/)).toBeTruthy();
    expect(screen.getByText(/Lend idle BLUSDC to Earn — no new borrowing/)).toBeTruthy();
    for (const idle of candidates.feasible.filter((c) => !c.borrows)) {
      expect(screen.getByText(`${Number(idle.supplyApyPct).toFixed(2)}% APY`)).toBeTruthy();
    }
    expect(screen.queryByText(/% APR$/)).toBeNull();
    expect(screen.getAllByText("$680.00")).toHaveLength(2);
    // Two idle options leave health untouched; the levered third is the only one with a figure.
    expect(screen.getAllByText("Health factor after").map((dt) => dt.nextElementSibling?.textContent)).toEqual(["unchanged", "unchanged", "1.30"]);
  });

  it("renders only the no-debt option when the user forbade borrowing", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30", borrowingAllowed: false,
      idleWalletUsd: "680", idleWalletByAssetUsd: { BLUSDC: "680" }, comparisons: [comparison()],
    });
    card(view({ candidates }));

    expect(screen.getByText(/Supply idle BLUSDC to Blend — no new borrowing/)).toBeTruthy();
    // "Do not borrow" must not surface a borrow shape at all — not even ruled out, which
    // still reads as a suggestion the user already declined.
    expect(screen.queryByText(/net AP[RY]/)).toBeNull();
    expect(screen.queryByText(/Ruled out/)).toBeNull();
  });

  it("ranks the better carry first in the DOM, not merely in the array", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30", idleWalletUsd: null,
      comparisons: [
        comparison({ asset: "BLUSDC", blendSupplyApr: "6", marginBorrowApr: "4", evidenceIds: ["e1"] }),
        comparison({ asset: "XLM", blendSupplyApr: "20", marginBorrowApr: "4", evidenceIds: ["e2"] }),
      ],
    });
    const { container } = card(view({ candidates }));

    const order = [...container.querySelectorAll("p")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.includes("net APY"));
    // The better carry (XLM, +16 points of APR) renders first; each figure is its candidate's APY.
    expect(candidates.feasible.map((c) => c.asset)).toEqual(["XLM", "BLUSDC"]);
    expect(order).toEqual(candidates.feasible.map((c) => `+${Number(c.netApyPct).toFixed(2)}% net APY`));
  });

  it("omits the block entirely when no floor was stated, rather than showing an empty heading", () => {
    card(view({ candidates: null }));
    expect(screen.queryByText("Options")).toBeNull();
  });

  it("keeps the investigation visible while a journal plan is loading", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    });
    render(
      <InvestigationCard
        prompt={view().originalRequest}
        result={view({ candidates, capacity: {
          floor: "1.30", grossCollateralUsd: "317.00", debtUsd: "217.12",
          healthFactor: "1.46", maxBorrowUsd: "115.81",
        } })}
        progress={null}
        loading={false}
        error={null}
        workflowLoading
        workflow={{
          id: "11111111-1111-1111-1111-111111111111",
          revision: 1,
          digest: "a".repeat(64),
          status: "running",
          objective: "Borrow BLUSDC to Blend",
          expiresAt: Date.now() + 60_000,
          assumptions: [],
          constraints: [],
          slippageAccepted: false,
          message: "Preparing step 1.",
          steps: [{
            id: "one", op: "borrow", asset: "BLUSDC", amount: "115.81",
            label: "Borrow BLUSDC", status: "invoking",
          }],
        }}
      />,
    );
    // The chosen plan has become its execution card: the set of plans is gone (owner layout).
    expect(screen.queryByRole("region", { name: /^Plans?$/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Running" })).toBeTruthy();
  });

  it("offers Approve and run on a proposed plan, and Sign in wallet when an XDR is waiting", () => {
    const onApprove = vi.fn();
    const onSign = vi.fn();
    const proposed = {
      id: "11111111-1111-1111-1111-111111111111",
      revision: 1,
      digest: "a".repeat(64),
      status: "proposed" as const,
      objective: "Borrow BLUSDC to Blend",
      expiresAt: Date.now() + 60_000,
      assumptions: [],
      constraints: [],
      slippageAccepted: false,
      message: "Review the amounts and steps before approving.",
      steps: [{
        id: "one", op: "borrow" as const, asset: "BLUSDC", amount: "115.81",
        label: "Borrow BLUSDC", status: "pending" as const,
      }],
    };
    const { rerender } = render(
      <InvestigationCard
        prompt={view().originalRequest}
        result={view()}
        progress={null}
        loading={false}
        error={null}
        workflow={proposed}
        onApprove={onApprove}
        onSign={onSign}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    rerender(
      <InvestigationCard
        prompt={view().originalRequest}
        result={view()}
        progress={null}
        loading={false}
        error={null}
        workflow={{
          ...proposed,
          status: "awaiting_signature",
          message: "Approve the transaction in your wallet to continue.",
          steps: [{
            ...proposed.steps[0],
            status: "awaiting_signature",
            unsignedXdr: "A".repeat(80),
          }],
        }}
        onApprove={onApprove}
        onSign={onSign}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in wallet" }));
    expect(onSign).toHaveBeenCalledTimes(1);
  });

  it("renders the live investigation progress instead of a bare spinner", () => {
    render(
      <InvestigationCard
        prompt="can I withdraw 100 XLM without getting liquidated?"
        result={null}
        progress={{ kind: "reading", capability: "can_withdraw", label: "can withdraw" }}
        loading
        error={null}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Reading can withdraw/);
  });

  it("gives each plan its own Approve when a runner-up decided the ranking", () => {
    const onPropose = vi.fn();
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30", borrowingAllowed: false,
      idleWalletUsd: "77665",
      idleWalletByAssetUsd: { SOUSDC: "74985", AQUSDC: "2680" },
      idleWalletByAssetTokens: { SOUSDC: "74985", AQUSDC: "2680" },
      comparisons: [
        comparison({
          asset: "SOUSDC", earnSupplyApr: "4.2", blendSupplyApr: null,
          marginBorrowApr: null, spreadApr: null, verdict: "earn_only",
        }),
        comparison({
          asset: "AQUSDC", earnSupplyApr: "4.5", blendSupplyApr: null,
          marginBorrowApr: null, spreadApr: null, verdict: "earn_only",
        }),
      ],
    });
    render(
      <InvestigationCard
        prompt="supply my USDC"
        result={view({ candidates })}
        progress={null}
        loading={false}
        error={null}
        onPropose={onPropose}
      />,
    );
    expect(screen.getByText(/Using SOUSDC/)).toBeTruthy();
    expect(screen.getByText("Plan A")).toBeTruthy();
    expect(screen.getByText("Plan B")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[1]);
    expect(onPropose).toHaveBeenCalledWith(candidateId("lend_idle", "AQUSDC"));
  });

  it("shows the server-measured duration on a finished investigation", () => {
    card(view({ elapsedMs: 12_400, message: "Your reported health factor is 3.90." }));
    expect(screen.getByText(/Checked in 12s/)).toBeTruthy();
  });
});

describe("investigation card / historical receipts", () => {
  it("keeps a settled transaction hash and explorer link visible outside collapsed prose", () => {
    const hash = "ab".repeat(32);
    const current = view({ message: "Your health factor is 3.20." });
    render(
      <InvestigationCard
        prompt="what is my health factor?"
        result={current}
        progress={null}
        loading={false}
        error={null}
        turns={[
          { role: "user", text: "swap 10 XLM" },
          { role: "assistant", text: "The swap settled.", executionReceipt: {
            workflowId: "wf-1", status: "completed", network: "testnet",
            steps: [{ operation: "swap", asset: "XLM", amount: "10", status: "settled", txHash: hash, settledLedger: 42 }],
          } },
          { role: "user", text: "what is my health factor?" },
          { role: "assistant", text: current.message },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: new RegExp(hash) });
    expect(link.getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.getByText(/Ledger 42/)).toBeTruthy();
  });
});

describe("investigation card / in-flight state", () => {
  it("says what is happening between a click and its result", () => {
    const result = view();
    const { rerender } = render(
      <InvestigationCard prompt={result.originalRequest} result={result} progress={null} loading={false} error={null} onPropose={() => {}} workflowLoading workflow={null} />,
    );
    expect(screen.getByTestId("workflow-progress").textContent).toMatch(/Preparing the plan/);
    rerender(
      <InvestigationCard prompt={result.originalRequest} result={result} progress={null} loading={false} error={null} onPropose={() => {}} workflowLoading
        workflow={{ id: "w", revision: 1, digest: "d", status: "proposed", objective: "o", expiresAt: 0, assumptions: [], constraints: [], slippageAccepted: false, message: "m", steps: [] }} />,
    );
    expect(screen.getByTestId("workflow-progress").textContent).toMatch(/Checking funds, prices and projected health/);
  });
});

describe("investigation card / plan health factor before and after", () => {
  const baseCandidate = (over: Partial<Candidate> = {}): Candidate => ({
    id: "plan-1",
    kind: "borrow_supply",
    label: "Borrow BLUSDC and supply to Blend",
    borrows: true,
    asset: "BLUSDC",
    venue: "blend",
    netAprPct: "6.00",
    supplyAprPct: "10.00",
    legs: [],
    finalHealthFactor: "2.02",
    amountUsd: "5000",
    evidenceIds: [],
    amountBasis: "stated",
    ...over,
  });

  it("renders '1.80 → 2.02' for a candidate with before and after", () => {
    const candidate = baseCandidate({ initialHealthFactor: "1.80", finalHealthFactor: "2.02" });
    card(view({ candidates: { feasible: [candidate], rejected: [] } }));
    expect(screen.getByText("Health factor")).toBeTruthy();
    expect(screen.getByText("1.80 → 2.02")).toBeTruthy();
  });

  it("renders 'No debt after' when candidate repays all debt", () => {
    const candidate = baseCandidate({ repaysAllDebt: true, finalHealthFactor: null });
    card(view({ candidates: { feasible: [candidate], rejected: [] } }));
    expect(screen.getByText("Health factor after")).toBeTruthy();
    expect(screen.getByText("No debt after")).toBeTruthy();
  });

  it("keeps 'after' only when candidate has no before figure", () => {
    const candidate = baseCandidate({ finalHealthFactor: "2.02" });
    card(view({ candidates: { feasible: [candidate], rejected: [] }, capacity: null }));
    expect(screen.getByText("Health factor after")).toBeTruthy();
    expect(screen.getByText("2.02")).toBeTruthy();
  });

  it("uses result.capacity.healthFactor as before when candidate does not carry it directly", () => {
    const candidate = baseCandidate({ finalHealthFactor: "2.02" });
    card(view({
      candidates: { feasible: [candidate], rejected: [] },
      capacity: {
        floor: "1.30",
        grossCollateralUsd: "4000",
        debtUsd: "2222.22",
        healthFactor: "1.80",
        maxBorrowUsd: "1000",
      },
    }));
    expect(screen.getByText("Health factor")).toBeTruthy();
    expect(screen.getByText("1.80 → 2.02")).toBeTruthy();
  });
});
