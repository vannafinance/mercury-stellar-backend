import { describe, it, expect } from "vitest";
import { resumableLegsFromSteps } from "@/lib/copilot/multi-leg-agent";

/**
 * The observed sequence, as leg statuses after each hop:
 *
 *   plan     deposit 10 BLUSDC | borrow XLM (null) | lend XLM (null) | lend 20 XLM
 *   run 1    ok                | clarification     | skipped         | skipped
 *   answer 2 ok                | ok                | clarification   | skipped
 *   answer 3 ok                | ok                | ok              | ← must run, not stay skipped
 *
 * `skipped` here means "an earlier leg needed an amount", i.e. not yet attempted. If it is
 * treated as abandoned it never runs, which is what left the explicit 20 XLM lend stranded.
 */
const afterAnsweringLegTwo = [
  { index: 1, op: "deposit_collateral", label: "Deposit 10 BLUSDC as collateral", asset: "BLUSDC", amount: 10, status: "ok" as const, message: "settled" },
  { index: 2, op: "borrow", label: "Borrow 15 XLM", asset: "XLM", amount: 15, status: "ok" as const, message: "settled" },
  { index: 3, op: "lend", label: "Lend XLM on Earn", asset: "XLM", amount: null, status: "clarification" as const, message: "How much?" },
  { index: 4, op: "lend", label: "Lend 20 XLM on Earn", asset: "XLM", amount: 20, status: "skipped" as const, message: "Skipped — earlier leg needs amount" },
];

describe("a skipped leg is outstanding, not abandoned", () => {
  it("offers both the paused leg and the one behind it", () => {
    const legs = resumableLegsFromSteps(afterAnsweringLegTwo);
    expect(legs.map((l) => l.op)).toEqual(["lend", "lend"]);
    // The amount-less leg survives the filter (that was the earlier fix)...
    expect(legs[0].amount).toBeNull();
    // ...and so does the explicit 20 XLM lend that was only ever skipped.
    expect(legs[1].amount).toBe(20);
  });

  it("never offers a settled leg", () => {
    const legs = resumableLegsFromSteps(afterAnsweringLegTwo);
    expect(legs.some((l) => l.op === "deposit_collateral")).toBe(false);
    expect(legs.some((l) => l.amount === 15)).toBe(false);
  });

  it("carries leverage so a levered leg cannot resume unlevered", () => {
    const legs = resumableLegsFromSteps([
      { index: 1, op: "deposit_collateral", label: "Deposit 10 BLUSDC", asset: "BLUSDC", amount: 10, status: "ok" as const, message: "" },
      { index: 2, op: "deploy_to_blend", label: "Supply 10 BLUSDC into Blend at 2× leverage", asset: "BLUSDC", amount: 10, leverage: 2, status: "skipped" as const, message: "" },
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0].leverage).toBe(2);
  });
});
