import { describe, expect, it } from "vitest";
import { readsForPlans } from "@/lib/copilot/investigation/strategy-reads";
import type { ProposedPlan } from "@/lib/copilot/investigation/types";

/**
 * 24 Oct, live: "deposit 5 xlm and dual borrow blusdc and sousdc at 3x leverage" and "Deposit 5 XLM, dual-borrow 0.5
 * SoUSDC and 0.5 BLUSDC ..." stopped at the plan or timed out, both on the SoUSDC max_borrow read: 34 s of probing
 * (50 on-chain checks) because that pool is deep, against 5 s for the pools whose own cap binds first. A borrow whose
 * amount is stated needs no search for the maximum - the protocol's preview says yes or no for that amount.
 */
const plan = (sizing: ProposedPlan["legs"][number]["sizing"]): ProposedPlan => ({
  title: "t", rationale: "r", evidenceIds: [],
  legs: [
    { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "5", sourceQuote: "deposit 5 XLM" } },
    { op: "borrow", asset: "SOUSDC", sizing },
  ],
});
const wants = (p: ProposedPlan) => readsForPlans([p], [], 1000).filter((read) => read.capability === "max_borrow");

describe("the borrow ceiling is read only for a borrow whose amount is the ceiling", () => {
  it("skips it for a stated amount", () => {
    expect(wants(plan({ kind: "literal", amount: "0.5", sourceQuote: "0.5 SoUSDC" }))).toEqual([]);
  });
  it("skips it for a leveraged amount, sized from the deposit", () => {
    expect(wants(plan({ kind: "leverage", multiple: "3", sourceQuote: "3x leverage" }))).toEqual([]);
  });
  it("still reads it for a borrow sized to the health-factor floor, where the ceiling caps the amount", () => {
    expect(wants(plan({ kind: "to_floor" }))).toEqual([{ capability: "max_borrow", args: { asset: "SOUSDC" } }]);
  });
});
