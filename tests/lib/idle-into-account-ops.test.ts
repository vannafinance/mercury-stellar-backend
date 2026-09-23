/**
 * 23 Sep, XS6: an op that spends the margin account, sized from the IDLE WALLET, was refused
 * with "deposit the idle tokens as collateral first" (Aquarius add liquidity), while a Blend
 * supply in the same answer came with its deposit only because the model wrote one. Such an
 * op is now the deposit plus the op on what the deposit put in, the way a repay already was.
 */
import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
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
    { symbol: "XLM", balance: "10206.8356118", status: "ok" },
    { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  obs("e4", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
  obs("e6", "blend_markets", { reserves: [
    { venue: "blend", symbol: "XLM", supply_apr_pct: "168.6342", borrow_apr_pct: "208.2203", utilization_pct: "89.99" },
  ] }),
  obs("e7", "account_collateral", { collateral: [{ symbol: "XLM", balance: "0" }] }),
];
const ctx = () => ({
  scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages: ["supply my idle XLM to blend"],
  capacity: { grossCollateralUsd: "6605.84", debtUsd: "5102.54", floor: "1.2" }, borrowing: "forbidden" as const,
  comparisons: compareObservedRates(OBSERVATIONS, NOW),
});
const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({ title: "Idle XLM into Blend", rationale: "Because e1/e6.", evidenceIds: ["e1", "e6"], legs });
const steps = (p: ProposedPlan) => {
  const { candidates, rejected } = resolvePlans([p], ctx());
  return { steps: candidates[0]?.steps?.map((s) => [s.op, s.amount]), rejected: rejected.map((r) => r.reason) };
};

describe("an account-spending op sized from the idle wallet", () => {
  it("becomes the deposit plus the op, on the idle balance", () => {
    expect(steps(plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "all_idle" } }])).steps).toEqual([
      ["deposit_collateral", "10206.3356118"], ["supply_blend", "10206.3356118"],
    ]);
  });

  it("uses the deposit the model already wrote instead of depositing twice", () => {
    expect(steps(plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "all_idle" } },
    ])).steps).toEqual([["deposit_collateral", "10206.3356118"], ["supply_blend", "10206.3356118"]]);
  });

  it("leaves the model's own deposit-then-supply exactly as before", () => {
    expect(steps(plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])).steps).toEqual([["deposit_collateral", "10206.3356118"], ["supply_blend", "10206.3356118"]]);
  });

  it("does not turn a withdraw to the wallet into a deposit", () => {
    const result = steps(plan([{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_idle" } }]));
    expect(result.steps).toBeUndefined();
    expect(result.rejected[0]).toMatch(/withdraw/i);
  });
});
