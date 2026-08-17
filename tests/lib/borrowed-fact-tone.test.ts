/**
 * Reported live: "Margin Details are also Wrong and what is this box representing?" — every
 * `borrowed · X` fact on the "all open positions" card carried a flat `tone: "warn"`, so a
 * perfectly healthy account (HF ~4.8) still showed the colorblind-accessible warning glyph
 * (the small square, see TONE_MARK in answer-view.tsx) on every debt line, reading as
 * "something is wrong here" when nothing was. The health-factor fact right above it already
 * derives its tone from real risk tiers; the borrowed facts now share that same tone instead
 * of a hardcoded one.
 */
import { describe, expect, it } from "vitest";
import { allPositionsStructured } from "@/lib/copilot/handle";

function pos(hf: number) {
  return {
    hf,
    hfText: hf.toFixed(2),
    collateral: [{ symbol: "XLM", amount: "1000", usd: 150 }],
    borrowed: [{ symbol: "BLUSDC", amount: "50", usd: 50 }],
    grossCollateralValue: 150,
    totalBorrowedValue: 50,
    totalValue: 150,
    collateralLeftBeforeLiquidation: 100,
    netAvailableCollateral: 100,
  };
}

function borrowedFact(hf: number) {
  const structured = allPositionsStructured(pos(hf), "");
  return structured.facts.find((f) => f.label === "borrowed · BLUSDC");
}

describe("'borrowed · X' facts carry the account's real risk tier, not a flat warning", () => {
  it("shows no tone on a healthy account (HF well above the warn threshold)", () => {
    expect(borrowedFact(4.8)?.tone).toBeUndefined();
  });

  it("shows warn on a stressed account (HF under 1.4)", () => {
    expect(borrowedFact(1.35)?.tone).toBe("warn");
  });

  it("shows bad on a near-liquidation account (HF under 1.1)", () => {
    expect(borrowedFact(1.05)?.tone).toBe("bad");
  });

  it("matches the health-factor fact's own tone exactly, for every tier", () => {
    for (const hf of [4.8, 1.35, 1.05]) {
      const structured = allPositionsStructured(pos(hf), "");
      const hfFact = structured.facts.find((f) => f.label === "health factor");
      const borrowed = structured.facts.find((f) => f.label === "borrowed · BLUSDC");
      const expected = hfFact?.tone === "good" ? undefined : hfFact?.tone;
      expect(borrowed?.tone).toBe(expected);
    }
  });
});
