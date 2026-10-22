import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const now = 1_700_000_000_000;
const scope = { subject: "user", network: "testnet", trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA", smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC" };
/** Recorded collateral is lower than what the account really holds, as it is once a borrow's proceeds sit in the account. */
function run(message: string, amount: string, real: string | null) {
  const observation = (id: string, capability: string, data: Record<string, unknown>, args = {}): Observation => ({ id, capability, data, args, status: "ok", observedAt: now });
  const observations = [
    observation("price", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
    observation("collateral", "account_collateral", { collateral: [{ symbol: "XLM", balance: "4645.2" }] }),
    ...(real ? [observation("held", "account_token_balance", { holder: scope.smartAccount, symbol: "XLM", decimals: 7, human: real }, { asset: "XLM" })] : []),
  ];
  const plan: ProposedPlan = { title: `Withdraw ${amount} XLM`, rationale: "Withdraw to the wallet.", evidenceIds: observations.map((o) => o.id), legs: [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "literal", amount, sourceQuote: message } }] };
  return resolvePlans([plan], { scope, observations, now, messages: [message], capacity: { grossCollateralUsd: "2000", debtUsd: "0", floor: null }, borrowing: "forbidden", comparisons: [] });
}

describe("a withdraw is sized like the Transfer Collateral page: on what the account really holds", () => {
  it("allows more than the recorded collateral when the account really holds it", () => {
    const result = run("transfer 6,100 xlm to wallet", "6100", "6173.8873285");
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["withdraw_collateral", "6100"]]);
  });
  it("refuses more than the account really holds, naming that balance", () => {
    expect(run("transfer 7000 xlm to wallet", "7000", "6173.8873285").rejected[0]?.reason).toBe("only 6173.8873285 XLM is in the margin account");
  });
  it("keeps the recorded figure when the real balance was not read", () => {
    expect(run("transfer 6000 xlm to wallet", "6000", null).rejected[0]?.reason).toBe("only 4645.2 XLM is in the margin account");
  });
});
