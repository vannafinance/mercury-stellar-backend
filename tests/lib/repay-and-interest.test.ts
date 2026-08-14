import { describe, expect, it } from "vitest";

import {
  buildNetBorrowCashByToken,
  calculateAccruedBorrowInterest,
} from "@/lib/margin-position-attribution";
import { decimalAmountToWad } from "@/lib/utils/sanitize-amount";

describe("repay amount conversion", () => {
  it("preserves the manually entered seventh Stellar decimal", () => {
    expect(decimalAmountToWad("2.1234567")).toBe(BigInt("2123456700000000000"));
  });

  it("returns zero for empty in-progress input", () => {
    expect(decimalAmountToWad("")).toBe(BigInt(0));
    expect(decimalAmountToWad(".")).toBe(BigInt(0));
  });
});

describe("per-asset accrued borrow interest", () => {
  it("uses current debt + repayments - borrows for each canonical asset", () => {
    const net = buildNetBorrowCashByToken([
      { type: "borrow", asset: "BLEND_USDC", amount: "10", hash: "a" },
      { type: "repay", asset: "BLUSDC", amount: "2", hash: "b" },
      { type: "borrow", asset: "XLM", amount: "5", hash: "c" },
    ]);

    expect(net.get("BLUSDC")).toBe(8);
    expect(calculateAccruedBorrowInterest(8.75, net.get("BLUSDC"))).toBe(0.75);
    expect(calculateAccruedBorrowInterest(5.1, net.get("XLM"))).toBeCloseTo(0.1);
  });

  it("does not call the whole debt interest when borrow history is missing", () => {
    expect(calculateAccruedBorrowInterest(12, undefined)).toBeNull();
  });

  it("keeps already-paid accrued interest in the till-date total", () => {
    // Borrowed 10, repaid 11, and still owes 1 => 2 tokens accrued till date.
    expect(calculateAccruedBorrowInterest(1, -1)).toBe(2);
  });
});
