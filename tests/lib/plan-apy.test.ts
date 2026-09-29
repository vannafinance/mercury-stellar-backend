import { describe, expect, it } from "vitest";
import { planApy, shownApyPct } from "@/lib/copilot/investigation/apy";

/**
 * 23 Sep, owner: every plan card said "APR" while the Earn and Farm pages say "APY". A plan
 * quotes each venue the way its own page does: Earn as-is, Blend compounded weekly.
 */
describe("a plan's rate matches the venue pages", () => {
  it("shows Earn's rate as-is, as the Earn page's Supply APY does", () => {
    expect(shownApyPct("earn_supply", "19.16")).toBeCloseTo(19.16, 6);
  });

  it("compounds Blend weekly, matching the Farm page (173.38% APR → ~450.4%)", () => {
    expect(shownApyPct("blend_supply", "173.3838")).toBeCloseTo(450.4, 0);
  });

  it("converts a mixed plan leg by leg, never the blended APR once", () => {
    // $100 into Blend at 173.38% APR and $100 into Earn at 19.16%.
    const { supplyApyPct } = planApy([
      { kind: "blend_supply", usd: 100, aprPct: "173.3838" },
      { kind: "earn_supply", usd: 100, aprPct: "19.16" },
    ], 200);
    const perLeg = (shownApyPct("blend_supply", "173.3838") + 19.16) / 2;
    expect(supplyApyPct).toBeCloseTo(perLeg, 6);
    // Compounding the 96.27% average once would overstate it.
    expect(supplyApyPct).not.toBeCloseTo(shownApyPct("blend_supply", (173.3838 + 19.16) / 2), 0);
  });

  it("nets the borrow cost against what is supplied", () => {
    const { netApyPct } = planApy([
      { kind: "blend_supply", usd: 100, aprPct: "10" },
      { kind: "earn_borrow", usd: 100, aprPct: "8" },
    ], 100);
    expect(netApyPct).toBeCloseTo(shownApyPct("blend_supply", "10") - 8, 6);
  });
});
