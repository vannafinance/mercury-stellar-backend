// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import { generateCandidates } from "@/lib/copilot/investigation/candidates";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";

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
      onReset={() => {}}
    />,
  );

describe("investigation card / options", () => {
  it("renders each sized candidate with its net carry and resulting health factor", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    });
    card(view({ candidates }));

    expect(screen.getByText("Options")).toBeTruthy();
    expect(screen.getByText(/Borrow BLUSDC to the 1.30 floor and supply it to Blend/)).toBeTruthy();
    expect(screen.getByText("+6.00% net APR")).toBeTruthy();
    // The full-precision $6,541.043333… reads at the precision a person uses, and the
    // projected floor is shown next to it — a size with no health consequence beside it
    // is the number that gets approved without being understood.
    expect(screen.getByText(/\$6,541\.04 · health factor 1\.30 after/)).toBeTruthy();
  });

  it("shows a ruled-out shape WITH its reason, never as a silent omission", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30", idleWalletUsd: null,
      comparisons: [comparison({ blendSupplyApr: "3", marginBorrowApr: "7", spreadApr: "-4", verdict: "cost_exceeds_supply" })],
    });
    card(view({ candidates }));

    expect(screen.getByText(/Ruled out — Borrow BLUSDC to supply to Blend/)).toBeTruthy();
    expect(screen.getByText(/loses money before any fees/)).toBeTruthy();
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
    expect(screen.getByText("25.41% APR")).toBeTruthy();
    expect(screen.getByText("10.00% APR")).toBeTruthy();
    expect(screen.getAllByText(/\$680\.00 · no change to health factor/)).toHaveLength(2);
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
    expect(screen.queryByText(/net APR/)).toBeNull();
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
      .filter((text) => text.includes("net APR"));
    expect(order).toEqual(["+16.00% net APR", "+2.00% net APR"]);
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
        onReset={() => {}}
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
          message: "Preparing step 1.",
          steps: [{
            id: "one", op: "borrow", asset: "BLUSDC", amount: "115.81",
            label: "Borrow BLUSDC", status: "invoking",
          }],
        }}
      />,
    );
    expect(screen.getByText("Options")).toBeTruthy();
    expect(screen.getByText("Execution")).toBeTruthy();
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
        onReset={() => {}}
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
        onReset={() => {}}
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
        onReset={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Reading can withdraw/);
  });

  it("shows the server-measured duration on a finished investigation", () => {
    card(view({ elapsedMs: 12_400, message: "Your reported health factor is 3.90." }));
    expect(screen.getByText(/Checked in 12s/)).toBeTruthy();
  });
});
