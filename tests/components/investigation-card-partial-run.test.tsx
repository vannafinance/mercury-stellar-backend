// @vitest-environment happy-dom
/**
 * 23 Sep, X10: a five-leg run stopped at leg 5 after legs 1–4 settled, and the card's heading
 * read "Not executed". What settled is on-chain, so a stopped run says how much of it ran.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvestigationCard } from "@/components/copilot/investigation-card";

const run = (status: string, settled: number, total = 5) => ({
  id: "w1", revision: 3, digest: "d".repeat(64), status, objective: "Deposit, borrow, supply, add liquidity",
  message: "The pool's live reserves could not be refreshed.", floor: null, slippageAccepted: false,
  steps: Array.from({ length: total }, (_, i) => ({
    id: `s${i}`, op: "deposit_collateral", asset: "XLM", amount: "10", label: `Step ${i + 1}`,
    status: i < settled ? "settled" : i === settled ? "failed" : "pending",
  })),
});
const card = (workflow: ReturnType<typeof run>) => render(
  <InvestigationCard prompt="x10" result={null} progress={null} loading={false} error={null} workflow={workflow as never} />,
);

describe("the heading of a stopped run", () => {
  it("says how many steps settled when some did", () => {
    card(run("blocked", 4));
    expect(screen.getByText("Partly executed: 4 of 5 steps settled")).toBeTruthy();
    expect(screen.queryByText("Not executed")).toBeNull();
  });

  it("still says Not executed when nothing settled", () => {
    card(run("blocked", 0));
    expect(screen.getByText("Not executed")).toBeTruthy();
  });

  it("draws a completed run as the execution card alone, saying Completed", () => {
    card(run("completed", 5));
    expect(screen.getByText("Completed")).toBeTruthy();
    // No outer "Done" box around the card (owner, 24 Sep).
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("says Cancelled, and how much went through, for a cancelled run", () => {
    const cancelled = run("cancelled", 2);
    cancelled.steps[2].status = "pending";
    card(cancelled);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("2 of 5 went through")).toBeTruthy();
  });
});
