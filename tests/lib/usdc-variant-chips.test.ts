import { describe, expect, it } from "vitest";
import { usdcVariantClarifyMessage, USDC_VARIANT_OPTIONS } from "@/lib/copilot/mcp-write";

describe("USDC variant chips", () => {
  it("asks which USDC to borrow with no pick-one helper copy", () => {
    const msg = usdcVariantClarifyMessage("the borrow");
    expect(msg).toBe("Which USDC do you want to borrow?");
    expect(msg).not.toMatch(/pick one below/i);
    expect(msg).not.toMatch(/lend 10/i);
  });

  it("chips are ticker plus short venue only", () => {
    expect(USDC_VARIANT_OPTIONS.map((o) => o.label)).toEqual(["BLUSDC", "AQUSDC", "SOUSDC"]);
    expect(USDC_VARIANT_OPTIONS.map((o) => o.description)).toEqual([
      "Blend USDC",
      "Aquarius USDC",
      "Soroswap USDC",
    ]);
  });
});
