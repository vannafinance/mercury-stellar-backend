import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const now = 1_700_000_000_000;
const scope = { subject: "user", network: "testnet", trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA", smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC" };
/** `account` is the token balance the margin account really holds; the recorded collateral is deliberately lower, as it is once a borrow's proceeds sit in the account. */
function run(account: string, wallet: string, prior: ProposedPlan["legs"] = [], sizing: ProposedPlan["legs"][number]["sizing"] = { kind: "all_position" }) {
  const observation = (id: string, capability: string, data: Record<string, unknown>, args = {}): Observation => ({ id, capability, data, args, status: "ok", observedAt: now });
  const observations = [
    observation("wallet", "wallet_balances", { assets: [{ symbol: "BLUSDC", balance: wallet, decimals: 7, status: "ok" }] }),
    observation("price", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
    observation("collateral", "account_collateral", { collateral: [{ symbol: "BLUSDC", balance: "10" }] }),
    observation("held", "account_token_balance", { holder: scope.smartAccount, symbol: "BLUSDC", decimals: 7, human: account }, { asset: "BLUSDC" }),
    observation("debt", "account_debt", { debt: [{ symbol: "BLUSDC", balance: "100" }] }),
  ];
  const plan: ProposedPlan = { title: "Repay the debt", rationale: "Repay from available balances.", evidenceIds: observations.map(o => o.id), legs: [...prior, { op: "repay", asset: "BLUSDC", sizing }] };
  return resolvePlans([plan], { scope, observations, now, messages: ["deposit 4 BLUSDC then repay my BLUSDC debt", "repay 25% of my debt", "repay 50% of my debt"], capacity: { grossCollateralUsd: "1000", debtUsd: "100", floor: null }, borrowing: "forbidden", comparisons: [] });
}

describe("repaying the whole debt follows the Repay page: the smaller of what is owed and what the account holds", () => {
  it("repays everything owed when the account holds it", () => {
    const result = run("110", "0");
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["repay", "100"]]);
    expect(result.candidates[0]?.repaysAllDebt).toBe(true);
  });
  it("repays what the account holds when it holds less, whatever the wallet could add, and says what remains", () => {
    for (const wallet of ["0", "3", "4", "500"]) {
      const result = run("96", wallet);
      expect(result.rejected).toEqual([]);
      expect(result.candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["repay", "96"]]);
      expect(result.candidates[0]?.repaysAllDebt).toBe(false);
      expect(result.candidates[0]?.rationale).toContain("Repays 96 of the 100 BLUSDC you asked for");
      expect(result.candidates[0]?.rationale).toContain("Leaves 4 BLUSDC of debt");
    }
  });
  it("records a cut repay as stated, so the whole debt is not re-read over it before sending", () => {
    const cut = run("96", "0").candidates[0]?.steps?.[0];
    expect(cut?.sizing).toEqual({ basis: "stated" });
    expect(run("110", "0").candidates[0]?.steps?.[0]?.sizing).toMatchObject({ basis: "whole_position" });
  });
  it("cuts the repay to the token's precision rather than asking for more than the account holds", () => {
    expect(run("96.00000005", "4").candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["repay", "96"]]);
  });
  it("says so plainly when the account holds none of the token", () => {
    const result = run("0", "500");
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("Your margin account holds no BLUSDC to repay with. Deposit BLUSDC into the account first, or ask to repay with your wallet's BLUSDC");
  });
  it("keeps whole-debt sizing when the user already supplied the funding deposit", () => {
    const result = run("96", "4", [{ op: "deposit_collateral", asset: "BLUSDC", sizing: { kind: "literal", amount: "4", sourceQuote: "deposit 4 BLUSDC" } }]);
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["deposit_collateral", "4"], ["repay", "100"]]);
  });
  it("cuts a share of the debt to the account's balance the same way", () => {
    const share = (percent: string) => run("30", "500", [], { kind: "fraction", percent, of: "position", sourceQuote: `repay ${percent}% of my debt` }).candidates[0]?.steps?.map(s => [s.op, s.amount]);
    expect(share("25")).toEqual([["repay", "25"]]);
    expect(share("50")).toEqual([["repay", "30"]]);
  });
  it("deposits from the wallet only when the user sized the repay from the wallet", () => {
    const result = run("0", "40", [], { kind: "all_wallet" });
    expect(result.candidates[0]?.steps?.map(s => [s.op, s.amount])).toEqual([["deposit_collateral", "40"], ["repay", "40"]]);
  });
});
