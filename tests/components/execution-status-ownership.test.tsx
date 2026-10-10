// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationCard } from "@/components/copilot/investigation-card";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
afterEach(cleanup);
const view = (message: string): WorkflowView => ({ id: "run", revision: 1, digest: "d", status: "awaiting_signature", objective: "Deposit", message, expiresAt: 0, assumptions: [], constraints: [], slippageAccepted: false,
  steps: [{ id: "step", label: "Deposit", op: "deposit_collateral", asset: "XLM", amount: "1", status: "awaiting_signature" }] });
describe("the execution card owns execution status", () => {
  it.each(["FULL unsigned envelope is in unsigned_xdr. Enable tool signing.", "An unrelated future transport diagnostic."])("excludes arbitrary tool prose without matching its words: %s", (message) => {
    const sign = vi.fn();
    render(<InvestigationCard prompt="Deposit" result={null} progress={null} loading={false} error={null} workflow={view(message)} onSign={sign} />);
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByText("Your signature needed")).toBeTruthy();
    expect(screen.queryByTestId("workflow-progress")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in wallet" }));
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("does not repeat signing/submission status under prose while keeping the card's status", () => {
    const w = view("Internal RPC instruction");
    const { rerender } = render(<InvestigationCard prompt="Deposit" result={null} progress={null} loading={false} error={null} workflow={w} workflowLoading onSign={() => {}} />);
    expect(screen.queryByTestId("workflow-progress")).toBeNull();
    expect((screen.getByRole("button", { name: "Sign in wallet" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<InvestigationCard prompt="Deposit" result={null} progress={null} loading={false} error={null} workflow={{ ...w, status: "running", steps: [{ ...w.steps[0], status: "submitted" }] }} workflowLoading />);
    expect(screen.queryByTestId("workflow-progress")).toBeNull();
    expect(screen.getByText("Waiting for the ledger to close…")).toBeTruthy();
    expect(screen.queryByText(w.message)).toBeNull();
  });
});
