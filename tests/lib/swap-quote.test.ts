import { describe, expect, it, vi } from "vitest";
import { dexWireSymbol, liveUsdLabel, quoteDexSwap, swapFillRateLabel } from "@/lib/copilot/swap-quote";

vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    getSwapQuote: vi.fn().mockResolvedValue("28.3500000"),
  },
}));

describe("DEX swap quotes match Trade/Spot (router, not oracle)", () => {
  it("maps AQUSDC/SOUSDC onto the DEX USDC wire symbol", () => {
    expect(dexWireSymbol("XLM")).toBe("XLM");
    expect(dexWireSymbol("SOUSDC")).toBe("USDC");
    expect(dexWireSymbol("AQUSDC")).toBe("USDC");
    expect(dexWireSymbol("BLUSDC")).toBeNull();
  });

  it("quotes 100 XLM → SOUSDC from the Soroswap router, not a reserve ratio", async () => {
    const q = await quoteDexSwap({
      amountIn: 100,
      tokenIn: "XLM",
      tokenOut: "SOUSDC",
      venue: "soroswap",
      simulator: "GTEST",
    });
    expect(q?.expected).toBe(28.35);
    expect(q?.rate).toBeCloseTo(0.2835, 6);
  });

  it("formats the live 1-in → out rate for Aquarius and Soroswap fills", () => {
    expect(swapFillRateLabel(100, 26.1694, "XLM", "SOUSDC")).toBe("1 XLM ≈ 0.261694 SOUSDC");
    expect(swapFillRateLabel(10, 0.142, "XLM", "AQUSDC")).toBe("1 XLM ≈ 0.0142 AQUSDC");
    expect(swapFillRateLabel(0, 1, "XLM", "SOUSDC")).toBeNull();
  });

  it("formats Farm-style live USD next to the tx hash", () => {
    expect(liveUsdLabel(30, "BLUSDC", 1.000333)).toBe("30 BLUSDC ≈ $30.01");
    expect(liveUsdLabel(0, "BLUSDC", 1)).toBeNull();
  });
});
