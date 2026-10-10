/**
 * 24 Sep, owner: the finished reply says what was done and what it means now, not
 * "All 1 step completed on-chain".
 */
import { describe, expect, it } from "vitest";
import { completionReply } from "@/lib/copilot/investigation/completion";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";

const step = (op: string, label: string, status = "settled", asset = "XLM") =>
  ({ id: `s-${op}-${label.length}`, op, asset, amount: "5", label, status }) as WorkflowView["steps"][number];
const run = (steps: WorkflowView["steps"], status: WorkflowView["status"] = "completed"): WorkflowView => ({
  id: "wf", revision: 1, digest: "d", status, objective: "supply 5 XLM to blend", expiresAt: 0,
  assumptions: [], constraints: [], slippageAccepted: false, message: "", steps,
} as WorkflowView);
const xlmRates: RateComparison = {
  asset: "XLM", earnSupplyApr: "2.78", blendSupplyApr: "173.44", marginBorrowApr: "4.1", spreadApr: null,
  verdict: "positive_before_costs", evidenceIds: [],
};

describe("the finished reply", () => {
  it("says what was supplied and the rate it now earns, from the read rate", () => {
    const reply = completionReply(run([step("supply_blend", "Supply 5 XLM to Blend")]), { comparisons: [xlmRates] });
    expect(reply).toMatch(/^Done\. Supplied 5 XLM to Blend\./);
    // Blend's APR 173.44% compounded weekly, as the Farm page shows it, not the raw APR.
    expect(reply).toMatch(/It's earning about \d+\.\d{2}% APY\./);
    expect(reply).not.toMatch(/173\.44/);
    expect(reply).not.toMatch(/step completed/i);
  });

  it("uses a rate the test invented, so the figure is proven to be read", () => {
    const reply = completionReply(run([step("lend", "Lend 5 XLM to Earn")]), { comparisons: [{ ...xlmRates, earnSupplyApr: "7.31" }] });
    expect(reply).toContain("7.31% APY");
  });

  it("lists up to three steps in order, and says when no debt remains", () => {
    const reply = completionReply(run([
      step("remove_liquidity", "Remove 1.7 XLM/AQUSDC LP shares on Aquarius", "settled", "AQUSDC"),
      step("repay", "Repay 11.56 AQUSDC", "settled", "AQUSDC"),
    ]), { repaysAllDebt: true });
    expect(reply).toBe("Done. Removed 1.7 XLM/AQUSDC LP shares on Aquarius, then repaid 11.56 AQUSDC. No debt remains.");
  });

  it("names the plan instead of listing a long run", () => {
    const steps = Array.from({ length: 6 }, (_, i) => step("repay", `Repay ${i + 1} XLM`));
    expect(completionReply(run(steps), { title: "Exit Farm Positions and Repay Margin Debt" }))
      .toBe("Done. Exit Farm Positions and Repay Margin Debt: all 6 steps went through.");
  });

  it("says how far a stopped run got, and that the rest was not submitted", () => {
    const reply = completionReply(run([step("lend", "Lend 5 XLM to Earn"), step("borrow", "Borrow 20 BLUSDC", "failed", "BLUSDC")], "blocked"));
    expect(reply).toMatch(/^1 of 2 steps went through\. Lent 5 XLM to Earn\. The rest was not submitted\./);
  });

  it("gives a projected health factor only when the plan sized one", () => {
    expect(completionReply(run([step("deposit_collateral", "Deposit 5 XLM")]), { healthFactorAfter: "2.4" }))
      .toBe("Done. Deposited 5 XLM. Your health factor should now be about 2.40.");
    expect(completionReply(run([step("deposit_collateral", "Deposit 5 XLM")]))).toBe("Done. Deposited 5 XLM.");
  });

  it("stays silent while a run is still going", () => {
    expect(completionReply(run([step("lend", "Lend 5 XLM", "invoking")], "running"))).toBeNull();
  });
});
