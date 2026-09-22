import { describe, expect, it, vi } from "vitest";
import { quoteDexExactOut } from "@/lib/copilot/swap-quote";

vi.mock("@/lib/aquarius-utils", () => ({
  AquariusService: {
    getSwapQuote: vi.fn(async (amountIn: number) => String((amountIn * 0.25) / (1 + amountIn / 1000))),
  },
}));

describe("exact output live venue estimate", () => {
  it("inverts a size dependent quote and rounds input upward", async () => {
    const quote = await quoteDexExactOut({ targetOut: 10, tokenIn: "XLM", tokenOut: "AQUSDC", venue: "aquarius", simulator: "GTEST" });
    expect(quote?.amountIn).toBeGreaterThan(40);
    expect(quote?.expectedOut).toBeGreaterThanOrEqual(10);
  });

  it("does not show an input for an output the pool cannot deliver", async () => {
    const quote = await quoteDexExactOut({ targetOut: 300, tokenIn: "XLM", tokenOut: "AQUSDC", venue: "aquarius", simulator: "GTEST" });
    expect(quote).toBeNull();
  });
});
