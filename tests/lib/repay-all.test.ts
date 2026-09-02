/**
 * Repay sizing language must match the Margin "Repay Loan" chips.
 *
 * Live failure: "Repay all my XLM debt on margin" → "How much do you want to repay?"
 * The website already fills the input when you tap 100%; the copilot must do the same.
 */

import { describe, expect, it } from "vitest";
import { findAmountFraction, REPAY_FRACTION_OPTIONS } from "@/lib/copilot/amount-intent";
import { routeMessage } from "@/lib/copilot/router";

describe("findAmountFraction — Margin chip language", () => {
  it("maps all / full / pay off / clear to 100%", () => {
    expect(findAmountFraction("Repay all my XLM debt on margin")).toBe(1);
    expect(findAmountFraction("pay off my loan")).toBe(1);
    expect(findAmountFraction("clear my XLM debt")).toBe(1);
    expect(findAmountFraction("repay the entire XLM balance")).toBe(1);
    expect(findAmountFraction("repay max XLM")).toBe(1);
  });

  it("maps percentages and halves", () => {
    expect(findAmountFraction("repay 25% of my XLM")).toBe(0.25);
    expect(findAmountFraction("repay 10% XLM debt")).toBe(0.1);
    expect(findAmountFraction("repay half my XLM")).toBe(0.5);
    expect(findAmountFraction("repay 100% of debt")).toBe(1);
  });

  it("stays null when the user only named the asset — chips belong there", () => {
    expect(findAmountFraction("repay my XLM")).toBeNull();
    expect(findAmountFraction("repay XLM on margin")).toBeNull();
  });

  it("exposes the same four rungs the Margin page shows", () => {
    expect(REPAY_FRACTION_OPTIONS.map((o) => o.fraction)).toEqual([0.1, 0.25, 0.5, 1]);
  });
});

describe("routeMessage — repay all carries fraction, not a blank amount ask", () => {
  it("Repay all my XLM debt → repay XLM with fraction 1, requires_amount false", () => {
    const r = routeMessage("Repay all my XLM debt on margin");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("repay");
    expect(r.asset).toBe("XLM");
    expect(r.amount).toBeNull();
    expect(r.fraction).toBe(1);
    expect(r.requires_amount).toBe(false);
  });

  it("repay 25% of my XLM → fraction 0.25", () => {
    const r = routeMessage("repay 25% of my XLM debt");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("repay");
    expect(r.asset).toBe("XLM");
    expect(r.fraction).toBe(0.25);
    expect(r.requires_amount).toBe(false);
  });

  it("repay my XLM (no size) → amount null, fraction null, ask with chips", () => {
    const r = routeMessage("repay my XLM");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("repay");
    expect(r.asset).toBe("XLM");
    expect(r.amount).toBeNull();
    expect(r.fraction).toBeNull();
    expect(r.requires_amount).toBe(true);
  });

  it("repay 100 XLM → explicit amount, no fraction", () => {
    const r = routeMessage("repay 100 XLM");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.amount).toBe(100);
    expect(r.asset).toBe("XLM");
    expect(r.fraction ?? null).toBeNull();
  });
});
