import { describe, expect, it } from "vitest";
import { answerToText } from "@/lib/copilot/answer-schema";
import { earnPoolRateLine, earnPoolStructuredAnswer } from "@/lib/copilot/earn-pool-copy";

const USDC = [
  {
    symbol: "BLUSDC",
    supply_apy_pct: 17.88,
    borrow_apr_pct: 25.02,
    utilization_pct: 71.48,
    total_assets_human: 10906.4888,
    total_liquidity_human: 3110.6778,
  },
  {
    symbol: "AQUSDC",
    supply_apy_pct: 9.74,
    borrow_apr_pct: 18.46,
    utilization_pct: 52.75,
    total_assets_human: 7419.4239,
    total_liquidity_human: 3506.0002,
  },
  {
    symbol: "SOUSDC",
    supply_apy_pct: 0.17,
    borrow_apr_pct: 2.43,
    utilization_pct: 6.95,
    total_assets_human: 21204.3687,
    total_liquidity_human: 19730.9606,
  },
];

describe("USDC earn-pool answer is a sentence + compact supplied/available strip", () => {
  it("names 3 USDC pools and BLUSDC as the highest payer", () => {
    const a = earnPoolStructuredAnswer({ rows: USDC, usdcOnly: true });
    expect(a.headline).toBe("Vanna currently has 3 USDC earn pools:");
    expect(a.note).toBe("Currently, BLUSDC pays the most, at 17.88%.");
    expect(a.sections).toHaveLength(3);
    expect(a.sections![0].body).toBe(
      "BLUSDC has a supply of 17.88%, borrow of 25.02% and utilization of 71.48%",
    );
    expect(a.sections![0].facts).toEqual([
      { label: "BLUSDC Supplied", value: "10,906.4888" },
      { label: "BLUSDC Available", value: "3,110.6778" },
    ]);
    expect(a.sections![2].body).toContain("SOUSDC has a supply of 0.17%");
    expect(answerToText(a)).toContain("SOUSDC Supplied");
  });

  it("list-all still includes XLM as a fourth pool", () => {
    const a = earnPoolStructuredAnswer({
      rows: [{ symbol: "XLM", supply_apy_pct: 3.6, borrow_apr_pct: 11.22, utilization_pct: 32.05, total_assets_human: 84340, total_liquidity_human: 57200 }, ...USDC],
    });
    expect(a.headline).toBe("Vanna currently has 4 earn pools:");
    expect(a.sections![0].body).toMatch(/^XLM has a supply/);
  });

  it("rate line is a sentence, not a run-on of labels", () => {
    expect(earnPoolRateLine(USDC[2])).toBe(
      "SOUSDC has a supply of 0.17%, borrow of 2.43% and utilization of 6.95%",
    );
  });
});
