/**
 * Reported live:
 *
 * 1. "Margin account details" listed `collateral · BLEND_USDC`, `collateral · SS_XLM_USDC`,
 *    `collateral · BLEND_XLM` in the SAME facts list as real margin collateral
 *    (`collateral · XLM`) — farm-venue LP/receipt tokens read as duplicate or confusing
 *    entries next to plain collateral. `isTrackingSymbol` already exists to tell them
 *    apart (used correctly one function over, in `focusPositionRows`) but was never
 *    applied on this "list everything" path.
 * 2. The same answer never showed an Aquarius LP position, even when one exists —
 *    `aquariusLpCollateralRow` (lib/analytics/stellar/farmTrackingCollateral.ts) read only
 *    the Registry tracking-token balance, which goes stale, instead of falling back to the
 *    pool contract's own `get_user_shares()` the way the Farm page and `farmPositionAnswer`
 *    already do.
 *
 * `allPositionsStructured` is exported specifically so this can be pinned directly against
 * its output shape, without standing up the full MCP/network plumbing `query_all_positions`
 * sits behind.
 */
import { describe, expect, it } from "vitest";
import { allPositionsStructured } from "@/lib/copilot/handle";

const basePos = {
  hf: 1.56,
  hfText: "1.56",
  grossCollateralValue: 559.35,
  totalBorrowedValue: 357.41,
  totalValue: 559.35,
  collateralLeftBeforeLiquidation: 100,
  netAvailableCollateral: 201.94,
  borrowed: [
    { symbol: "BLUSDC", amount: "167.8474", usd: 167.98 },
    { symbol: "AQUSDC", amount: "157.7983", usd: 157.93 },
    { symbol: "SOUSDC", amount: "31.4719", usd: 31.5 },
  ],
  collateral: [
    { symbol: "XLM", amount: "1340.1623", usd: 205.59 },
    { symbol: "BLUSDC", amount: "155.7031", usd: 155.83 },
    { symbol: "AQUSDC", amount: "147.7031", usd: 147.82 },
    { symbol: "SOUSDC", amount: "30.1727", usd: 30.2 },
    // Farm-venue LP/receipt tokens — NOT plain collateral the user deposited.
    { symbol: "BLEND_USDC", amount: "12", usd: 12.01 },
    { symbol: "SS_XLM_USDC", amount: "7.36", usd: 6.36 },
    { symbol: "BLEND_XLM", amount: "10", usd: 1.53 },
    { symbol: "AQ_XLM_USDC", amount: "5.2", usd: 4.4 },
  ],
};

describe("allPositionsStructured separates LP/farm-tracking rows from plain collateral", () => {
  const structured = allPositionsStructured(basePos, "");
  const collateralFacts = structured.facts.filter((f) => f.label.startsWith("collateral · "));
  const lpFacts = structured.facts.filter((f) => f.group === "lp");

  it("plain collateral facts never include a farm-tracking symbol", () => {
    const labels = collateralFacts.map((f) => f.label);
    expect(labels).toContain("collateral · XLM");
    expect(labels).toContain("collateral · BLUSDC");
    for (const bad of ["BLEND_USDC", "SS_XLM_USDC", "BLEND_XLM", "AQ_XLM_USDC"]) {
      expect(labels.join(" ")).not.toContain(bad);
    }
  });

  it("farm-tracking rows land in their own group, human-labelled", () => {
    expect(lpFacts.length).toBe(4);
    const labels = lpFacts.map((f) => f.label);
    expect(labels).toContain("USDC in Blend");
    expect(labels).toContain("XLM in Blend");
    expect(labels).toContain("XLM/USDC LP on Soroswap");
    expect(labels).toContain("XLM/USDC LP on Aquarius");
  });

  it("no fact is dropped — every collateral row appears exactly once, in one group or the other", () => {
    expect(collateralFacts.length + lpFacts.length).toBe(basePos.collateral.length);
  });

  it("borrowed tracking rows (if any) get the same treatment as collateral ones", () => {
    const withTrackedBorrow = {
      ...basePos,
      borrowed: [...basePos.borrowed, { symbol: "BLEND_USDC", amount: "3", usd: 3.01 }],
    };
    const s = allPositionsStructured(withTrackedBorrow, "");
    expect(s.facts.some((f) => f.label === "borrowed · BLEND_USDC")).toBe(false);
    expect(s.facts.some((f) => f.label === "USDC in Blend" && f.group === "lp")).toBe(true);
  });
});
