/**
 * A reserve the user states is kept out of every plan.
 *
 * 23 Sep, XS7: "optimize my portfolio for yield but keep 100 XLM liquid", then "blend". The
 * constraint was in the request history, and an all-idle XLM leg deposited all 2152.29 XLM,
 * because nothing structured carried "keep 100 XLM" to the sizer.
 */
import { describe, expect, it } from "vitest";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import { holdingsAfterReserves, idleWalletAfterReserves, idleWalletHoldingsFrom } from "@/lib/copilot/investigation/candidates";
import { anchoredWalletReserves } from "@/lib/copilot/investigation/floor";
import { parseDecision } from "@/lib/copilot/investigation/decision";
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
    { symbol: "BLUSDC", balance: "0.0000000", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  obs("e3", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
  obs("e4", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
  obs("e6", "blend_markets", { reserves: [
    { venue: "blend", symbol: "XLM", supply_apr_pct: "168.6342", borrow_apr_pct: "208.2203", utilization_pct: "89.99" },
  ] }),
];
const CAPACITY = { grossCollateralUsd: "6605.84", debtUsd: "5102.54", floor: "1.2" };
const ctx = (over: Partial<Parameters<typeof resolvePlans>[1]> = {}) => ({
  scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages: ["deploy my XLM in farm but keep 100 XLM liquid, HF above 1.2"],
  capacity: CAPACITY, borrowing: "allowed" as const, comparisons: compareObservedRates(OBSERVATIONS, NOW), ...over,
});
const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({ title: "Move idle XLM into Blend", rationale: "Because e1/e6.", evidenceIds: ["e1", "e6"], legs });
const intoBlend = plan([
  { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
  { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
]);

describe("the sizer never spends into a stated reserve", () => {
  it("sizes 'all idle' to the balance less the reserve", () => {
    const { candidates, rejected } = resolvePlans([intoBlend], ctx({ walletReserves: [{ asset: "XLM", amount: "100" }] }));
    expect(rejected).toEqual([]);
    // 10206.3356118 spendable (fee reserve already left) − 100 kept.
    expect(candidates[0].steps?.map((s) => [s.op, s.amount])).toEqual([
      ["deposit_collateral", "10106.3356118"], ["supply_blend", "10106.3356118"],
    ]);
  });

  it("leaves the plan exactly as before when no reserve was stated", () => {
    const { candidates } = resolvePlans([intoBlend], ctx());
    expect(candidates[0].steps?.[0].amount).toBe("10206.3356118");
  });

  it("refuses a stated amount that reaches into the reserve, and names the reserve", () => {
    const { rejected } = resolvePlans([plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10200", sourceQuote: "deposit 10200 XLM" } },
    ])], ctx({ messages: ["deposit 10200 XLM but keep 100 XLM liquid"], walletReserves: [{ asset: "XLM", amount: "100" }] }));
    expect(rejected[0]?.reason).toContain("after the 100 XLM you asked to keep");
  });

  it("says the reserve is why, when it covers the whole balance", () => {
    const { rejected } = resolvePlans([intoBlend], ctx({ walletReserves: [{ asset: "XLM", amount: "20000" }] }));
    expect(rejected[0]?.reason).toContain("inside the 20000 XLM you asked to keep");
  });

  it("gives the fixed shapes the same smaller balance", () => {
    const after = idleWalletAfterReserves(OBSERVATIONS, NOW, [{ asset: "XLM", amount: "100" }]);
    expect(after.idleWalletByAssetTokens.XLM).toBe("10106.3356118");
    const before = idleWalletHoldingsFrom(OBSERVATIONS, NOW);
    expect(holdingsAfterReserves(before, undefined)).toBe(before);
  });
});

describe("a reserve counts only when the user wrote it", () => {
  const goal = (rows: { asset: string; amount: string; sourceQuote: string }[]) => ({ walletReserves: rows });

  it("keeps a reserve quoted from an earlier turn", () => {
    expect(anchoredWalletReserves(goal([{ asset: "XLM", amount: "100", sourceQuote: "keep 100 XLM liquid" }]),
      ["optimize my portfolio for yield but keep 100 XLM liquid", "blend"])).toEqual([{ asset: "XLM", amount: "100" }]);
  });

  it("drops a reserve whose quote the user never wrote", () => {
    expect(anchoredWalletReserves(goal([{ asset: "XLM", amount: "100", sourceQuote: "keep 100 XLM aside" }]),
      ["optimize my portfolio for yield"])).toEqual([]);
  });

  it("keeps the larger amount when one token is named twice", () => {
    expect(anchoredWalletReserves(goal([
      { asset: "XLM", amount: "50", sourceQuote: "keep 50 XLM" },
      { asset: "XLM", amount: "100", sourceQuote: "actually keep 100 XLM" },
    ]), ["keep 50 XLM", "actually keep 100 XLM"])).toEqual([{ asset: "XLM", amount: "100" }]);
  });
});

describe("the decision parser accepts only well-formed reserves", () => {
  const decision = (walletReserves: unknown) => parseDecision({
    kind: "research_complete",
    goal: { objective: "Earn yield", constraints: [], borrowing: "forbidden", walletReserves },
    findings: [{ summary: "Blend pays more on XLM.", evidenceIds: ["e6"] }],
    openQuestions: [],
  });

  it("keeps a valid row and drops the malformed ones beside it", () => {
    const parsed = decision([
      { asset: "XLM", amount: "100", sourceQuote: "keep 100 XLM liquid" },
      { asset: "XLM", amount: "100", sourceQuote: "keep some XLM" }, // quote lacks the number
      { asset: "NOTATOKEN", amount: "5", sourceQuote: "keep 5 NOTATOKEN" },
    ]);
    expect(parsed?.kind).toBe("research_complete");
    if (parsed?.kind !== "research_complete") return;
    expect(parsed.goal.walletReserves).toEqual([{ asset: "XLM", amount: "100", sourceQuote: "keep 100 XLM liquid" }]);
  });

  it("does not void the research when the field is garbage", () => {
    const parsed = decision("keep 100");
    expect(parsed?.kind).toBe("research_complete");
    if (parsed?.kind === "research_complete") expect(parsed.goal.walletReserves).toBeUndefined();
  });
});
