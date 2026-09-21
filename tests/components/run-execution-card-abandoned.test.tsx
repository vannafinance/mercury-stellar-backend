// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunExecutionCard, type RunLeg } from "@/components/copilot/run-execution-card";

/**
 * A run that was called off before anything settled.
 *
 * Live, 21 Sep, on "park 20 XLM then farm 10 BLUSDC at 2×": all four legs came back
 * `skipped`, nothing settled, and the card announced **"Ready on leg 4 of 4"** with
 * "Supply 9.999 BLUSDC to Blend" underneath — offering to continue into a leg three
 * steps past where the run actually stopped, while the prose above it correctly said
 * "Stopped at 'Lend 20 XLM on Earn' — later steps were not run."
 *
 * Two separate causes, both pinned here:
 *
 *   1. `focus` fell back to `total - 1` whenever every leg was terminal. The last leg is
 *      the furthest one NOBODY reached; the first unsettled leg is where it stopped.
 *   2. `skipped` is terminal but is neither `stopped` nor `failed`, so every branch of
 *      the narration missed and it fell through to the "ready" default.
 */

const leg = (n: number, label: string, status: RunLeg["status"]): RunLeg => ({
  n,
  venue: n === 1 ? "earn" : n === 4 ? "farm" : "margin",
  op: n === 1 ? "lend" : n === 4 ? "supply_to_blend" : "borrow",
  label,
  amount: null,
  asset: null,
  status,
});

/** The card as the workspace mounts it, with only the legs varying per case. */
const renderCard = (legs: RunLeg[]) =>
  render(<RunExecutionCard legs={legs} hf={3} signerText="freighter wallet" />);

/** The screenshot, verbatim: four legs, all skipped, nothing on chain. */
const abandoned: RunLeg[] = [
  leg(1, "Lend 20 XLM on Earn", "skipped"),
  leg(2, "Deposit 10 BLUSDC as collateral", "skipped"),
  leg(3, "Borrow 10 BLUSDC", "skipped"),
  leg(4, "Supply 9.999 BLUSDC to Blend", "skipped"),
];

describe("RunExecutionCard — a run nothing ran", () => {
  it("does not claim to be ready on the last leg when every leg was skipped", () => {
    renderCard(abandoned);
    expect(screen.queryByText(/Ready on leg 4 of 4/i)).toBeNull();
    expect(screen.queryByText(/Ready on/i)).toBeNull();
  });

  it("names the leg the run actually stopped at, not the furthest one nobody reached", () => {
    renderCard(abandoned);
    expect(screen.getByText(/Stopped at leg 1 of 4/i)).toBeTruthy();
  });

  it("says the position is unchanged rather than inviting a continue", () => {
    renderCard(abandoned);
    expect(screen.getByText(/position is unchanged/i)).toBeTruthy();
  });

  it("still points at the first UNSETTLED leg when earlier legs did settle", () => {
    // Two on chain, the rest called off: the run stopped at leg 3, not leg 4.
    renderCard([
      leg(1, "Lend 20 XLM on Earn", "ok"),
      leg(2, "Deposit 10 BLUSDC as collateral", "ok"),
      leg(3, "Borrow 10 BLUSDC", "skipped"),
      leg(4, "Supply 9.999 BLUSDC to Blend", "skipped"),
    ]);
    expect(screen.getByText(/leg 3 of 4/i)).toBeTruthy();
    expect(screen.queryByText(/leg 4 of 4/i)).toBeNull();
  });

  it("leaves a genuinely complete run alone — it is not an abandoned one", () => {
    renderCard([leg(1, "Lend 20 XLM on Earn", "ok"), leg(2, "Borrow 10 BLUSDC", "ok")]);
    expect(screen.queryByText(/Stopped at/i)).toBeNull();
  });

  it("leaves a failed run to the failure branch, which names the failing leg", () => {
    renderCard([
      leg(1, "Lend 20 XLM on Earn", "ok"),
      leg(2, "Deposit 10 BLUSDC as collateral", "failed"),
      leg(3, "Borrow 10 BLUSDC", "skipped"),
    ]);
    expect(screen.getByText(/Leg 2 failed/i)).toBeTruthy();
    expect(screen.queryByText(/Stopped at leg/i)).toBeNull();
  });
});
