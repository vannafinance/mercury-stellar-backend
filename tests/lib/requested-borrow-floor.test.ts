import { describe, expect, it } from "vitest";
import { requestedBorrowFrom, statedBorrowFrom } from "@/lib/copilot/investigation/candidates";

const leg = (amount: string, sourceQuote: string) => ({ op: "borrow", asset: "USDC", sizing: { kind: "literal", amount, sourceQuote } });

describe("a number given as a health-factor floor is never a borrow size", () => {
  it("drops a literal whose quote is only the floor the model reported", () => {
    // "How much more USDC can I borrow before my health factor drops to 1.5?" read 1.5 as a 1.5 USDC borrow.
    expect(statedBorrowFrom([leg("1.5", "1.5")], "health factor drops to 1.5")).toBeNull();
    expect(statedBorrowFrom([leg("1.5", "health factor drops to 1.5")], "health factor drops to 1.5")).toBeNull();
  });
  it("keeps a real size that sits beside a floor", () => {
    const quote = "Borrow 50 USDC but keep my health factor above 1.5";
    expect(statedBorrowFrom([leg("50", quote)], "health factor above 1.5")?.tokens).toBe(50);
  });
  it("is unaffected when no floor was reported", () => {
    expect(statedBorrowFrom([leg("50", "borrow 50 USDC")])?.tokens).toBe(50);
  });
  it("produces no requested borrow, so the answer is sized to the floor, not to 1.5", () => {
    expect(requestedBorrowFrom(statedBorrowFrom([leg("1.5", "1.5")], "health factor drops to 1.5"), [], Date.now())).toBeNull();
  });
});
