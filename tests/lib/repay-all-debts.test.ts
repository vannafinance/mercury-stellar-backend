import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import { sizeLegs } from "@/lib/copilot/investigation/sizing";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

/**
 * 23 Sep, X12 "withdraw all funds": repaying every debt was ruled out with "repay SOUSDC: the
 * repay is larger than the outstanding debt" while 21.98 SOUSDC was owed. Each repay was
 * within its own token's debt; together, at oracle prices, they summed a little above the
 * contract snapshot's USD total (the two sources disagreed that turn), and the last one
 * tripped the account-level check.
 */
const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
const SCOPE = {
  subject: "user", network: "testnet",
  trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
  smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
};
const DEBTS = { XLM: "7652.71", BLUSDC: "361.63", AQUSDC: "24.97", SOUSDC: "21.98" } as const;
const PRICE = { XLM: 0.217, BLUSDC: 1, AQUSDC: 1, SOUSDC: 1 } as const;
const assets = Object.keys(DEBTS) as (keyof typeof DEBTS)[];
const OBSERVATIONS: Observation[] = [
  obs("e1", "wallet_balances", { assets: assets.flatMap((symbol) => [
    { symbol, balance: "100000", spendable: "100000", status: "ok", decimals: 7 },
    ...(symbol === "XLM" ? [{ symbol: "XLM_SAC", balance: "100000", decimals: 7, status: "ok" }] : []),
  ]), fee_reserve_xlm: "0.5" }),
  ...assets.map((asset, i) => obs(`p${i}`, "asset_price", { price_usd: String(PRICE[asset]) }, { asset })),
  obs("e10", "account_debt", { debt: assets.map((symbol) => ({ symbol, balance: DEBTS[symbol] })) }),
];
const owedUsd = assets.reduce((sum, a) => sum + Number(DEBTS[a]) * PRICE[a], 0);
const ctx = (debtUsd: string) => ({
  scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages: ["repay all my debt"],
  capacity: { grossCollateralUsd: "5000", debtUsd, floor: null }, borrowing: "forbidden" as const,
  comparisons: compareObservedRates(OBSERVATIONS, NOW),
});
const repayAll: ProposedPlan = {
  title: "Repay all", rationale: "Because e10.", evidenceIds: ["e10"],
  legs: assets.map((asset) => ({ op: "repay" as const, asset, sizing: { kind: "all_position" as const } })),
};

describe("repaying every debt", () => {
  it("is not refused when the snapshot's USD total is a little below the per-token debts", () => {
    const { candidates, rejected } = resolvePlans([repayAll], ctx((owedUsd - 0.5).toFixed(2)));
    expect(rejected).toEqual([]);
    // Funded from the wallet, each repay is a deposit then the repay (expandLegs); the repays cover each debt exactly.
    expect(candidates[0].steps?.filter((s) => s.op === "repay").map((s) => [s.asset, s.amount])).toEqual(assets.map((a) => [a, DEBTS[a]]));
  });

  it("still sizes when the totals agree", () => {
    expect(resolvePlans([repayAll], ctx(owedUsd.toFixed(2))).rejected).toEqual([]);
  });

  it("keeps the account-level check for a repay nothing bounded by its own debt", () => {
    // Direct sizer use, no per-token bound: an overpay is still refused.
    expect(sizeLegs({ grossCollateralUsd: "5000", debtUsd: "100" }, [{ op: "repay", label: "Overpay", amountUsd: "150" }], null))
      .toMatchObject({ ok: false, reason: "repay_exceeds_debt" });
  });
});
