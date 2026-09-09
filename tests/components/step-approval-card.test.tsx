// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StepApprovalCard } from "@/components/copilot/step-approval-card";

describe("StepApprovalCard", () => {
  it("renders step details, tool parameters, and handles signing click", () => {
    const onSign = vi.fn();
    render(
      <StepApprovalCard
        stepIndex={1}
        totalSteps={3}
        op="deposit_collateral"
        label="Deposit 1,000 USDC into Margin Account"
        asset="USDC"
        amount="1000"
        tool="soroban.deposit_collateral"
        args={{ asset: "USDC", amount: "1000" }}
        projectedHf="∞ (No Debt)"
        onSign={onSign}
      />,
    );

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(screen.getByText("Deposit 1,000 USDC into Margin Account")).toBeTruthy();
    expect(screen.getByText("soroban.deposit_collateral")).toBeTruthy();
    expect(screen.getByText("Sign & Execute Step 1")).toBeTruthy();

    fireEvent.click(screen.getByText("Sign & Execute Step 1"));
    expect(onSign).toHaveBeenCalledTimes(1);
  });

  it("renders signing state when in-flight", () => {
    render(
      <StepApprovalCard
        stepIndex={2}
        totalSteps={3}
        op="borrow"
        label="Borrow 500 XLM"
        asset="XLM"
        amount="500"
        signing={true}
        onSign={() => {}}
      />,
    );

    expect(screen.getByText("Signing in wallet…")).toBeTruthy();
  });

  it("renders confirmed on-chain badge when settled", () => {
    render(
      <StepApprovalCard
        stepIndex={1}
        totalSteps={3}
        op="deposit_collateral"
        label="Deposit 1,000 USDC into Margin Account"
        asset="USDC"
        amount="1000"
        settled={true}
        onSign={() => {}}
      />,
    );

    expect(screen.getByText("Confirmed on-chain")).toBeTruthy();
    expect(screen.getByText("Step Complete")).toBeTruthy();
  });

  it("renders error alert if present", () => {
    render(
      <StepApprovalCard
        stepIndex={1}
        totalSteps={2}
        op="borrow"
        label="Borrow 100 USDC"
        asset="USDC"
        amount="100"
        error="Simulation failed: Insufficient headroom"
        onSign={() => {}}
      />,
    );

    expect(screen.getByText("Simulation failed: Insufficient headroom")).toBeTruthy();
  });
});
