/**
 * 23 Sep, XS6: "use my whole wallet to earn the most" came back as one option per asset, and
 * Approve could run only one. Plans the user asked for together are joined into one plan,
 * but only when it is safe, and every failure falls back to the separate options.
 */
import { describe, expect, it } from "vitest";
import { joinPlanParts, resolveJoinedOrParts, resolvePlans } from "@/lib/copilot/investigation/plan";
import { anchoredPlanParts } from "@/lib/copilot/investigation/floor";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

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
    { symbol: "XLM", balance: "2152.2879106", status: "ok" },
    { symbol: "XLM_SAC", balance: "2152.2879106", decimals: 7, status: "ok" },
    { symbol: "BLUSDC", balance: "680", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "0.2156" }, { asset: "XLM" }),
  obs("e3", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
  obs("e4", "earn_market", { supply_apr_pct: "2.76", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
  obs("e5", "earn_market", { supply_apr_pct: "19.16", borrow_apr_pct: "25", utilization_pct: "80" }, { asset: "BLUSDC" }),
  obs("e6", "blend_markets", { reserves: [
    { venue: "blend", symbol: "XLM", supply_apr_pct: "173.44", borrow_apr_pct: "208.2", utilization_pct: "89.99" },
    { venue: "blend", symbol: "USDC", supply_apr_pct: "1.54", borrow_apr_pct: "2", utilization_pct: "76.75" },
  ] }),
];
const ctx = () => ({
  scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages: ["use my whole wallet to earn the most without taking new debt", "farm"],
  capacity: { grossCollateralUsd: "6605.84", debtUsd: "2082.23", floor: null }, borrowing: "forbidden" as const,
  comparisons: compareObservedRates(OBSERVATIONS, NOW),
});
const part = (title: string, legs: ProposedPlan["legs"]): ProposedPlan => ({ title, rationale: `${title}.`, evidenceIds: ["e1"], legs });
const xlmToBlend = part("Supply idle XLM to Blend", [
  { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
  { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
]);
const blusdcToBlend = part("Supply idle BLUSDC to Blend", [
  { op: "deposit_collateral", asset: "BLUSDC", sizing: { kind: "all_idle" } },
  { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
]);

describe("joining the parts of one request", () => {
  it("adds nothing: the joined legs are exactly the parts' legs, each part in its own order", () => {
    const joined = joinPlanParts([xlmToBlend, blusdcToBlend]);
    expect("plan" in joined && joined.plan.legs).toEqual([...xlmToBlend.legs, ...blusdcToBlend.legs]);
  });

  it("orders parts by the stage they need: leave a position, then raise health, then lower it", () => {
    const withdraw = part("Withdraw collateral", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }]);
    const repay = part("Repay debt", [{ op: "repay", asset: "XLM", sizing: { kind: "all_position" } }]);
    const exit = part("Exit Blend", [{ op: "blend_withdraw", asset: "BLUSDC", sizing: { kind: "all_position" } }]);
    const joined = joinPlanParts([withdraw, repay, exit]);
    expect("plan" in joined && joined.plan.legs.map((leg) => leg.op)).toEqual(["blend_withdraw", "repay", "withdraw_collateral"]);
  });

  it("never joins two ways of using the same tokens", () => {
    const alsoXlm = part("Lend idle XLM", [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }]);
    expect(joinPlanParts([xlmToBlend, alsoXlm])).toMatchObject({ reason: expect.stringContaining("deposit_collateral XLM") });
  });

  it("leaves a single plan alone", () => {
    expect(joinPlanParts([xlmToBlend])).toMatchObject({ reason: "only one plan" });
  });
});

describe("the joined plan, or the parts exactly as before", () => {
  it("offers ONE plan covering both assets when it sizes and fits one approval", () => {
    const joined = joinPlanParts([xlmToBlend, blusdcToBlend]);
    if (!("plan" in joined)) throw new Error("not joined");
    const { plans, resolved, warning } = resolveJoinedOrParts(joined.plan, [xlmToBlend, blusdcToBlend], ctx(), 8);
    expect(plans).toHaveLength(1);
    expect(warning).toBeNull();
    expect(resolved.candidates).toHaveLength(1);
    expect(resolved.candidates[0].steps?.map((s) => [s.op, s.asset])).toEqual([
      ["deposit_collateral", "XLM"], ["supply_blend", "XLM"], ["deposit_collateral", "BLUSDC"], ["supply_blend", "BLUSDC"],
    ]);
  });

  it("falls back to the separate parts, with a reason, when the joined plan needs more steps than one approval", () => {
    const joined = joinPlanParts([xlmToBlend, blusdcToBlend]);
    if (!("plan" in joined)) throw new Error("not joined");
    const { plans, resolved, warning } = resolveJoinedOrParts(joined.plan, [xlmToBlend, blusdcToBlend], ctx(), 3);
    expect(plans).toEqual([xlmToBlend, blusdcToBlend]);
    // Identical to sizing the parts without any join.
    expect(resolved).toEqual(resolvePlans([xlmToBlend, blusdcToBlend], ctx()));
    expect(warning).toMatch(/takes 4 transactions, more than one approval can run \(3\)/);
  });

  it("falls back to the separate parts when the joined plan does not size", () => {
    const noSuchFunds = part("Supply idle AQUSDC to Blend", [
      { op: "deposit_collateral", asset: "AQUSDC", sizing: { kind: "all_idle" } },
      { op: "supply_blend", asset: "AQUSDC", sizing: { kind: "previous_leg" } },
    ]);
    const joined = joinPlanParts([xlmToBlend, noSuchFunds]);
    if (!("plan" in joined)) throw new Error("not joined");
    const { plans, resolved, warning } = resolveJoinedOrParts(joined.plan, [xlmToBlend, noSuchFunds], ctx(), 8);
    expect(plans).toEqual([xlmToBlend, noSuchFunds]);
    expect(resolved).toEqual(resolvePlans([xlmToBlend, noSuchFunds], ctx()));
    expect(warning).toBeNull();
  });
});

describe("only the user's own words make plans parts", () => {
  const messages = ["use my whole wallet to earn the most", "farm"];
  it("accepts a quote the user sent", () => {
    expect(anchoredPlanParts({ planRelation: { kind: "parts", sourceQuote: "use my whole wallet" } }, messages)).toBe(true);
  });
  it("rejects a quote the user never wrote, and alternatives", () => {
    expect(anchoredPlanParts({ planRelation: { kind: "parts", sourceQuote: "do all of it" } }, messages)).toBe(false);
    expect(anchoredPlanParts({ planRelation: { kind: "alternatives", sourceQuote: "use my whole wallet" } }, messages)).toBe(false);
    expect(anchoredPlanParts({}, messages)).toBe(false);
  });
});
