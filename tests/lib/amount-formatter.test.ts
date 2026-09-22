import { describe, expect, it } from "vitest";
import { formatExactDecimalAmount, formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";

describe("formatExactDecimalAmount: exponent notation is impossible at any magnitude", () => {
  it("never emits scientific notation for micro-dust (e.g. 7e-7, 1e-8, 1e-15)", () => {
    expect(formatExactDecimalAmount(7e-7)).toBe("0.0000007");
    expect(formatExactDecimalAmount(1e-7)).toBe("0.0000001");
    // Beyond 7 decimals rounds to 0 under maxDecimals = 7
    expect(formatExactDecimalAmount(1e-8)).toBe("0");
    expect(formatExactDecimalAmount(1e-15)).toBe("0");
    expect(formatExactDecimalAmount(0.00000004)).toBe("0");
    expect(formatExactDecimalAmount(0.00000007)).toBe("0.0000001");
  });

  it("never emits scientific notation for huge numbers (e.g. 1e21, 1e25)", () => {
    const huge1 = formatExactDecimalAmount(1e21);
    expect(huge1).not.toMatch(/[eE]/);
    expect(huge1).toBe("1000000000000000000000");

    const huge2 = formatExactDecimalAmount(1e25);
    expect(huge2).not.toMatch(/[eE]/);
    expect(huge2).toBe("10000000000000000000000000");
  });

  it("handles normal DeFi amounts and trims trailing zeros", () => {
    expect(formatExactDecimalAmount(5.004361)).toBe("5.004361");
    expect(formatExactDecimalAmount(0.0002671)).toBe("0.0002671");
    expect(formatExactDecimalAmount(10.5)).toBe("10.5");
    expect(formatExactDecimalAmount(100)).toBe("100");
    expect(formatExactDecimalAmount(0)).toBe("0");
    expect(formatExactDecimalAmount(-0)).toBe("0");
  });

  it("proves on an un-enumerated non-standard magnitude", () => {
    const oddVal = 3.1415926535e-6; // 0.0000031415926535
    const formatted = formatExactDecimalAmount(oddVal);
    expect(formatted).not.toMatch(/[eE]/);
    expect(formatted).toBe("0.0000031");
  });
});
