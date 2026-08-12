/**
 * The CONDITIONAL trigger only recognised "if", so a condition phrased with "when ...
 * hits/reaches/drops/..." rode straight through as a plain write with the condition
 * silently dropped — "when my health factor drops below 1.2 repay 10 XLM" and "when
 * XLM reaches $0.60 withdraw my collateral" both already routed to `kind: "write"`
 * and would have executed for real on the stated action with the trigger never
 * evaluated. See docs/copilot/TEST-RUN-FINDINGS.md §1 item 2.
 */
import { describe, expect, it } from "vitest";
import { detectAutomationGap } from "@/lib/copilot/conditional-guard";

describe("a 'when ... hits/reaches/drops' clause is caught, not silently dropped", () => {
  it("refuses a real write gated on 'when X drops below Y'", () => {
    const gap = detectAutomationGap("when my health factor drops below 1.2 repay 10 XLM", true);
    expect(gap?.kind).toBe("conditional");
  });

  it("refuses a real write gated on 'when X reaches $Y'", () => {
    const gap = detectAutomationGap("when XLM reaches $0.60 withdraw my collateral", true);
    expect(gap?.kind).toBe("conditional");
  });

  it("refuses a real write gated on 'when X hits $Y'", () => {
    const gap = detectAutomationGap("when XLM hits $0.50 sell everything", true);
    expect(gap?.kind).toBe("conditional");
  });

  it("still leaves a conditional READ alone — reading a value is harmless", () => {
    const gap = detectAutomationGap("if my USDC balance is above 100 show me the borrow rate", false);
    expect(gap).toBeNull();
  });

  it("still leaves a plain, unconditional write alone", () => {
    const gap = detectAutomationGap("repay 10 XLM", true);
    expect(gap).toBeNull();
  });
});
