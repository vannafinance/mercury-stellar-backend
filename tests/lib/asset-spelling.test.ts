import { describe, expect, it } from "vitest";
import { correctAssetSpellings } from "@/lib/copilot/registry/assets";

/**
 * 24 Oct, live: "deposit 5 xlm and dual borrow blusdc and soudsdc at 3x leverage" (an extra d) was not read as a
 * stated write, so it never reached the direct path and ended as a plan with no button. A token one slip away from
 * exactly one asset ticker is that asset; the reply says so. Never from a list of typos: from the registry's tickers.
 */
describe("a misspelt asset ticker is read as the one it is nearest to", () => {
  it("corrects an extra letter, a missing letter and a swap, and says what it did", () => {
    const out = correctAssetSpellings("deposit 5 xlm and dual borrow blusdc and soudsdc at 3x leverage");
    expect(out.text).toBe("deposit 5 xlm and dual borrow blusdc and SOUSDC at 3x leverage");
    expect(out.corrections).toEqual([{ from: "soudsdc", to: "SOUSDC" }]);
    expect(correctAssetSpellings("borrow 5 aqusc").corrections).toEqual([]);          // too short to trust (5 letters)
    expect(correctAssetSpellings("borrow 5 aquusdc").corrections).toEqual([{ from: "aquusdc", to: "AQUSDC" }]);
    expect(correctAssetSpellings("repay 2 bluscd").corrections).toEqual([{ from: "bluscd", to: "BLUSDC" }]);
  });

  it("leaves every spelling the registry already knows untouched", () => {
    const text = "deposit 5 XLM, borrow blusdc and SoUSDC, then swap AQUSDC, blend usdc or stellar to lumens";
    expect(correctAssetSpellings(text)).toEqual({ text, corrections: [] });
  });

  it("does not turn ordinary words into assets", () => {
    const text = "show my health factor then summarise everything about stella and the liquidation price";
    expect(correctAssetSpellings(text)).toEqual({ text, corrections: [] });
  });

  it("does not guess between two assets when it cannot tell them apart", () => {
    // Two edits from one ticker and two from another is not a clear nearest.
    expect(correctAssetSpellings("borrow 5 aousdc").corrections).toEqual([]);
  });

  it("does not touch a message with no asset-like word", () => {
    expect(correctAssetSpellings("what is my health factor").corrections).toEqual([]);
  });
});
