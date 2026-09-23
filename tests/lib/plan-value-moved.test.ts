import { describe, expect, it } from "vitest";
import { valueMovedWad } from "@/lib/copilot/investigation/plan";
import { formatWad } from "@/lib/copilot/investigation/fixed";

/**
 * Live, 23 Sep: "withdraw all funds" offered four independent Earn redeems (≈ $45 + $102 +
 * $15 + $52) and labelled the option "Amount $52.07" — the last redeem alone.
 */
const total = (legs: Parameters<typeof valueMovedWad>[0]) => Number(formatWad(valueMovedWad(legs)));

describe("the value a plan moves is counted once", () => {
  it("adds independent legs", () => {
    expect(total([
      { op: "redeem", asset: "XLM", usd: "10" },
      { op: "redeem", asset: "BLUSDC", usd: "102.09" },
      { op: "redeem", asset: "AQUSDC", usd: "15.18" },
      { op: "redeem", asset: "SOUSDC", usd: "52.07" },
    ])).toBeCloseTo(179.34, 6);
  });

  it("counts a leg that feeds the next as one sum of money", () => {
    // redeem lands XLM in the wallet; the deposit spends that same XLM from the wallet.
    expect(total([
      { op: "redeem", asset: "XLM", usd: "40" },
      { op: "deposit_collateral", asset: "XLM", usd: "40" },
    ])).toBeCloseTo(40, 6);
  });

  it("does not merge legs that only share a pocket, not an asset", () => {
    expect(total([
      { op: "redeem", asset: "XLM", usd: "40" },
      { op: "deposit_collateral", asset: "BLUSDC", usd: "25" },
    ])).toBeCloseTo(65, 6);
  });

  it("follows a swap by the asset it produces, not the one it spends", () => {
    // The swap spends XLM and produces AQUSDC; a later leg spending XLM is new money.
    expect(total([
      { op: "swap", asset: "XLM", assetOut: "AQUSDC", usd: "30" },
      { op: "withdraw_collateral", asset: "XLM", usd: "12" },
    ])).toBeCloseTo(42, 6);
  });
});
