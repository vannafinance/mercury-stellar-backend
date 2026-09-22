/**
 * A leg is bound to what the one before it LEAVES BEHIND, not to what it spends.
 *
 * Live, 22 Sep (X5): "swap 100 XLM to AQUSDC and add it as liquidity" was refused with
 * *"previous_leg needs a preceding leg in the same asset"* — while leg 1 produced
 * exactly that asset. The producer scan compared `leg.asset`, and a swap's `asset` is
 * the token going IN (`tokenIn: swapStep.asset`); what it hands on is `assetOut`. So a
 * swap producing AQUSDC was invisible to a scan looking for AQUSDC.
 *
 * The identity premise the scan documents — a leg produces exactly one asset, so the
 * nearest preceding leg in that asset is the producer — is right. Reading it off
 * `asset` was what was wrong.
 */

import { describe, expect, it } from "vitest";
import { producedAsset } from "@/lib/copilot/workflow/types";
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
  obs("e1", "wallet_balances", {
    assets: [
      { symbol: "XLM", balance: "10206.8356118", status: "ok" },
      { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" },
      { symbol: "AQUSDC", balance: "0.0000000", decimals: 7, status: "ok" },
    ],
    fee_reserve_xlm: "0.5",
  }),
  obs("e2", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  obs("e6", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }),
  // A borrow's carry cannot be judged without a supply rate to judge it against.
  obs("e4", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
  obs("e7", "blend_markets", {
    reserves: [
      { venue: "blend", symbol: "XLM", supply_apr_pct: "168.6342", borrow_apr_pct: "208.2203", utilization_pct: "89.99" },
    ],
  }),
];

const ctx = () => ({
  scope: SCOPE,
  observations: OBSERVATIONS,
  now: NOW,
  messages: ["swap 100 XLM to AQUSDC and add it as liquidity"],
  capacity: { grossCollateralUsd: "6605.84", debtUsd: "5102.54", floor: "1.2" },
  borrowing: "allowed" as const,
  comparisons: compareObservedRates(OBSERVATIONS, NOW),
});

const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({
  title: "Swap then add liquidity",
  rationale: "Swap then add liquidity because e1/e2.",
  evidenceIds: ["e1", "e2"],
  legs,
});

describe("producedAsset — what a leg hands on", () => {
  it("reads a swap's output, not its input", () => {
    expect(producedAsset({ op: "swap", asset: "XLM", assetOut: "AQUSDC" })).toBe("AQUSDC");
  });

  /**
   * `add_liquidity` sits in `ASSET_OUT_OPS` beside swap, but that list answers a
   * different question — may this leg name a second asset. An LP add consumes both
   * tokens and leaves a receipt, so treating it as a producer of its paired token
   * would be the opposite of what it does.
   */
  it("says an LP add produces no spendable token", () => {
    expect(producedAsset({ op: "add_liquidity", asset: "XLM", assetOut: "AQUSDC" })).toBeNull();
  });

  it("is the leg's own asset for an ordinary op", () => {
    expect(producedAsset({ op: "borrow", asset: "BLUSDC" })).toBe("BLUSDC");
    expect(producedAsset({ op: "redeem", asset: "XLM" })).toBe("XLM");
  });
});

describe("THE LIVE BUG: a swap's output was invisible to the leg after it", () => {
  const swapThenLp = () =>
    resolvePlans([plan([
      { op: "swap", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "literal", amount: "100", sourceQuote: "swap 100 XLM" } },
      { op: "add_liquidity", asset: "AQUSDC", sizing: { kind: "previous_leg" } },
    ])], ctx());

  /**
   * The scan now finds the swap. What it then says about it is a separate, deliberate
   * rule — a swap fills at the pool's price, so the amount it buys is a quote, not a
   * receipt — but the reason given must describe the real obstacle. Claiming no such
   * leg exists, when leg 1 produces exactly that asset, sends the user looking for a
   * leg they already wrote.
   */
  it("no longer claims there is no preceding leg in that asset", () => {
    const { rejected } = swapThenLp();
    for (const entry of rejected) {
      expect(entry.reason).not.toMatch(/needs a preceding leg in the same asset/i);
    }
  });

  it("names the swap when it refuses, rather than a leg that is not missing", () => {
    const { candidates, rejected } = swapThenLp();
    if (candidates.length > 0) return; // bound outright — nothing to explain
    expect(rejected[0]?.reason).toMatch(/swap/i);
  });
});

describe("a non-swap producer still binds", () => {
  it("binds a borrow to the leg that spends it", () => {
    // A literal amount must appear in the user's own words, so the message says it.
    const { candidates, rejected } = resolvePlans([plan([
      { op: "borrow", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "borrow 10 XLM" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], { ...ctx(), messages: ["borrow 10 XLM and supply it to blend"] });
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
  });
});
