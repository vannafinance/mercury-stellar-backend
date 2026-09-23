/**
 * 23 Sep, S5: "swap 100 XLM to USDC" compiled to AQUSDC, a variant the user never chose.
 * Bare "USDC" is three tokens (registry header), so a plan leg in one variant stands only if
 * the user named that variant, by any of its registry aliases.
 */
import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import { mentionsBareUsdc, namesAsset } from "@/lib/copilot/registry/assets";
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
    { symbol: "XLM", balance: "100", status: "ok" }, { symbol: "XLM_SAC", balance: "100", decimals: 7, status: "ok" },
    { symbol: "BLUSDC", balance: "680", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
  obs("e3", "earn_market", { supply_apr_pct: "19.16", borrow_apr_pct: "25", utilization_pct: "80" }, { asset: "BLUSDC" }),
];
const lendBlusdc: ProposedPlan = { title: "Lend BLUSDC", rationale: "r", evidenceIds: ["e1"], legs: [{ op: "lend", asset: "BLUSDC", sizing: { kind: "all_idle" } }] };
const run = (messages: string[]) => resolvePlans([lendBlusdc], {
  scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages,
  capacity: null, borrowing: "forbidden", comparisons: compareObservedRates(OBSERVATIONS, NOW),
});
const QUESTION = /without saying which one: BLUSDC, AQUSDC, SOUSDC\?/;

describe("a USDC the user never chose", () => {
  it("is asked back when the user said only USDC", () => {
    const { candidates, rejected } = run(["lend my USDC to earn"]);
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toMatch(QUESTION);
  });

  it("stands when the user named the variant, by symbol or by alias", () => {
    expect(run(["lend my BLUSDC to earn"]).candidates).toHaveLength(1);
    expect(run(["lend my Blend USDC to earn"]).candidates).toHaveLength(1);
  });

  it("does not touch a request that never said USDC", () => {
    expect(run(["lend everything idle to earn"]).candidates).toHaveLength(1);
  });

  it("stands once a later turn names the variant", () => {
    expect(run(["lend my USDC to earn", "blusdc"]).candidates).toHaveLength(1);
  });
});

describe("reading USDC names out of a sentence", () => {
  it("finds a bare USDC beside other assets, never inside a variant name", () => {
    expect(mentionsBareUsdc("swap 100 XLM to USDC")).toBe(true);
    expect(mentionsBareUsdc("swap 100 XLM to AQUSDC")).toBe(false);
    expect(mentionsBareUsdc("supply my Blend USDC")).toBe(false);
    expect(namesAsset("supply my Blend USDC", "BLUSDC")).toBe(true);
    expect(namesAsset("swap 100 XLM to USDC", "AQUSDC")).toBe(false);
  });
});
