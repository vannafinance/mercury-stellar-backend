import { describe, expect, it } from "vitest";
import { recommendationReason } from "@/lib/copilot/investigation/recommendation";

const plan = (rate: string, borrows = false) => borrows
  ? { borrows, netApyPct: rate, netAprPct: rate } : { borrows, supplyApyPct: rate, supplyAprPct: rate };

/** Owner, 7 Oct: a recommended plan must say why it is recommended. The reason is read off the plans' own figures. */
describe("why the first plan is recommended", () => {
  it("says nothing for a single plan", () => {
    expect(recommendationReason([plan("10")])).toBeNull();
  });

  it("names the margin when the leader pays the most", () => {
    expect(recommendationReason([plan("95.54"), plan("19.25")])).toBe("Recommended: the highest return of the plans, 95.54% against 19.25% for Plan B.");
  });

  it("adds that it takes on no debt when a plan beside it borrows", () => {
    expect(recommendationReason([plan("12"), plan("8", true)])).toBe("Recommended: the highest return of the plans, 12.00% against 8.00% for Plan B, and it adds no debt.");
  });

  it("does not claim the best rate when a borrowing plan pays more", () => {
    expect(recommendationReason([plan("6"), plan("14", true)])).toBe("Recommended because it adds no debt; Plan B pays more (14.00% against 6.00%) but borrows.");
  });

  it("points at the richest rival, whatever its letter", () => {
    expect(recommendationReason([plan("5"), plan("7", true), plan("9", true)])).toMatch(/Plan C pays more \(9\.00% against 5\.00%\)/);
  });

  it("falls back to what is known when a rate was not read", () => {
    expect(recommendationReason([{ borrows: false }, plan("8", true)])).toBe("Recommended because it adds no debt.");
    expect(recommendationReason([{ borrows: false }, { borrows: false }])).toBeNull();
  });
});
