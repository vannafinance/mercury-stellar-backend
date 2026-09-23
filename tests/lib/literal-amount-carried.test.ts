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

/**
 * Live, 23 Sep: after a priced-loss refusal, the user replied "i accept the loss" and the
 * re-plan was refused — "the amount 50 does not appear in your request" — because the latest
 * turn carries no number. The deterministic extractor, reading the earlier turn on its own,
 * finds swap / XLM / 50; that independent reading is what anchors the amount.
 */
describe("a follow-up turn keeps the amounts the user already stated", () => {
  const convo = ["swap 50 XLM to AQUSDC and add it as liquidity with XLM on aquarius", "i accept the loss"];
  const ctx2 = { messages: convo } as any;

  it("anchors the swap at the 50 XLM the user typed a turn earlier", () => {
    const swap = leg("swap", "XLM", "50", "i accept the loss");
    expect(literalAmountAnchored(swap.sizing, ctx2, { legs: [swap] } as any, swap)).toBe(true);
  });

  it("still refuses an amount no turn of the conversation states", () => {
    const swap = leg("swap", "XLM", "60", "i accept the loss");
    expect(literalAmountAnchored(swap.sizing, ctx2, { legs: [swap] } as any, swap)).toBe(false);
  });

  it("does not let a figure stated for a DIFFERENT op size this leg", () => {
    // 100 was stated for a deposit; a 100 XLM swap must not borrow it.
    const ctx3 = { messages: ["deposit 100 XLM as collateral", "and swap some XLM to AQUSDC"] } as any;
    const swap = leg("swap", "XLM", "100", "and swap some XLM to AQUSDC");
    expect(literalAmountAnchored(swap.sizing, ctx3, { legs: [swap] } as any, swap)).toBe(false);
  });
});

/**
 * 23 Sep, X5 live: after "i accept the loss" the model quoted the earlier turn with a capital
 * S ("Swap 50 XLM to AQUSDC" for "swap 50 XLM…"). The user's own words state 50 for that swap,
 * read independently, so the amount stands however the quote was cased.
 */
describe("the user's own earlier words anchor the amount, whatever the model's quote", () => {
  const convo = ["swap 50 XLM to AQUSDC and add it as liquidity with XLM on aquarius,", "i accept the loss"];
  it("accepts a re-cased quote when the earlier turn states the amount", () => {
    const swap = leg("swap", "XLM", "50", "Swap 50 XLM to AQUSDC");
    expect(literalAmountAnchored(swap.sizing, { messages: convo } as any, { legs: [swap] } as any, swap)).toBe(true);
  });
  it("still refuses an amount no turn states, with an invented quote", () => {
    const swap = leg("swap", "XLM", "70", "Swap 70 XLM to AQUSDC");
    expect(literalAmountAnchored(swap.sizing, { messages: convo } as any, { legs: [swap] } as any, swap)).toBe(false);
  });
});
