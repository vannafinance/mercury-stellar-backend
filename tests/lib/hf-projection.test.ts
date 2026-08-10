/**
 * "Simulate borrowing 10 BLUSDC — what happens to my health factor?" must answer with the
 * projected figure, not today's.
 *
 * Only the parser is unit-tested here: the projection itself reads a live snapshot and an
 * oracle price. What matters most is that the parser never turns an INSTRUCTION into a
 * hypothetical — "borrow 10 BLUSDC" has to keep routing to the write path.
 */
import { describe, expect, it } from "vitest";
import { liquidationPriceLine, parseHypotheticalMove as parse } from "@/lib/copilot/handle";

describe("liquidationPriceLine — the XLM price that liquidates the position", () => {
  /** 2000 XLM @ $0.16 = $320 plus $200 stables, $400 debt, HF derived so lt = 1. */
  const pos = {
    hf: 1.3,
    grossCollateralValue: 520,
    totalBorrowedValue: 400,
    collateral: [
      { symbol: "XLM", amount: "2000", usd: 320 },
      { symbol: "BLUSDC", amount: "200", usd: 200 },
    ],
  };

  it("solves for the price where HF reaches 1", () => {
    // lt = 1.3 × 400 / 520 = 1.0 ⇒ P* = (400/1 − 200)/2000 = $0.10
    const line = liquidationPriceLine(pos);
    expect(line).toMatch(/\$0\.1000/);
    // $0.10 is 37.5% below the current $0.16.
    expect(line).toMatch(/38%|37%/);
  });

  it("says so plainly when stables alone already cover the debt", () => {
    // hf must stay consistent with the pair, since the threshold is derived from it:
    // lt = 1 ⇒ hf = 520/150. P* = (150 − 200)/2000 < 0, i.e. unreachable.
    const covered = { ...pos, totalBorrowedValue: 150, hf: 520 / 150 };
    expect(liquidationPriceLine(covered)).toMatch(/no XLM price liquidates/i);
  });

  it("no debt means no liquidation price", () => {
    expect(liquidationPriceLine({ ...pos, totalBorrowedValue: 0 })).toMatch(/no debt/i);
  });

  it("all-stable collateral has no XLM liquidation price", () => {
    const stableOnly = {
      ...pos,
      collateral: [{ symbol: "BLUSDC", amount: "520", usd: 520 }],
    };
    expect(liquidationPriceLine(stableOnly)).toMatch(/all dollar stables/i);
  });
});

describe("parseHypotheticalMove — a question about a move, not the move itself", () => {
  it("reads simulate / what if / what happens", () => {
    expect(parse("simulate borrowing 10 BLUSDC — what happens to my health factor?")).toEqual({
      op: "borrow",
      asset: "BLUSDC",
      amount: 10,
    });
    expect(parse("what if I deposit 500 XLM")).toEqual({
      op: "deposit",
      asset: "XLM",
      amount: 500,
    });
    expect(parse("what happens to my HF if I repay 20 SOUSDC")).toEqual({
      op: "repay",
      asset: "SOUSDC",
      amount: 20,
    });
    expect(parse("if i withdraw 25 AQUSDC what happens")).toEqual({
      op: "withdraw",
      asset: "AQUSDC",
      amount: 25,
    });
  });

  /** The safety property: a plain instruction must NOT be read as a question. */
  it("ignores a bare instruction with no hypothetical marker", () => {
    expect(parse("borrow 10 BLUSDC")).toBeNull();
    expect(parse("deposit 500 XLM as collateral")).toBeNull();
    expect(parse("repay all my XLM")).toBeNull();
  });

  it("ignores a hypothetical with no size", () => {
    expect(parse("what if I borrow more BLUSDC")).toBeNull();
    expect(parse("simulate a deposit")).toBeNull();
  });

  it("ignores a non-positive or unparseable amount", () => {
    expect(parse("what if I borrow 0 BLUSDC")).toBeNull();
  });
});
