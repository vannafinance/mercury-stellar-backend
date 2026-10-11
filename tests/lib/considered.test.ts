import { describe, expect, it } from "vitest";
import { consideredAlongside, consideredSentence, walletSpendable } from "@/lib/copilot/investigation/considered";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";
import type { ResearchFact } from "@/lib/copilot/investigation/view";

const wallet = (symbol: string, kind: "balance" | "spendable", value: string): ResearchFact =>
  ({ id: `${symbol}:${kind}`, label: `${symbol} wallet ${kind}`, value, unit: symbol, venue: "wallet", evidenceId: "e1", sourcePath: kind, readAt: 0 });
const rate = (asset: string, earn: string | null, blend: string | null = null): RateComparison =>
  ({ asset, earnSupplyApr: earn, blendSupplyApr: blend, marginBorrowApr: null, spreadApr: null, verdict: "earn_only", evidenceIds: ["e2"] }) as RateComparison;

/** 7 Oct: the plan lent BLUSDC; the wallet also held AQUSDC and SOUSDC, and the answer said nothing about them. */
describe("what else was compared for the same job", () => {
  const facts = [
    wallet("BLUSDC", "spendable", "675"), wallet("AQUSDC", "spendable", "94.06"), wallet("SOUSDC", "spendable", "24947"), wallet("XLM", "spendable", "1496"),
  ];
  const comparisons = [rate("BLUSDC", "19.25"), rate("AQUSDC", "18.11"), rate("SOUSDC", "0.28"), rate("XLM", "2.79", "180.58")];

  it("names the other held tokens priced as the same dollar, with the rate each pays", () => {
    const considered = consideredAlongside([{ op: "lend", asset: "BLUSDC" }], comparisons, facts);
    expect(considered.map((token) => [token.asset, token.apy, token.leadApy, token.venue])).toEqual([["AQUSDC", "18.11", "19.25", "Earn"], ["SOUSDC", "0.28", "19.25", "Earn"]]);
    expect(consideredSentence(considered)).toBe(" I also compared your other Earn options for the same dollar: AQUSDC 18.11%, SOUSDC 0.28% against 19.25% for BLUSDC, which pays the most of them.");
  });

  it("leaves out a token the wallet does not hold, and one with no pool or no rate read", () => {
    const thin = [wallet("BLUSDC", "spendable", "675"), wallet("AQUSDC", "spendable", "0"), wallet("SOUSDC", "spendable", "50")];
    expect(consideredAlongside([{ op: "lend", asset: "BLUSDC" }], comparisons, thin).map((token) => token.asset)).toEqual(["SOUSDC"]);
    expect(consideredAlongside([{ op: "lend", asset: "BLUSDC" }], [rate("BLUSDC", "19.25")], facts)).toEqual([]);
  });

  it("says nothing for a token with no same-priced sibling, or a step that earns no rate", () => {
    expect(consideredAlongside([{ op: "lend", asset: "XLM" }], comparisons, facts)).toEqual([]);
    expect(consideredAlongside([{ op: "deposit_collateral", asset: "BLUSDC" }], comparisons, facts)).toEqual([]);
    expect(consideredSentence([])).toBe("");
  });

  it("does not claim the lead pays the most when another token pays more", () => {
    const higher = consideredAlongside([{ op: "lend", asset: "AQUSDC" }], comparisons, facts);
    expect(consideredSentence(higher)).not.toMatch(/pays the most/);
  });

  it("reads spendable over balance from the wallet rows", () => {
    expect(walletSpendable([wallet("XLM", "balance", "10"), wallet("XLM", "spendable", "9.5")]).get("XLM")).toBe(9.5);
  });
});

describe("a token the plan itself uses is not compared against itself", () => {
  it("leaves out every token the plan puts on the same rate", () => {
    const comparisons = [
      { asset: "BLUSDC", earnSupplyApr: "19.25" },
      { asset: "AQUSDC", earnSupplyApr: "18.11" },
      { asset: "SOUSDC", earnSupplyApr: "0.28" },
    ] as never;
    const facts = [
      { id: "w1", label: "BLUSDC wallet spendable", value: "675", unit: "", venue: "wallet", evidenceId: "e", sourcePath: "p", readAt: 0 },
      { id: "w2", label: "AQUSDC wallet spendable", value: "885", unit: "", venue: "wallet", evidenceId: "e", sourcePath: "p", readAt: 0 },
      { id: "w3", label: "SOUSDC wallet spendable", value: "24948", unit: "", venue: "wallet", evidenceId: "e", sourcePath: "p", readAt: 0 },
    ] as never;
    const out = consideredAlongside([{ op: "lend", asset: "BLUSDC" }, { op: "lend", asset: "AQUSDC" }], comparisons, facts);
    expect(out.map((token) => token.asset)).toEqual(["SOUSDC"]);
  });
});
