import { describe, expect, it } from "vitest";
import { planExecutionSummary } from "@/components/copilot/plan-approval-card";

describe("planExecutionSummary", () => {
  const plan = {
    steps: [
      {
        kind: "write" as const,
        op: "swap",
        asset: "XLM",
        amount: 10,
        leverage: null,
        label: "Swap",
        venue: "farm" as const,
      },
      {
        kind: "write" as const,
        op: "add_liquidity",
        asset: "AQUSDC",
        amount: 5,
        leverage: null,
        label: "LP",
        venue: "farm" as const,
      },
      {
        kind: "read" as const,
        op: "vanna_get_account_health",
        asset: null,
        amount: null,
        leverage: null,
        label: "Report HF",
        venue: "other" as const,
      },
    ],
    signature_count: 2,
  };

  it("explains automatic signing without counting a read as a signature", () => {
    expect(planExecutionSummary(plan, true)).toMatchObject({
      stepCount: 3,
      writeCount: 2,
      readCount: 1,
      signatureCount: 2,
      autoSignEligible: 2,
      manualPrompts: 0,
    });
  });

  it("reports manual confirmations when session signing is off", () => {
    expect(planExecutionSummary(plan, false)).toMatchObject({
      signatureCount: 2,
      autoSignEligible: 0,
      manualPrompts: 2,
    });
  });
});
