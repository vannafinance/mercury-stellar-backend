import { describe, expect, it } from "vitest";
import { recommendationReason } from "@/lib/copilot/investigation/recommendation";

const plan = (rate: string, amountUsd: string, borrows = false) => borrows
  ? { borrows, amountUsd, netApyPct: rate, netAprPct: rate } : { borrows, amountUsd, supplyApyPct: rate, supplyAprPct: rate };

/** Owner, 7 Oct: a recommended plan must say why. The ranking orders by what a plan earns over a year, so the reason does too. */
describe("why the first plan is recommended", () => {
  it("says nothing for a single plan", () => {
    expect(recommendationReason([plan("10", "100")])).toBeNull();
  });

  it("says it earns the most, in money over a year", () => {
    expect(recommendationReason([plan("20", "1000"), plan("10", "1000")])).toBe("Recommended: earns the most over a year, about $200 against $100 for Plan B.");
  });

  it("explains a rival with the higher rate but less money to work (the 7 Oct live case)", () => {
    expect(recommendationReason([plan("95.64", "1864.70"), plan("165.69", "700")])).toBe(
      "Recommended: earns the most over a year, about $1,783 against $1,160 for Plan B (Plan B has the higher rate, 165.69%, but puts less money to work).",
    );
  });

  it("adds that it takes on no debt when a plan beside it borrows", () => {
    expect(recommendationReason([plan("12", "1000"), plan("8", "1000", true)])).toBe("Recommended: earns the most over a year, about $120 against $80 for Plan B, and it adds no debt.");
  });

  it("does not claim the most when a borrowing plan earns more", () => {
    expect(recommendationReason([plan("6", "1000"), plan("14", "1000", true)])).toBe("Recommended because it adds no debt; Plan B earns more (about $140 a year against $60) but borrows.");
  });

  it("falls back to what is known when a figure was not read, and to silence when nothing is", () => {
    expect(recommendationReason([{ borrows: false }, plan("8", "100", true)])).toBe("Recommended because it adds no debt.");
    expect(recommendationReason([{ borrows: false }, { borrows: false }])).toBeNull();
  });
});
