import { describe, expect, it } from "vitest";
import { allAssets, isSupportedAsset } from "@/lib/copilot/registry/assets";
import { unsupportedAssetFacts, unsupportedOnlyReply } from "@/lib/copilot/investigation/unsupported-asset";
import { immediateReply } from "@/lib/copilot/investigation/immediate";

/**
 * 8 Oct, live, from the owner's catalogue: "lend 5 AQUA", "borrow 10 AQUA" and "provide EURC liquidity"
 * took 26 to 42 s to reach a refusal. A request that names only assets no venue takes is refused at once.
 */

describe("which assets are unsupported", () => {
  it("is what the registry's venue data says, not a list kept here", () => {
    const unsupported = allAssets().filter((def) => !isSupportedAsset(def)).map((def) => def.id).sort();
    expect(unsupported).toEqual(["AQUA", "EURC", "USDT"]);
  });
});

describe("unsupportedOnlyReply", () => {
  it.each([
    ["lend 5 AQUA", /AQUA is not supported on Vanna/],
    ["borrow 10 AQUA", /AQUA is not supported on Vanna/],
    ["provide EURC liquidity", /EURC is not supported on Vanna/],
    ["what is the price of EURC", /EURC is not supported on Vanna/],
    ["swap 10 EURC to USDT", /EURC and USDT are not supported on Vanna/],
  ])("refuses %s", (message, expected) => {
    const reply = unsupportedOnlyReply(message);
    expect(reply).toMatch(expected);
    expect(reply).toMatch(/I can work with XLM, BLUSDC, AQUSDC and SOUSDC\./);
  });

  it.each([
    "lend 50 XLM",
    "supply 10 AQUSDC to blend",
    "what is my health factor",
    "USDC pool stats",
    "prices of XLM, AQUA and EURC",
    "swap 100 XLM to EURC",
    "swap EURC to USDC",
    "send my funds to someone",
    "what is the weather",
  ])("leaves %s to the normal investigation", (message) => {
    expect(unsupportedOnlyReply(message)).toBeNull();
  });

  it("does not mistake an asset's name inside another word for the asset", () => {
    expect(unsupportedOnlyReply("lend 5 AQUARIUS_USDC")).toBeNull();
  });
});

describe("immediateReply", () => {
  it("answers a request naming only unsupported assets without a model or a read", async () => {
    const reply = await immediateReply("lend 5 AQUA");
    expect(reply?.message).toMatch(/AQUA is not supported on Vanna/);
  });
});

describe('unsupportedAssetFacts', () => {
  it('states each unsupported asset a message names beside supported ones', () => {
    const facts = unsupportedAssetFacts('prices of XLM, AQUA and EURC');
    expect(facts.map((fact) => [fact.label, fact.value])).toEqual([['AQUA', 'not supported on Vanna'], ['EURC', 'not supported on Vanna']]);
  });
  it('says nothing when every named asset is supported or none is named', () => {
    expect(unsupportedAssetFacts('price of XLM and AQUSDC')).toEqual([]);
    expect(unsupportedAssetFacts('what is my health factor')).toEqual([]);
  });
});
