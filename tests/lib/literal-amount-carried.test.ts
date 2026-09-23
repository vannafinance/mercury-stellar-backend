import { describe, expect, it } from "vitest";
import { literalAmountAnchored } from "@/lib/copilot/investigation/plan";

/**
 * Live, 23 Sep: "deposit 100 XLM, borrow 20 BLUSDC and supply it to blend" was understood
 * correctly and then refused — "the amount 20 does not appear in your request" — because the
 * supply clause says "it" (no number of its own) and the request holds two amounts.
 */
const request = "deposit 100 XLM, borrow 20 BLUSDC and supply it to blend";
const leg = (op: string, asset: string, amount: string, sourceQuote: string) =>
  ({ op, asset, sizing: { kind: "literal", amount, sourceQuote } }) as any;

const deposit = leg("deposit_collateral", "XLM", "100", "deposit 100 XLM");
const borrow = leg("borrow", "BLUSDC", "20", "borrow 20 BLUSDC");
const ctx = { messages: [request] } as any;

describe("an amount carried from an earlier stated leg is anchored", () => {
  it("accepts 'supply it' at the amount the borrow leg stated", () => {
    const supply = leg("supply_blend", "BLUSDC", "20", "supply it to blend");
    const plan = { legs: [deposit, borrow, supply] } as any;
    expect(literalAmountAnchored(supply.sizing, ctx, plan, supply)).toBe(true);
  });

  it("still refuses an amount the user never wrote for that token", () => {
    const supply = leg("supply_blend", "BLUSDC", "25", "supply it to blend");
    const plan = { legs: [deposit, borrow, supply] } as any;
    expect(literalAmountAnchored(supply.sizing, ctx, plan, supply)).toBe(false);
  });

  it("does not borrow a figure stated for a DIFFERENT token", () => {
    // 100 was stated for XLM; it must not anchor a 100 BLUSDC supply.
    const supply = leg("supply_blend", "BLUSDC", "100", "supply it to blend");
    const plan = { legs: [deposit, borrow, supply] } as any;
    expect(literalAmountAnchored(supply.sizing, ctx, plan, supply)).toBe(false);
  });

  it("only looks BACKWARD — a later leg cannot anchor an earlier one", () => {
    const supply = leg("supply_blend", "BLUSDC", "20", "supply it to blend");
    const plan = { legs: [deposit, supply, borrow] } as any;
    expect(literalAmountAnchored(supply.sizing, ctx, plan, supply)).toBe(false);
  });
});
