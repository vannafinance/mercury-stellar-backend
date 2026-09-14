/**
 * A disagreement is a bracket, not a blindfold.
 *
 * ## The live failure this pins
 *
 * 14 Sep, signed in: *"can you transfer 500 xlm from my margin account to my wallet"* was
 * refused with "the Margin page and the liquidation engine disagree on your position, so
 * nothing that lowers health is sized until they agree" — while the Margin page's own
 * Transfer Collateral tab offered 842.46 XLM and its Transfer button worked.
 *
 * Probed against the deployed RiskEngine the same day (`scripts/audit-risk-engine.cjs`,
 * ledger 4672051): collateral $15,448.89 on the engine against $15,607.55 on the page — a
 * $158.67 gap, 1.03% of the larger side, just past the 0.5% tolerance that raises the
 * issue — debt $3,340.74 on both, and 10,719.88 XLM posted. Health was 4.62 against a 1.10
 * line, and $90 of XLM moves it to 4.57.
 *
 * So the gap was real and the refusal was still wrong: the rule asked whether the two
 * sources agreed instead of whether their disagreement could change the answer. Both
 * readings say the same thing about this transfer. Projecting against the worse of them
 * settles it without trusting either.
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

/** The account as the probe read it: an empty wallet, 10,719.88 XLM posted as collateral. */
const OBSERVATIONS: Observation[] = [
  obs("e1", "wallet_balances", { assets: [{ symbol: "XLM_SAC", balance: "0.0000000", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  obs("e3", "account_collateral", { collateral: [{ symbol: "XLM", balance: "10719.8772246" }] }),
];

/** `capacity` carries the engine's figures; `issue.app` carries the page's. */
const ISSUE = {
  reason: "sizing_sources_disagree" as const,
  app: { grossCollateralUsd: "15607.55", debtUsd: "3340.74" },
  contract: { grossCollateralUsd: "15448.89", debtUsd: "3340.74" },
};
const CAPACITY = { grossCollateralUsd: "15448.89", debtUsd: "3340.74", floor: null, issue: ISSUE };

function ctx(over: Partial<Parameters<typeof resolvePlans>[1]> = {}) {
  return {
    scope: SCOPE, observations: OBSERVATIONS, now: NOW,
    messages: ["can you transfer 500 xlm from my margin account to my wallet"],
    capacity: CAPACITY, borrowing: "unspecified" as const,
    comparisons: compareObservedRates(OBSERVATIONS, NOW), ...over,
  };
}
const transfer = (amount: string, quote: string): ProposedPlan => ({
  title: "Move XLM back to the wallet", rationale: "The account holds it (e3).", evidenceIds: ["e2"],
  legs: [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "literal", amount, sourceQuote: quote } }],
});

describe("a withdraw while the two collateral readings disagree", () => {
  it("goes through when the gap cannot change the verdict", () => {
    const { candidates, rejected } = resolvePlans([transfer("500", "500 xlm")], ctx());
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].steps?.map((s) => [s.op, s.asset, s.amount])).toEqual([["withdraw_collateral", "XLM", "500"]]);
  });

  it("projects against the worse reading, not the friendlier one", () => {
    // Same account, but now the page is the optimistic side by a mile. The pessimistic
    // corner — least collateral, most debt — is what the floor is tested against, so a
    // withdraw that only the page's figures could justify is still refused.
    const capacity = {
      grossCollateralUsd: "4000.00", debtUsd: "3340.74", floor: "1.2",
      issue: { reason: "sizing_sources_disagree" as const,
        app: { grossCollateralUsd: "15607.55", debtUsd: "3340.74" },
        contract: { grossCollateralUsd: "4000.00", debtUsd: "3500.00" } },
    };
    const { candidates, rejected } = resolvePlans([transfer("500", "500 xlm")], ctx({ capacity }));
    expect(candidates).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it("still refuses when the engine's own figures are missing — one reading is not a bracket", () => {
    const capacity = { ...CAPACITY, issue: { reason: "sizing_contract_unavailable" as const, app: ISSUE.app, contract: null } };
    const { candidates, rejected } = resolvePlans([transfer("500", "500 xlm")], ctx({ capacity }));
    expect(candidates).toEqual([]);
    expect(rejected[0].reason).toContain("no second reading");
  });

  it("leaves a borrow refused: it creates debt against the figure nobody can pin down", () => {
    const { candidates, rejected } = resolvePlans([{
      title: "Borrow against it", rationale: "e2.", evidenceIds: ["e2"],
      legs: [{ op: "borrow", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 xlm" } }],
    }], ctx({ messages: ["borrow 100 xlm"], capacity: { ...CAPACITY, floor: "1.3" }, borrowing: "allowed" as const }));
    expect(candidates).toEqual([]);
    expect(rejected[0].reason).toContain("disagree");
  });
});
