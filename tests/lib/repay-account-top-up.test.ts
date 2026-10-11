import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const now = 1_700_000_000_000;
const scope = { subject: "user", network: "testnet", trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA", smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC" };
function run(account: string, wallet: string, prior: ProposedPlan["legs"] = []) {
  const observation = (id: string, capability: string, data: Record<string, unknown>, args = {}): Observation => ({ id, capability, data, args, status: "ok", observedAt: now });
  const observations = [
    observation("wallet", "wallet_balances", { assets: [{ symbol: "BLUSDC", balance: wallet, decimals: 7, status: "ok" }] }),
    observation("price", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
    observation("collateral", "account_collateral", { collateral: [{ symbol: "BLUSDC", balance: account }] }),
    observation("debt", "account_debt", { debt: [{ symbol: "BLUSDC", balance: "100" }] }),
  ];
  const plan: ProposedPlan = { title: "Repay the debt", rationale: "Repay from available balances.", evidenceIds: observations.map(o => o.id), legs: [...prior, { op: "repay", asset: "BLUSDC", sizing: { kind: "all_position" } }] };
  return resolvePlans([plan], { scope, observations, now, messages: ["deposit 4 BLUSDC then repay all my BLUSDC debt"], capacity: { grossCollateralUsd: "1000", debtUsd: "100", floor: null }, borrowing: "forbidden", comparisons: [] });
}

describe("whole-debt repayment uses the account before topping up", () => {
  it("deposits only the shortfall and repays the whole debt", () => {
    const result = run("96", "20");
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["deposit_collateral", "4"], ["repay", "100"]]);
  });
  it("works when the wallet contains exactly the shortfall", () => {
    const result = run("96", "4");
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.[1].amount).toBe("100");
  });
  it("keeps whole-debt sizing when the user already supplied the funding deposit", () => {
    const result = run("96", "4", [{ op: "deposit_collateral", asset: "BLUSDC", sizing: { kind: "literal", amount: "4", sourceQuote: "deposit 4 BLUSDC" } }]);
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["deposit_collateral", "4"], ["repay", "100"]]);
  });
  it("does not offer a whole-debt repayment when combined funds fall short", () => {
    expect(run("96", "3").candidates).toEqual([]);
  });
  it("keeps an account-funded repayment as one step", () => {
    expect(run("110", "0").candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["repay", "100"]]);
  });
  it("rounds the derived top-up to the token quantum so account dust cannot leave the repayment unfunded", () => {
    expect(run("96.00000005", "4").candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["deposit_collateral", "4"], ["repay", "100"]]);
  });
});
