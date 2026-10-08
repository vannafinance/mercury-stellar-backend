/**
 * 8 Oct, live, from the owner's catalogue (B8): "supply 10 AQUSDC to blend" was answered with a plan to
 * supply BLUSDC ("Read as: Supply 10 USDC (BLUSDC) to Blend") and an Approve button. Blend has no AQUSDC
 * reserve, so the honest answer is a refusal that names it, not a different token.
 */
import { describe, expect, it } from "vitest";
import { namedOpAssets, venueRefusal } from "@/lib/copilot/investigation/named-op-assets";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import { assetDef } from "@/lib/copilot/registry/assets";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const MESSAGE = "supply 10 AQUSDC to blend";

describe("namedOpAssets", () => {
  it("pairs an op with the one asset its quote names", () => {
    const rows = namedOpAssets([{ op: "supply_blend", sourceQuote: MESSAGE }], [MESSAGE]);
    expect(rows.map((row) => [row.op, row.asset.id])).toEqual([["supply_blend", "AQUSDC"]]);
  });
  it("ignores a quote the user never wrote", () => {
    expect(namedOpAssets([{ op: "supply_blend", sourceQuote: "supply 10 AQUSDC to blend" }], ["put my XLM to work"])).toEqual([]);
  });
  it("ignores a quote that names no asset, several assets, or a bare USDC", () => {
    expect(namedOpAssets([{ op: "supply_blend", sourceQuote: "supply it to blend" }], ["supply it to blend"])).toEqual([]);
    expect(namedOpAssets([{ op: "lend", sourceQuote: "lend XLM and AQUSDC" }], ["lend XLM and AQUSDC"])).toEqual([]);
    expect(namedOpAssets([{ op: "lend", sourceQuote: "lend my USDC" }], ["lend my USDC"])).toEqual([]);
  });
  it("drops an op named for two different assets: that is a list, not a pairing", () => {
    const rows = namedOpAssets(
      [{ op: "lend", sourceQuote: "lend 5 XLM" }, { op: "lend", sourceQuote: "lend 5 AQUSDC" }],
      ["lend 5 XLM and lend 5 AQUSDC"],
    );
    expect(rows).toEqual([]);
  });
});

describe("venueRefusal", () => {
  it("says what the venue lacks, from the registry's venue data", () => {
    expect(venueRefusal("supply_blend", assetDef("AQUSDC"))).toBe("Blend has no AQUSDC reserve");
    expect(venueRefusal("lend", assetDef("AQUA"))).toBe("AQUA has no Earn pool");
    expect(venueRefusal("borrow", assetDef("EURC"))).toBe("EURC is not accepted by the margin account");
  });
  it("is silent when the venue takes the asset, and for ops it cannot speak for", () => {
    expect(venueRefusal("supply_blend", assetDef("BLUSDC"))).toBeNull();
    expect(venueRefusal("lend", assetDef("XLM"))).toBeNull();
    expect(venueRefusal("swap", assetDef("AQUA"))).toBeNull();
    expect(venueRefusal("remove_liquidity", assetDef("BLUSDC"))).toBeNull();
  });
});

const NOW = 1_700_000_000_000;
const SCOPE = {
  subject: "user", network: "testnet",
  trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
  smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
};
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
const OBSERVATIONS: Observation[] = [
  obs("e1", "wallet_balances", { assets: [
    { symbol: "XLM", balance: "1000", status: "ok" }, { symbol: "XLM_SAC", balance: "1000", decimals: 7, status: "ok" },
    { symbol: "BLUSDC", balance: "50", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  obs("e3", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
  obs("e6", "blend_markets", { reserves: [
    { venue: "blend", symbol: "XLM", supply_apr_pct: "10", borrow_apr_pct: "12", utilization_pct: "50" },
    { venue: "blend", symbol: "USDC", supply_apr_pct: "2.5", borrow_apr_pct: "3", utilization_pct: "50" },
  ] }),
];
const supplyBlusdc: ProposedPlan = {
  title: "Supply idle BLUSDC to Blend", rationale: "Supply idle BLUSDC to Blend because e1/e6.", evidenceIds: ["e1", "e6"],
  legs: [
    { op: "deposit_collateral", asset: "BLUSDC", sizing: { kind: "literal", amount: "10", sourceQuote: "10 AQUSDC" } },
    { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
  ],
} as ProposedPlan;
const ctx = (extra: Record<string, unknown> = {}) => ({
  scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages: [MESSAGE],
  capacity: { grossCollateralUsd: "5000", debtUsd: "1000", floor: "1.2" }, borrowing: "allowed" as const,
  comparisons: compareObservedRates(OBSERVATIONS, NOW), ...extra,
});

describe("a plan in another token than the one the user named for that op", () => {
  it("is refused with the venue's reason when the venue cannot take the named token", () => {
    const named = namedOpAssets([{ op: "supply_blend", sourceQuote: MESSAGE }], [MESSAGE]);
    const { candidates, rejected } = resolvePlans([supplyBlusdc], ctx({ namedOpAssets: named }));
    expect(candidates).toEqual([]);
    expect(rejected.map((row) => row.reason)).toEqual(["Blend has no AQUSDC reserve"]);
  });
  it("is left alone when nothing was named for the op", () => {
    const { candidates, rejected } = resolvePlans([supplyBlusdc], ctx());
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
  });
  it("is left alone when the named token can do the op (only a definite mismatch refuses)", () => {
    const named = namedOpAssets([{ op: "supply_blend", sourceQuote: "supply 10 XLM to blend" }], ["supply 10 XLM to blend"]);
    const { rejected } = resolvePlans([supplyBlusdc], ctx({ namedOpAssets: named, messages: ["supply 10 XLM to blend"] }));
    expect(rejected.map((row) => row.reason).join(" ")).not.toMatch(/no XLM reserve|has no/);
  });
});
