import { describe, expect, it } from "vitest";
import { RESEARCH_SYSTEM } from "@/lib/copilot/investigation/flash";
import { allAssets, isSupportedAsset } from "@/lib/copilot/registry/assets";

/**
 * 24 Oct, negative test N5: "Lend 100 ETH" was answered "The supported assets are XLM, BLUSDC, AQUSDC, SOUSDC, AQUA, EURC,
 * and USDT". The registry says AQUA, EURC and USDT sit on no venue (no collateral, no Earn pool, no Blend, no LP) and are
 * NOT supported; they are only NAMEABLE, so the model can recognise and refuse them. The model was handed the nameable
 * list and called it the supported one. The prompt now says which names are recognised but unsupported, from the same
 * registry data `isSupportedAsset` uses (never a hand-written list), and that only the venue table's assets are on offer.
 */
describe("the research prompt separates what is supported from what is only recognised", () => {
  const unsupported = allAssets().filter((def) => !isSupportedAsset(def)).map((def) => def.id);

  it("has a registry with unsupported names to guard against (so this test cannot pass vacuously)", () => {
    expect(unsupported.length).toBeGreaterThan(0);
  });

  it("names every recognised-but-unsupported asset as unsupported", () => {
    const sentence = RESEARCH_SYSTEM.split("\n").find((line) => /recogni[sz]ed but not supported/i.test(line)) ?? "";
    for (const id of unsupported) expect(sentence, id).toContain(id);
  });

  it("says only the assets a venue takes may be offered or listed as available", () => {
    expect(RESEARCH_SYSTEM).toMatch(/only (the )?assets? (a|the) venue takes/i);
  });

  it("never lists a supported asset as unsupported", () => {
    const sentence = RESEARCH_SYSTEM.split("\n").find((line) => /recogni[sz]ed but not supported/i.test(line)) ?? "";
    for (const def of allAssets().filter(isSupportedAsset)) expect(sentence, def.id).not.toMatch(new RegExp(`\b${def.id}\b`));
  });
});

/**
 * 24 Oct, N6: "Borrow some stablecoins and farm them" sometimes sized the borrow to the floor on its own (and the reply then asked
 * for a floor), and sometimes asked the right thing - which stablecoin, how much, where to farm. A borrow the user gave no amount,
 * multiple or maximum for is incomplete; the model is told to ask for what is missing.
 */
describe("the research prompt tells the model what to do with a borrow that has no size", () => {
  it("asks for the missing items, and keeps floor sizing for an explicit maximum", () => {
    const rule = RESEARCH_SYSTEM.split("\n").find((line) => /no stated amount, multiple or maximum/i.test(line)) ?? "";
    expect(rule).toMatch(/openQuestions/);
    expect(rule).toMatch(/which asset/i);
    expect(rule).toMatch(/how much/i);
    expect(rule).toMatch(/to_floor/);
  });
});
