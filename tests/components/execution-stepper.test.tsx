// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExecutionStepper } from "@/components/copilot/execution-stepper";

describe("ExecutionStepper", () => {
  it("renders multi-leg execution statuses accurately", () => {
    render(
      <ExecutionStepper
        currentStepIndex={1}
        autoApprove={true}
        steps={[
          {
            id: "step-1",
            op: "deposit_collateral",
            label: "Deposit 1,000 USDC Collateral",
            asset: "USDC",
            amount: "1000",
            status: "settled",
            txHash: "8a92b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
            ledger: 142981,
          },
          {
            id: "step-2",
            op: "borrow",
            label: "Borrow 500 XLM",
            asset: "XLM",
            amount: "500",
            status: "signing",
          },
          {
            id: "step-3",
            op: "supply_blend",
            label: "Supply to Blend",
            asset: "XLM",
            amount: "500",
            status: "pending",
          },
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: /execution progress/i })).toBeTruthy();
    expect(screen.getByText("Executing")).toBeTruthy();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.getByText("Signed within your auto-approve limits.")).toBeTruthy();
    expect(screen.getByText("Deposit 1,000 USDC Collateral")).toBeTruthy();
    expect(screen.getByText("Borrow 500 XLM")).toBeTruthy();
    expect(screen.getByText("Supply to Blend")).toBeTruthy();
    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.getByText("Signing…")).toBeTruthy();
    expect(screen.getByText("Next")).toBeTruthy();
    expect(screen.getByText(/8a92b1…1a2/)).toBeTruthy();
    expect(screen.getByText("Ledger 142,981")).toBeTruthy();
  });

  it("handles retry for failed step", () => {
    const onRetry = vi.fn();
    render(
      <ExecutionStepper
        currentStepIndex={0}
        steps={[
          {
            id: "step-1",
            op: "borrow",
            label: "Borrow 500 XLM",
            asset: "XLM",
            amount: "500",
            status: "failed",
            error: "Transaction expired",
          },
        ]}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/Transaction expired/)).toBeTruthy();
    const retryBtn = screen.getByText("Retry");
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledWith(0);
    expect(screen.getByText("Stopped at step 1")).toBeTruthy();
    expect(screen.getByText("0 of 1 went through")).toBeTruthy();
  });

  const two = (first: "settled" | "signing", second: "pending" | "settled") => [
    { id: "a", op: "deposit_collateral", label: "Deposit 100 XLM", asset: "XLM", amount: "100", status: first },
    { id: "b", op: "borrow", label: "Borrow 20 BLUSDC", asset: "BLUSDC", amount: "20", status: second },
  ] as const;

  it("puts Sign on the waiting step when auto-approve is off, and says nothing is sent without it", () => {
    const onSign = vi.fn();
    render(<ExecutionStepper currentStepIndex={0} steps={[...two("signing", "pending")]} onSign={onSign} onStop={() => {}} />);
    expect(screen.getByText("Your signature needed")).toBeTruthy();
    fireEvent.click(screen.getByText("Sign in wallet"));
    expect(onSign).toHaveBeenCalled();
    expect(screen.getByText("Nothing is sent without your signature.")).toBeTruthy();
    expect(screen.getByText("Cancel remaining steps")).toBeTruthy();
  });

  it("shows Completed and no stop button once every step settled", () => {
    render(<ExecutionStepper currentStepIndex={1} autoApprove steps={[...two("settled", "settled")]} onStop={() => {}} />);
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.queryByText("Stop after this step")).toBeNull();
  });

  it("halts on a step whose outcome is unknown, offers no Retry, and points to the explorer", () => {
    const onRetry = vi.fn();
    render(
      <ExecutionStepper
        currentStepIndex={0}
        onRetry={onRetry}
        onStop={() => {}}
        steps={[{ id: "u", op: "lend", label: "Lend 5 XLM", asset: "XLM", amount: "5", status: "uncertain", txHash: "cd".repeat(32) }]}
      />,
    );
    expect(screen.getByText("Check step 1")).toBeTruthy();
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
    expect(screen.getByText(/Check it on the explorer/)).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
    expect(screen.queryByText("Cancel remaining steps")).toBeNull();
  });
});
