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

    expect(screen.getByText("Execution Progress")).toBeTruthy();
    expect(screen.getByText("Autonomous (Privy Session)")).toBeTruthy();
    expect(screen.getByText("Deposit 1,000 USDC Collateral")).toBeTruthy();
    expect(screen.getByText("Borrow 500 XLM")).toBeTruthy();
    expect(screen.getByText("Supply to Blend")).toBeTruthy();
    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.getByText("Signing…")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText(/tx 8a92b1c4…/)).toBeTruthy();
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
  });
});
