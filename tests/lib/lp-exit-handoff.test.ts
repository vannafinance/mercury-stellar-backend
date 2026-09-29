/**
 * A removal pays two tokens. A later `previous_leg` spends the one that matches
 * its asset, from the pool read. No pool read keeps the old refusal.
 */
import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const NOW = 1_700_000_000_000;
const SCOPE = {
  subject: "user", network: "testnet",
  trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
  smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
};
const UNKNOWN = "removing liquidity pays back two tokens, not one, so how much of either is not known in advance — state the next leg's amount yourself";
const POCKET = "a remove puts tokens in the account — withdraw, repay, supply, swap or add them next, not a lend";

const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });

const wallet = obs("w", "wallet_balances", { assets: [
  { symbol: "XLM", balance: "1", decimals: 7, status: "ok" },
  { symbol: "XLM_SAC", balance: "1", decimals: 7, status: "ok" },
  { symbol: "AQUSDC", balance: "1", decimals: 7, status: "ok" },
], fee_reserve_xlm: "0.5" });
const prices = [
  obs("px", "asset_price", { price_usd: "0.2" }, { asset: "XLM" }),
  obs("pq", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }),
];
const position = obs("lp", "farm_lp_position", { lp_shares_human: "10", decimals: 7 }, { asset: "AQUSDC" });
// 10 of 100 shares: 100 XLM and 20 AQUSDC.
const pool = obs("r", "aquarius_pool_reserves", {
  found: true,
  pool: { available: true, reserves: { XLM: "1000", USDC: "200" }, total_share: "100", fee: "0.003", reserves_source: "ledger" },
}, { asset: "AQUSDC" });

const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({
  title: "Leave the pool", rationale: "The pool read sizes both tokens.", evidenceIds: ["lp", "r"], legs,
});

function run(legs: ProposedPlan["legs"], withPool: boolean) {
  return resolvePlans([plan(legs)], {
    scope: SCOPE,
    observations: [wallet, ...prices, position, ...(withPool ? [pool] : [])],
    now: NOW,
    messages: ["remove my AQUSDC liquidity and supply the XLM to Blend"],
    capacity: { grossCollateralUsd: "100000", debtUsd: "0", floor: null },
    borrowing: "allowed",
    comparisons: [],
  });
}

const exit = { op: "remove_liquidity" as const, asset: "AQUSDC", sizing: { kind: "all_position" as const } };

describe("an LP exit feeds the next leg in that token", () => {
  it("supplies the XLM the removal pays, labelled as an estimate", () => {
    const { candidates, rejected } = run([
      exit,
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ], true);
    expect(rejected).toEqual([]);
    const steps = candidates[0]?.steps ?? [];
    expect(steps.map((step) => [step.op, step.asset, step.amount])).toEqual([
      ["remove_liquidity", "AQUSDC", "10"],
      ["supply_blend", "XLM", "100"],
    ]);
    expect(steps[1]?.label).toBe("Supply an estimated 100 XLM to Blend, the removal's payout");
    expect(steps[1]?.sizing).toEqual({ basis: "settled_payout", fromStep: "s0-remove_liquidity", asset: "XLM" });
    expect(steps[0]?.sizing).toEqual({ basis: "stated" });
  });

  it("lets two later legs take one token each", () => {
    const { candidates, rejected } = run([
      exit,
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      { op: "withdraw_collateral", asset: "AQUSDC", sizing: { kind: "previous_leg" } },
    ], true);
    expect(rejected).toEqual([]);
    const steps = candidates[0]?.steps ?? [];
    expect(steps.map((step) => [step.op, step.asset, step.amount])).toEqual([
      ["remove_liquidity", "AQUSDC", "10"],
      ["supply_blend", "XLM", "100"],
      ["withdraw_collateral", "AQUSDC", "20"],
    ]);
    expect(steps[2]?.label).toContain("an estimated 20 AQUSDC");
    expect(steps[2]?.label).toContain("the removal's payout");
    expect(steps[2]?.sizing).toEqual({ basis: "settled_payout", fromStep: "s0-remove_liquidity", asset: "AQUSDC" });
  });

  it("refuses a second leg that claims the same token", () => {
    const { candidates, rejected } = run([
      exit,
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ], true);
    expect(candidates).toEqual([]);
    // The first supply already took the removal's XLM, and a Blend supply leaves nothing to take again.
    expect(rejected[0]?.reason).toBe("a Blend supply leaves nothing in the account to use next");
  });

  it("refuses a lend with the pocket sentence, because a removal pays the account", () => {
    const { candidates, rejected } = run([
      exit,
      { op: "lend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ], true);
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe(POCKET);
  });

  it("keeps the old refusal, word for word, when the pool was not read", () => {
    const { candidates, rejected } = run([
      exit,
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ], false);
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe(UNKNOWN);
  });
});
