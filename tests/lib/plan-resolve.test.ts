/**
 * Model proposes, code disposes — `plan.ts`.
 *
 * ## The live failure this pins
 *
 * 13 Sep, signed in: *"Create a strategy so my HF stays above 1.1, use USDC and XLM as
 * collateral and deploy them in farm."* The model understood it, fetched the right reads,
 * and then the strategy layer — three hand-written shapes — produced an empty card. The
 * model had no channel to say "deposit the idle XLM, then supply it to Blend".
 *
 * These tests give it that channel and prove the boundary held: the model contributes
 * shapes and sizing WORDS; every number below is derived from a read, the user's own quoted
 * amount, or the closed-form sizer against the user's floor, and every leg that does not
 * fit is rejected with a sentence the user can read.
 */

import { describe, expect, it } from "vitest";
import { resolvePlans, planCandidateId, withSharedLiteralAmount } from "@/lib/copilot/investigation/plan";
import { mergeCandidateSets, generateCandidates } from "@/lib/copilot/investigation/candidates";
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

/** The 13 Sep account, as read: 10,206 idle XLM, no idle USDC-family, testnet Blend XLM at 168.6% APR. */
const OBSERVATIONS: Observation[] = [
  obs("e1", "wallet_balances", { assets: [
    // As the MCP reports them: every SAC line carries the contract's decimals; XLM_SAC speaks for native XLM.
    { symbol: "XLM", balance: "10206.8356118", status: "ok" },
    { symbol: "USDC", status: "not_resolvable", balance: null },
    { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" },
    { symbol: "AQUSDC", balance: "0.0000000", decimals: 7, status: "ok" },
    { symbol: "BLUSDC", balance: "0.0000000", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" }),
  obs("e2", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  obs("e3", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
  obs("e4", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
  obs("e5", "earn_market", { supply_apr_pct: "29.08", borrow_apr_pct: "32.47", utilization_pct: "89.57" }, { asset: "BLUSDC" }),
  obs("e6", "blend_markets", { reserves: [
    { venue: "blend", symbol: "XLM", supply_apr_pct: "168.6342", borrow_apr_pct: "208.2203", utilization_pct: "89.99" },
    { venue: "blend", symbol: "USDC", supply_apr_pct: "0.9035", borrow_apr_pct: "1.3081", utilization_pct: "76.75" },
  ] }),
];
const CAPACITY = { grossCollateralUsd: "6605.84", debtUsd: "5102.54", floor: "1.2" };

function ctx(over: Partial<Parameters<typeof resolvePlans>[1]> = {}) {
  return {
    scope: SCOPE, observations: OBSERVATIONS, now: NOW, messages: ["deploy my XLM in farm, HF above 1.2"],
    capacity: CAPACITY, borrowing: "allowed" as const, comparisons: compareObservedRates(OBSERVATIONS, NOW), ...over,
  };
}
const plan = (title: string, legs: ProposedPlan["legs"]): ProposedPlan => ({ title, rationale: `${title} because e1/e6.`, evidenceIds: ["e1", "e6"], legs });

describe("resolvePlans — the 13 Sep prompt gets its options", () => {
  it("sizes 'deposit idle XLM, supply it to Blend' from the wallet read, allowlists both steps", () => {
    const { candidates, rejected } = resolvePlans([plan("Move idle XLM into Blend", [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], ctx());
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.id).toBe("composed:dc.XLM+sb.XLM");
    expect(c.kind).toBe("composed");
    expect(c.label).toBe("Move idle XLM into Blend");
    expect(c.rationale).toContain("e1/e6");
    expect(c.borrows).toBe(false);
    expect(c.venue).toBe("blend");
    // 10,206.34 XLM × $0.18 — the fee reserve is left in the wallet.
    expect(c.steps?.map((s) => [s.op, s.asset, s.amount, s.tool])).toEqual([
      ["deposit_collateral", "XLM", "10206.3356118", "vanna_deposit_collateral"],
      ["supply_blend", "XLM", "10206.3356118", "vanna_blend_supply"],
    ]);
    expect(c.steps?.[0].args).toEqual({ smart_account: SCOPE.smartAccount, symbol: "XLM", amount: "10206.3356118", trader: SCOPE.trader });
    expect(Number(c.amountUsd)).toBeCloseTo(1837.14, 1);
    // (6605.84 + 1837.14) / 5102.54 — the deposit raises collateral; Blend supply is HF-neutral.
    expect(Number(c.finalHealthFactor)).toBeCloseTo(1.6546, 3);
    expect(c.supplyAprPct).toBe("168.6342");
    expect(c.netAprPct).toBeNull();
    expect(c.heldAmount).toBe("10206.3356118");
    expect(c.evidenceIds).toEqual(["e1", "e6"]);
  });

  it("rejects an exact-output swap on Aquarius with no live pool reserves read, rather than guessing a ratio", () => {
    const result = resolvePlans([plan("Receive AQUSDC", [{
      op: "swap",
      asset: "XLM",
      assetOut: "AQUSDC",
      sizing: {
        kind: "literal",
        amount: "961.4183674",
        sourceQuote: "swap XLM to receive 961.4183674 AQUSDC",
        amountAsset: "assetOut",
      },
    }])], ctx({
      messages: ["swap XLM to receive 961.4183674 AQUSDC"],
      observations: [...OBSERVATIONS, obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" })],
    }));
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("no live aquarius pool reserves were read this investigation, so an exact AQUSDC amount cannot be sized");
  });

  it("rejects an exact-output swap on Soroswap the same way when that pool was not read", () => {
    const result = resolvePlans([plan("Receive SOUSDC", [{
      op: "swap",
      asset: "XLM",
      assetOut: "SOUSDC",
      sizing: {
        kind: "literal",
        amount: "961.4183674",
        sourceQuote: "swap XLM to receive 961.4183674 SOUSDC",
        amountAsset: "assetOut",
      },
    }])], ctx({
      messages: ["swap XLM to receive 961.4183674 SOUSDC"],
      observations: [...OBSERVATIONS, obs("e7", "asset_price", { price_usd: "1" }, { asset: "SOUSDC" })],
    }));
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.reason).toBe(
      "no live soroswap pool reserves were read this investigation, so an exact SOUSDC amount cannot be sized");
  });

  /**
   * The write API only ever takes amount_in and min_out — never a target output — so
   * "swap XLM to receive 961 AQUSDC" has to become an input amount before it can be sized
   * at all. On Aquarius, with live reserves read, that inversion is exact: the same
   * constant-product curve the pool settles by, solved for the input a given output costs.
   */
  describe("exact-output swaps on Aquarius are sized by inverting the pool's own curve", () => {
    const poolObs = obs("e7", "aquarius_pool_reserves",
      { found: true, pool: { available: true, reserves: { XLM: "100000", AQUSDC: "20000" }, total_share: "40000", fee: "0.0030" } },
      { asset: "AQUSDC" });
    const exactOutLeg = (amount: string, sourceQuote: string): ProposedPlan["legs"] => [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "swap", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "literal", amount, sourceQuote, amountAsset: "assetOut" } },
    ];

    it("sizes the input the pool's curve needs for the exact output asked for", () => {
      const { candidates, rejected } = resolvePlans([plan("Receive AQUSDC", exactOutLeg("100", "swap XLM to receive 100 AQUSDC"))], ctx({
        messages: ["deposit my idle XLM then swap XLM to receive 100 AQUSDC"],
        observations: [...OBSERVATIONS, obs("e7b", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }), poolObs],
      }));
      expect(rejected).toEqual([]);
      const swapStep = candidates[0]?.steps?.[1];
      // Input includes the quote buffer; the floor still enforces the 100 asked for.
      expect(Number(swapStep?.amount)).toBeCloseTo(506.5702, 3);
      expect(swapStep?.args.token_in).toBe("XLM");
      expect(swapStep?.args.token_out).toBe("AQUSDC");
      expect(swapStep?.args.min_out).toBe("100");
      expect(swapStep?.targetOut).toBe("100");
    });

    it("refuses when the pool cannot pay that much at all — the output is at or past its own reserve", () => {
      const { rejected } = resolvePlans([plan("Receive AQUSDC", exactOutLeg("20000", "swap XLM to receive 20000 AQUSDC"))], ctx({
        messages: ["deposit my idle XLM then swap XLM to receive 20000 AQUSDC"],
        observations: [...OBSERVATIONS, obs("e7b", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }), poolObs],
      }));
      expect(rejected[0]?.reason).toBe("the pool holds only 20000 AQUSDC — 20000 cannot be filled from it");
    });

    it("refuses when the account cannot fund the input the exact output actually costs", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "deposit 10 xlm" } },
        { op: "swap", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "previous_leg" } },
      ];
      // Force the funding gap with a direct literal swap instead: 10 XLM posted, but the
      // exact-output leg needs ~504 XLM (as sized above) — far more than is in the account.
      const direct = exactOutLeg("100", "swap XLM to receive 100 AQUSDC");
      const { rejected } = resolvePlans([plan("Receive AQUSDC", [legs[0], direct[1]])], ctx({
        messages: ["deposit 10 xlm then swap XLM to receive 100 AQUSDC"],
        observations: [...OBSERVATIONS, obs("e7b", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }), poolObs],
      }));
      expect(rejected[0]?.reason).toMatch(/^only 10 XLM is in the margin account after the legs before it — receiving 100 AQUSDC needs about 506/);
    });

    it("still refuses an exact-output request the price-impact guard would refuse as an ordinary swap", () => {
      // Reserves too thin for the output asked for: 100,000 XLM / 2,000 AQUSDC — the
      // input this costs (~2,572 XLM for 50 AQUSDC) still fits the wallet, so the funding
      // check passes and the price-impact guard is what actually catches it.
      const thin = obs("e7", "aquarius_pool_reserves",
        { found: true, pool: { available: true, reserves: { XLM: "100000", AQUSDC: "2000" }, total_share: "4000", fee: "0.0030" } },
        { asset: "AQUSDC" });
      const { rejected } = resolvePlans([plan("Receive AQUSDC", exactOutLeg("50", "swap XLM to receive 50 AQUSDC"))], ctx({
        messages: ["deposit my idle XLM then swap XLM to receive 50 AQUSDC"],
        observations: [...OBSERVATIONS, obs("e7b", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }), thin],
      }));
      expect(rejected[0]?.reason).toMatch(/^this pool is too thin for/);
    });
  });

  it("sizes 'borrow XLM to the floor, supply it to Blend' with the closed-form sizer and reports the carry", () => {
    const { candidates, rejected } = resolvePlans([plan("Lever XLM into Blend", [
      { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], ctx());
    expect(rejected).toEqual([]);
    const c = candidates[0];
    expect(c.borrows).toBe(true);
    expect(c.amountBasis).toBe("derived_max_at_floor");
    /**
     * A derived max is sized one basis point INSIDE the floor (`FLOOR_MARGIN_BPS` in
     * sizing.ts), so this lands at 1.20012 rather than exactly 1.2 — the fix for a plan
     * sized to a floor being refused by that same floor the instant anything moved
     * before the write re-validated it. The closed form in the comment below is still
     * the right shape; it is now solved against floor*(1+1bps), not floor itself.
     */
    // x = (G − F'·D)/(F' − 1), F' = 1.2 + 1.2×1bps = (6605.84 − 1.20012·5102.54)/0.20012
    expect(Number(c.amountUsd)).toBeCloseTo(2409.45, 2);
    expect(Number(c.steps?.[0].amount)).toBeCloseTo(13385.85, 1);
    expect(c.steps?.[1].amount).toBe(c.steps?.[0].amount);
    expect(Number(c.finalHealthFactor)).toBeCloseTo(1.20012, 5);
    // 168.63% Blend supply − 8% Earn XLM borrow.
    expect(Number(c.netAprPct)).toBeCloseTo(160.63, 1);
  });

  /**
   * 15 Sep, live: "deposit 10 xlm and borrow with 6x leverage in such a way that my HF >
   * 1.19" borrowed 315,491.90 XLM — the amount `to_floor` produces on the account's
   * pre-existing collateral — because there was no way to state "6x" at all. The model
   * had a floor to fall back to and silently substituted it for the leverage the user
   * actually asked for, with no warning that the 6x had been dropped.
   */
  describe("leverage sizing — a stated multiple, not a silent substitute for the floor", () => {
    it("sizes the borrow to the deposit before it times (multiple − 1), same asset", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "deposit 10 xlm" } },
        { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "6", sourceQuote: "borrow with 6x leverage" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ];
      const { candidates, rejected } = resolvePlans([plan("6x leverage", legs)], ctx({
        messages: ["deposit 10 xlm and borrow with 6x leverage in such a way that my HF > 1.19, deploy in farm"],
      }));
      expect(rejected).toEqual([]);
      // borrow = 10 × (6 − 1) = 50 XLM — not the ~315,491.90 the pre-existing collateral's to_floor produced live.
      expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([
        ["deposit_collateral", "10"], ["borrow", "50"], ["supply_blend", "50"],
      ]);
    });

    it("prices the borrow in the borrowed asset when it differs from the deposit's", () => {
      // Deposit BLUSDC; leverage borrows XLM instead — XLM is also the asset with a
      // profitable Blend carry in this fixture, so the borrow can be covered by a supply.
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "BLUSDC", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 BLUSDC" } },
        { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "3", sourceQuote: "borrow XLM at 3x" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ];
      const fundedBlusdc = OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
        { symbol: "XLM", balance: "10206.8356118", status: "ok" }, { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" },
        { symbol: "BLUSDC", balance: "300", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" }));
      const { candidates, rejected } = resolvePlans([plan("Cross-asset leverage", legs)], ctx({
        observations: fundedBlusdc, messages: ["deposit 100 BLUSDC and borrow XLM at 3x, deploy in farm"],
      }));
      expect(rejected).toEqual([]);
      // Equity: 100 BLUSDC × $1 = $100. Borrow: $100 × (3 − 1) = $200, at $0.18/XLM ≈ 1111.1111111 XLM.
      expect(candidates[0]?.steps?.map((s) => [s.op, s.asset, s.amount])).toEqual([
        ["deposit_collateral", "BLUSDC", "100"], ["borrow", "XLM", "1111.1111111"], ["supply_blend", "XLM", "1111.1111111"],
      ]);
    });

    it("sizes correctly from a decimal deposit amount", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "19.555", sourceQuote: "deposit 19.555 xlm" } },
        { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "3", sourceQuote: "3x leverage" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ];
      const { candidates, rejected } = resolvePlans([plan("Decimal leverage", legs)], ctx({
        messages: ["deposit 19.555 xlm at 3x leverage, deploy in farm"],
      }));
      expect(rejected).toEqual([]);
      // 19.555 × (3 − 1) = 39.11 exactly.
      expect(candidates[0]?.steps?.[1]).toMatchObject({ op: "borrow", amount: "39.11" });
    });

    it("refuses a leverage multiple that would take the health factor below the stated floor, naming it as such", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "deposit 10 xlm" } },
        { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "50", sourceQuote: "50x leverage" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ];
      /**
       * The protocol's own gross-asset model — borrowed funds enter the account and raise
       * BOTH collateral and debt — means HF from a zero base is 1 + 1/(multiple − 1), not
       * something that crashes toward zero with ordinary leverage: 6x alone lands exactly
       * at 1.2, still above a 1.19 floor. 50x (HF → 1.0204) is unambiguously the case this
       * check exists for, without depending on rounding at the edge of the floor.
       */
      const { candidates, rejected } = resolvePlans([plan("Unsafe leverage", legs)], ctx({
        messages: ["deposit 10 xlm and borrow with 50x leverage, deploy in farm"],
        capacity: { grossCollateralUsd: "0", debtUsd: "0", floor: "1.19" },
      }));
      expect(candidates).toEqual([]);
      expect(rejected[0]?.reason).toMatch(/^this would take the health factor below your floor/);
    });

    it("refuses leverage sizing with no preceding deposit to multiply", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "6", sourceQuote: "6x leverage" } },
      ];
      const { rejected } = resolvePlans([plan("No deposit", legs)], ctx({ messages: ["borrow XLM at 6x leverage"] }));
      expect(rejected[0]?.reason).toMatch(/needs the deposit that funds it stated before/);
    });

    it("refuses a leverage multiple the model did not actually anchor in the user's words", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "deposit 10 xlm" } },
        { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "6", sourceQuote: "borrow with 6x leverage" } },
      ];
      // The quote itself is missing from the message — an invented sourceQuote.
      const { rejected } = resolvePlans([plan("Hallucinated leverage", legs)], ctx({ messages: ["deposit 10 xlm and take on some debt"] }));
      expect(rejected[0]?.reason).toMatch(/does not appear in your request/);
    });
  });

  /**
   * 15 Sep: the developer's own suggestion — fetch the pool's live reserves from Aquarius's
   * public AMM API rather than trust the model's guess at a ratio, or the contract's own
   * on-chain correction (Soroswap) where no such read exists yet. `asset` is whichever side
   * the user stated an amount for, exactly the same "spent" convention swap uses; the other
   * side and the LP-share floor are both derived from the pool's own reserves, never priced
   * off an oracle.
   */
  describe("add_liquidity — Aquarius sizes the paired amount from live reserves, Soroswap is refused", () => {
    // Reserves 1000 XLM / 200 AQUSDC (a 5:1 ratio), 100 total LP shares outstanding.
    const RESERVES_OBS = obs("e7", "aquarius_pool_reserves",
      { found: true, pool: { available: true, reserves: { XLM: "1000", AQUSDC: "200" }, total_share: "100", fee: "0.0030" } },
      { asset: "AQUSDC" });

    it("sizes the paired AQUSDC amount and the LP-share floor off the pool's own reserves", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 xlm" } },
        { op: "add_liquidity", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "previous_leg" } },
      ];
      const { candidates, rejected } = resolvePlans([plan("Add XLM/AQUSDC liquidity", legs)], ctx({
        messages: ["deposit 100 xlm and add it with AQUSDC to the aquarius pool"],
        observations: [...OBSERVATIONS, RESERVES_OBS],
      }));
      expect(rejected).toEqual([]);
      const c = candidates[0];
      // 100 XLM x (200/1000) = 20 AQUSDC; LP shares 100 x (100/1000) = 10, floor at 0.5% slippage = 9.95.
      expect(c.steps?.map((s) => [s.op, s.asset, s.amount, s.tool])).toEqual([
        ["deposit_collateral", "XLM", "100", "vanna_deposit_collateral"],
        ["add_liquidity", "XLM", "100", "vanna_add_liquidity"],
      ]);
      expect(c.steps?.[1].args).toEqual({
        smart_account: SCOPE.smartAccount, token_a: "XLM", token_b: "AQUSDC",
        amount_a: "100", amount_b: "20", min_liquidity_out: "9.95",
        trader: SCOPE.trader, venue: "aquarius",
      });
      expect(c.steps?.[1].label).toBe("Add 100 XLM + 20 AQUSDC to the Aquarius pool");
    });

    it("can still size an LP deposit when swaps, but not deposits, are paused", () => {
      const pausedSwap = obs("e7", "aquarius_pool_reserves",
        { found: true, pool: { available: true, reserves_source: "soroban_balance", swap_killed: true, deposit_killed: false,
          reserves: { XLM: "1000", AQUSDC: "200" }, total_share: "100", fee: "0.0030" } }, { asset: "AQUSDC" });
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 xlm" } },
        { op: "add_liquidity", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "previous_leg" } },
      ];
      const { candidates, rejected } = resolvePlans([plan("Add Aquarius liquidity", legs)], ctx({
        messages: ["deposit 100 xlm and add liquidity with AQUSDC"], observations: [...OBSERVATIONS, pausedSwap],
      }));
      expect(rejected).toEqual([]);
      expect(candidates[0]?.steps?.[1].args.amount_b).toBe("20");
    });

    /**
     * The MCP's own tool takes token_a/amount_a as a pair — the amount must never be
     * assigned to a different token than the one the user actually stated. A first pass at
     * this always hardcoded token_a to "XLM", which mislabeled the amount whenever the user
     * named the paired token instead (and collided token_b with token_a, since both would
     * read "XLM"). Deposit AQUSDC here — the opposite order from the test above — to prove
     * the fix, not just the common case.
     */
    it("keeps the stated token and its amount paired correctly when the paired asset is stated, not XLM", () => {
      const fundedAqusdc = OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
        { symbol: "XLM", balance: "10206.8356118", status: "ok" }, { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" },
        { symbol: "AQUSDC", balance: "50.0000000", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" }));
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "AQUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "deposit 20 AQUSDC" } },
        { op: "add_liquidity", asset: "AQUSDC", assetOut: "XLM", sizing: { kind: "previous_leg" } },
      ];
      const { candidates, rejected } = resolvePlans([plan("Add AQUSDC/XLM liquidity", legs)], ctx({
        messages: ["deposit 20 AQUSDC and add it with XLM to the aquarius pool"],
        observations: [...fundedAqusdc, obs("e8", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }), RESERVES_OBS],
      }));
      expect(rejected).toEqual([]);
      // 20 AQUSDC x (1000/200) = 100 XLM; LP shares 20 x (100/200) = 10, floor at 0.5% slippage = 9.95.
      expect(candidates[0]?.steps?.[1].args).toEqual({
        smart_account: SCOPE.smartAccount, token_a: "AQUSDC", token_b: "XLM",
        amount_a: "20", amount_b: "100", min_liquidity_out: "9.95",
        trader: SCOPE.trader, venue: "aquarius",
      });
    });

    /**
     * Soroswap was refused outright while it had no reserves read and the MCP sent the
     * LP floor as WAD — a floor it could not size honestly, on a field that reverted
     * every add that carried one. `vanna_get_soroswap_pool_stats` answers reserves, fee
     * and total_share in the Aquarius envelope now, and the MCP sends the floor at the
     * tokens' scale, so the same arithmetic serves both venues.
     */
    const SOROSWAP_RESERVES_OBS = obs("e7", "soroswap_pool_reserves",
      { found: true, pool: { available: true, reserves: { XLM: "1000", SOUSDC: "200" }, total_share: "100", fee: "0.0030" } },
      { asset: "SOUSDC" });

    it("sizes a Soroswap add the same way it sizes an Aquarius one", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 xlm" } },
        { op: "add_liquidity", asset: "XLM", assetOut: "SOUSDC", sizing: { kind: "previous_leg" } },
      ];
      // The wallet read is where every protocol token's on-chain precision comes from,
      // so the paired side has to appear in it for its amount to be cut to its decimals.
      const withSousdc = OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
        { symbol: "XLM", balance: "10206.8356118", status: "ok" }, { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" },
        { symbol: "SOUSDC", balance: "50.0000000", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" }));
      const { candidates, rejected } = resolvePlans([plan("Add XLM/SOUSDC liquidity", legs)], ctx({
        messages: ["deposit 100 xlm and add it with SOUSDC to the soroswap pool"],
        observations: [...withSousdc, obs("e8", "asset_price", { price_usd: "1" }, { asset: "SOUSDC" }), SOROSWAP_RESERVES_OBS],
      }));
      expect(rejected).toEqual([]);
      // Same formula as Aquarius: 100 XLM x (200/1000) = 20 SOUSDC paired; LP shares
      // 100 x (100/1000) = 10, floor at 0.5% slippage = 9.95.
      expect(candidates[0]?.steps?.[1].args).toEqual({
        smart_account: SCOPE.smartAccount, token_a: "XLM", token_b: "SOUSDC",
        amount_a: "100", amount_b: "20", min_liquidity_out: "9.95",
        trader: SCOPE.trader, venue: "soroswap",
      });
    });

    it("refuses a Soroswap add when its pool was not read — never the Aquarius pool's numbers", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "add_liquidity", asset: "XLM", assetOut: "SOUSDC", sizing: { kind: "literal", amount: "100", sourceQuote: "add 100 xlm" } },
      ];
      const { candidates, rejected } = resolvePlans([plan("Add XLM/SOUSDC liquidity", legs)], ctx({
        messages: ["add 100 xlm with SOUSDC to the pool"],
        // The Aquarius pool IS read here; the Soroswap one is not.
        observations: [...OBSERVATIONS, obs("e8", "asset_price", { price_usd: "1" }, { asset: "SOUSDC" }), RESERVES_OBS],
      }));
      expect(candidates).toEqual([]);
      expect(rejected[0]?.reason).toBe(
        "no live soroswap pool reserves were read this investigation, so the paired amount cannot be sized against the real ratio");
    });

    it("refuses an add_liquidity leg with no paired token named", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "add_liquidity", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "add 100 xlm to the pool" } },
      ];
      const { rejected } = resolvePlans([plan("Add liquidity", legs)], ctx({ messages: ["add 100 xlm to the pool"] }));
      expect(rejected[0]?.reason).toBe("name the token XLM is paired with — AQUSDC for Aquarius");
    });

    it("refuses an add_liquidity leg paired with the same token", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "add_liquidity", asset: "XLM", assetOut: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "add 100 xlm to the pool" } },
      ];
      const { rejected } = resolvePlans([plan("Add liquidity", legs)], ctx({ messages: ["add 100 xlm to the pool"] }));
      expect(rejected[0]?.reason).toBe("a pool needs two different tokens — XLM and XLM is the same token");
    });

    it("refuses Aquarius add_liquidity with no live reserves read this investigation", () => {
      const legs: ProposedPlan["legs"] = [
        { op: "add_liquidity", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "literal", amount: "100", sourceQuote: "add 100 xlm to AQUSDC pool" } },
      ];
      const { rejected } = resolvePlans([plan("Add liquidity", legs)], ctx({ messages: ["add 100 xlm to AQUSDC pool"] }));
      expect(rejected[0]?.reason).toBe("no live aquarius pool reserves were read this investigation, so the paired amount cannot be sized against the real ratio");
    });
  });

  /**
   * 15 Sep, live: "swap 1k xlm to AQUSDC" was refused by the DEX itself (HostError #2006)
   * and the user saw a bare contract code. The floor had been priced at ORACLE PARITY —
   * the USD value of the XLM converted at the oracle's AQUSDC price — while the pool fills
   * on its own curve, after its own fee, at whatever its reserves say. When the pool's
   * price sits below the oracle's, that floor is one the pool can never meet.
   */
  describe("a swap's floor is quoted against the pool it settles on, not the oracle", () => {
    const poolObs = (xlm: string, aqusdc: string) => obs("e8", "aquarius_pool_reserves",
      { found: true, pool: { available: true, reserves: { XLM: xlm, AQUSDC: aqusdc }, total_share: "40000", fee: "0.0030" } },
      { asset: "AQUSDC" });
    const swapLegs: ProposedPlan["legs"] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "1000", sourceQuote: "swap 1000 XLM" } },
      { op: "swap", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "previous_leg" } },
    ];
    const swapCtx = (pool: Observation) => ctx({
      messages: ["swap 1000 XLM to AQUSDC on aquarius"],
      observations: [...OBSERVATIONS, obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }), pool],
    });

    it("prices the floor below oracle parity when the pool pays less than the oracle — the case the DEX refused", () => {
      // Pool: 100,000 XLM / 17,730 AQUSDC — pays a little under the oracle's 0.18, an
      // ordinary fee-and-spread cost rather than a thin-pool one.
      const { candidates, rejected } = resolvePlans([plan("Swap XLM", swapLegs)], swapCtx(poolObs("100000", "17730")));
      expect(rejected).toEqual([]);
      // out = 17730 x 997 / (100000 + 997) = 175.0231…, less 0.5% = 174.1480…
      const floor = Number(candidates[0]?.steps?.[1].args.min_out);
      expect(floor).toBeCloseTo(174.148, 3);
      // Oracle parity would have demanded 1000 x $0.18 / $1 = 180, less 0.5% = 179.1 — a
      // floor above anything this pool pays, which is exactly what the DEX refused.
      expect(floor).toBeLessThan(179.1);
    });

    it("prices the floor above oracle parity when the pool pays more, rather than capping it at the oracle", () => {
      // Pool: 100,000 XLM / 20,000 AQUSDC — 0.20 AQUSDC per XLM, better than the oracle's 0.18.
      const { candidates, rejected } = resolvePlans([plan("Swap XLM", swapLegs)], swapCtx(poolObs("100000", "20000")));
      expect(rejected).toEqual([]);
      // out = 20000 x 997 / (100000 + 997) = 197.4316…, less 0.5% = 196.4444…
      const floor = Number(candidates[0]?.steps?.[1].args.min_out);
      expect(floor).toBeCloseTo(196.4444, 3);
      expect(floor).toBeGreaterThan(179.1);
    });

    /**
     * `acknowledged_price_impact` tells MCP a human was shown this fill and took it, and
     * MCP drops its own 10% auto-sign gate on that word. Asserted on every swap it stops
     * being a word: the gate can never fire, and nothing server-side is left between a
     * fill far below fair value and a signature. So it rides on the same condition that
     * earned it — the user's own accepted loss — and on no other swap.
     */
    it("claims the price impact was acknowledged only when the user actually accepted it", () => {
      const pool = poolObs("100000", "17730");
      const silent = resolvePlans([plan("Swap XLM", swapLegs)], swapCtx(pool));
      expect(silent.candidates[0]?.steps?.[1].args).not.toHaveProperty("acknowledged_price_impact");

      const accepted = resolvePlans([plan("Swap XLM", swapLegs)], {
        ...swapCtx(pool),
        goal: { slippageAccepted: { accepted: true, sourceQuote: "i accept the loss" } },
      });
      expect(accepted.candidates[0]?.steps?.[1].args.acknowledged_price_impact).toBe(true);
    });

    it("charges the pool's own fee, so the floor is never above what the curve actually pays", () => {
      const free = obs("e8", "aquarius_pool_reserves",
        { found: true, pool: { available: true, reserves: { XLM: "100000", AQUSDC: "20000" }, total_share: "40000", fee: "0" } },
        { asset: "AQUSDC" });
      const { candidates } = resolvePlans([plan("Swap XLM", swapLegs)], swapCtx(free));
      // Same reserves, no fee: 20000 x 1000 / 101000 = 198.0198…, less 0.5% = 197.0297…
      expect(Number(candidates[0]?.steps?.[1].args.min_out)).toBeCloseTo(197.0297, 3);
    });

    /**
     * The live pool, 15 Sep, read from the AMM API: ~133,077 XLM against ~1,571 AQUSDC.
     * 1,000 XLM (~$190) quotes about 11.7 AQUSDC — a ~94% loss — and the website's own swap
     * card refuses exactly this with "this pool's liquidity is too thin for this trade
     * size". A pool-quoted floor is always meetable, so without this check the copilot
     * would have set an honest floor on a catastrophic fill and let it through.
     */
    it("refuses a fill far below what the spent asset is worth, as the site's own swap card does", () => {
      const { candidates, rejected } = resolvePlans([plan("Swap XLM", swapLegs)],
        swapCtx(poolObs("133076.9862876", "1571.5348824")));
      expect(candidates).toEqual([]);
      expect(rejected[0]?.reason).toMatch(/^this pool is too thin for 1000 XLM: it would fill at about 11\.68/);
      expect(rejected[0]?.reason).toContain("% below what XLM is worth");
      expect(rejected[0]?.reason).toMatch(/Swap a smaller amount/);
    });

    it("allows a spread just inside the threshold, rather than refusing every cost the pool charges", () => {
      // 100,000 XLM / 17,425 AQUSDC quotes ~172.01 against $180 of XLM — 4.4% down, under
      // the 5% the website blocks at. The guard is for thin pools, not for ordinary spread.
      const { candidates, rejected } = resolvePlans([plan("Swap XLM", swapLegs)], swapCtx(poolObs("100000", "17425")));
      expect(rejected).toEqual([]);
      expect(candidates).toHaveLength(1);
    });

    it("still sizes an Aquarius swap when the AMM API's swap_killed flag is set — the chain decides, not the flag", () => {
      const paused = obs("e8", "aquarius_pool_reserves",
        { found: true, pool: { available: true, reserves_source: "soroban_balance", swap_killed: true,
          reserves: { XLM: "100000", AQUSDC: "17730" }, total_share: "40000", fee: "0.0030" } },
        { asset: "AQUSDC" });
      const { candidates, rejected } = resolvePlans([plan("Swap XLM", swapLegs)], swapCtx(paused));
      expect(rejected).toEqual([]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.steps?.[1]).toMatchObject({ op: "swap", tool: "vanna_swap" });
      expect(Number(candidates[0]?.steps?.[1].args.min_out)).toBeCloseTo(174.148, 3);
    });

    it("refuses an Aquarius swap when no live pool reserves were read", () => {
      const { candidates, rejected } = resolvePlans([plan("Swap XLM", swapLegs)], ctx({
        messages: ["swap 1000 XLM to AQUSDC on aquarius"],
        observations: [...OBSERVATIONS, obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" })],
      }));
      expect(candidates).toEqual([]);
      expect(rejected[0]?.reason).toBe("the aquarius pool's live on-chain reserves were unavailable; the swap cannot be quoted safely");
    });
  });

  it("honours a literal amount only when it is anchored to the user's words", () => {
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }];
    const ok = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["please lend 100 XLM to earn"] }));
    expect(ok.candidates[0]?.steps).toEqual([expect.objectContaining({ op: "lend", amount: "100", args: { symbol: "XLM", amount: "100", lender: SCOPE.trader } })]);
    expect(ok.candidates[0]?.venue).toBe("earn");
    const bad = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["lend some XLM"] }));
    expect(bad.candidates).toEqual([]);
    expect(bad.rejected[0]).toEqual({ title: "Lend 100 XLM", leg: "lend XLM", reason: "the amount 100 does not appear in your request" });
  });

  it("applies one stated amount to every named Earn asset of the same lend", () => {
    const shared = withSharedLiteralAmount([plan("Lend 100 XLM", [
      { op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 xlm" } },
    ])], ["100 xlm and BLUSDC"]);
    expect(shared[0]?.legs.map((leg) => [leg.op, leg.asset, leg.sizing.kind === "literal" ? leg.sizing.amount : ""])).toEqual([
      ["lend", "XLM", "100"],
      ["lend", "BLUSDC", "100"],
    ]);
    const both = resolvePlans(shared, ctx({
      messages: ["100 xlm and BLUSDC"],
      observations: [
        ...OBSERVATIONS,
        obs("e-bl", "asset_price", { price_usd: "1" }, { asset: "BLUSDC" }),
        obs("e-blm", "earn_market", { supply_apr_pct: "4", borrow_apr_pct: "8", utilization_pct: "10" }, { asset: "BLUSDC" }),
      ],
    }));
    expect(both.rejected.some((entry) => /BLUSDC/.test(entry.leg ?? "") && /does not appear/.test(entry.reason))).toBe(false);

    const aqusdc = withSharedLiteralAmount([plan("Lend 100 XLM", [
      { op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 xlm" } },
    ])], ["100 xlm and AQUSDC"]);
    expect(aqusdc[0]?.legs.map((leg) => [leg.op, leg.asset, leg.sizing.kind === "literal" ? leg.sizing.amount : ""])).toEqual([
      ["lend", "XLM", "100"],
      ["lend", "AQUSDC", "100"],
    ]);
  });

  /**
   * A number in someone's words is not always a quantity of tokens. 15 Sep, live: "borrow
   * 2x aqusdc" was executed as a 2 AQUSDC borrow because the anchor compared raw digit
   * substrings, and "remove 10k xlm" was refused because `10000` is not the substring `10`.
   */
  it("reads a scale suffix as the quantity people mean by it", () => {
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "10000", sourceQuote: "lend 10k xlm" } }];
    const { candidates, rejected } = resolvePlans([plan("Lend 10k XLM", legs)], ctx({ messages: ["lend 10k xlm to earn"] }));
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.[0]).toMatchObject({ op: "lend", amount: "10000" });
  });

  it("refuses to read a leverage factor as a token amount", () => {
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "2", sourceQuote: "lend 2x xlm" } }];
    const { candidates, rejected } = resolvePlans([plan("Lend 2 XLM", legs)], ctx({ messages: ["lend 2x xlm"] }));
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe("the amount 2 does not appear in your request");
  });

  it("refuses to read a health-factor floor as a token amount", () => {
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "1.4", sourceQuote: "keep HF above 1.4" } }];
    const { candidates, rejected } = resolvePlans([plan("Lend 1.4 XLM", legs)], ctx({ messages: ["lend my xlm, keep HF above 1.4"] }));
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe("the amount 1.4 does not appear in your request");
  });

  it("still reads an amount written against its own symbol", () => {
    // "100xlm" — the leverage test stops at a letter boundary, so this stays an amount.
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100xlm" } }];
    const { candidates, rejected } = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["lend 100xlm to earn"] }));
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.[0]).toMatchObject({ op: "lend", amount: "100" });
  });

  it("accepts a literal Blend supply covered by the deposit before it (13 Sep: 'deposit 10000 XLM … deploy it in the Blend farm')", () => {
    const legs: ProposedPlan["legs"] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10000", sourceQuote: "Deposit 10000 XLM" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "10000", sourceQuote: "Deposit 10000 XLM" } },
    ];
    const { candidates, rejected } = resolvePlans([plan("Deposit XLM Collateral and Supply to Blend", legs)],
      ctx({ messages: ["Deposit 10000 XLM as collateral and deploy it in the Blend farm, keep my HF above 1.15"] }));
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount, s.tool])).toEqual([
      ["deposit_collateral", "10000", "vanna_deposit_collateral"],
      ["supply_blend", "10000", "vanna_blend_supply"],
    ]);
  });

  it.each([
    ["borrowing forbidden", { borrowing: "forbidden" as const }, [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }], "borrow XLM", "you said no new borrowing"],
    ["floor at the liquidation line", { capacity: { ...CAPACITY, floor: "1.1" } }, [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }], null, /floor at or below 1.1 is the liquidation line/],
    // 23 Sep (owner): "supply my idle XLM to Blend" is no longer refused; it becomes deposit +
    // supply, as a repay from idle already was. Pinned in idle-into-account-ops.test.ts.
    ["a literal Blend supply with nothing put in before it", { messages: ["supply 100 XLM to Blend"] }, [{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }], "supply blend XLM", /add that leg before it/],
    ["a literal Blend supply larger than the deposit before it", { messages: ["deposit 100 XLM and supply 200 XLM to Blend"] }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } }, { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "200", sourceQuote: "supply 200 XLM" } }], "supply blend XLM", "only 100 XLM is in the margin account after the legs before it"],
    ["nothing idle", {}, [{ op: "lend", asset: "AQUSDC", sizing: { kind: "all_idle" } }], "lend AQUSDC", "AQUSDC is not in the connected wallet"],
    ["previous_leg across assets", {}, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }, { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } }], "supply blend BLUSDC", /preceding leg in the same asset/],
    ["margin position not read", { capacity: null }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }], "deposit collateral XLM", /margin position was not read/],
    ["no margin account", { scope: { ...SCOPE, smartAccount: null } }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }], "deposit collateral XLM", /margin account is needed/],
    // 23 Sep: AQUA has no Earn pool, which is now the reason given for it (the registry is checked first).
    // The missing-price path is exercised with an asset that is held and has a pool, minus its price read.
    ["no price read", { observations: OBSERVATIONS.filter((o) => !(o.capability === "asset_price" && o.args.asset === "XLM")) }, [{ op: "lend", asset: "XLM", sizing: { kind: "all_idle" } }], "lend XLM", "no XLM price was read this investigation"],
    ["to_floor on a deposit", {}, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "to_floor" } }], "deposit collateral XLM", /only a withdraw or a borrow can be sized to the health-factor floor/],
  ])("rejects with a readable reason: %s", (_name, over, legs, leg, reason) => {
    const { candidates, rejected } = resolvePlans([plan("Try", legs as ProposedPlan["legs"])], ctx(over as Partial<Parameters<typeof resolvePlans>[1]>));
    expect(candidates).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].leg).toBe(leg);
    if (typeof reason === "string") expect(rejected[0].reason).toBe(reason);
    else expect(rejected[0].reason).toMatch(reason);
  });

  it("rejects a plan whose own floor is breached mid-sequence, naming the leg", () => {
    // Repay nothing, borrow to floor, then a second borrow of a literal amount would breach the floor.
    const { rejected } = resolvePlans([plan("Over-lever", [
      { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
      { op: "borrow", asset: "BLUSDC", sizing: { kind: "literal", amount: "500", sourceQuote: "borrow 500 BLUSDC" } },
    ])], ctx({ messages: ["borrow 500 BLUSDC too"] }));
    expect(rejected[0]).toMatchObject({ leg: "borrow BLUSDC", reason: expect.stringMatching(/^this would take the health factor below your floor; to fit at a 1.2 floor, add \$[\d.]+ of collateral/) });
  });

  it("treats the same shape proposed twice as one option, and gives each shape a stable id", () => {
    const shape: ProposedPlan["legs"] = [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }, { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } }];
    const { candidates } = resolvePlans([plan("A", shape), plan("B", shape)], ctx());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe("A");
    expect(planCandidateId(plan("anything", shape))).toBe("composed:dc.XLM+sb.XLM");
  });
});

describe("mergeCandidateSets — composed plans beside the fixed shapes", () => {
  it("dedupes a composed plan against the fixed shape it equals and keeps the rationale", () => {
    const fixed = generateCandidates({
      grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd, floor: CAPACITY.floor,
      idleWalletUsd: "1837.14", idleWalletByAssetUsd: { XLM: "1837.14" }, idleWalletByAssetTokens: { XLM: "10206.3356118" },
      borrowingAllowed: true, comparisons: compareObservedRates(OBSERVATIONS, NOW),
    });
    expect(fixed.feasible.map((c) => c.id)).toContain("supply_idle:XLM");
    const composed = resolvePlans([plan("Move idle XLM into Blend", [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], ctx());
    const merged = mergeCandidateSets(fixed, composed);
    const ids = merged.feasible.map((c) => c.id);
    expect(ids).toContain("composed:dc.XLM+sb.XLM");
    expect(ids).not.toContain("supply_idle:XLM");
    expect(merged.feasible.find((c) => c.id === "composed:dc.XLM+sb.XLM")?.rationale).toBeTruthy();
  });

  it("does not keep idle on the card after merging when a borrow is required", () => {
    const fixed = generateCandidates({
      grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd, floor: CAPACITY.floor,
      idleWalletUsd: "680", idleWalletByAssetUsd: { BLUSDC: "680" }, borrowingAllowed: true,
      borrowing: "required", comparisons: compareObservedRates(OBSERVATIONS, NOW),
    });
    const plainBorrow = resolvePlans([plan("Borrow XLM", [
      { op: "borrow", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "borrow 100 XLM" } },
    ])], ctx({ messages: ["borrow 100 XLM"], borrowing: "required", capacity: { ...CAPACITY, floor: null } }));
    const merged = mergeCandidateSets(fixed, plainBorrow, "required");
    expect(merged.feasible.length).toBeGreaterThan(0);
    expect(merged.feasible.every((candidate) => candidate.borrows)).toBe(true);
  });

  it("lists a rejected plan with its leg and reason so 'no option' is never silent", () => {
    const merged = mergeCandidateSets(null, resolvePlans([plan("Lever", [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }])], ctx({ borrowing: "forbidden" })));
    expect(merged.feasible).toEqual([]);
    expect(merged.rejected).toEqual([{ label: "Lever", reason: "borrow XLM: you said no new borrowing.", asset: "XLM" }]);
  });
});

/**
 * The floor is the user's, or it is the contract's line — never a default. 13 Sep live:
 * a floor of "1.1" made every account leg say "the margin position was not read", and a
 * deposit-only plan was refused for lacking a floor it cannot need.
 */
describe("resolvePlans — floor semantics", () => {
  const deposit: ProposedPlan["legs"] = [
    { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
    { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
  ];
  const lever: ProposedPlan["legs"] = [
    { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
    { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
  ];

  it("sizes a deposit-only plan with no stated floor, projecting against the liquidation line", () => {
    const { candidates, rejected } = resolvePlans([plan("Deposit", deposit)], ctx({ capacity: { ...CAPACITY, floor: null } }));
    expect(rejected).toEqual([]);
    expect(Number(candidates[0].finalHealthFactor)).toBeCloseTo(1.6546, 3);
  });

  it("sizes a deposit-only plan even when the stated floor is at the liquidation line", () => {
    const { candidates, rejected } = resolvePlans([plan("Deposit", deposit)], ctx({ capacity: { ...CAPACITY, floor: "1.1" } }));
    expect(rejected.map((r) => r.reason)).toEqual([]);
    expect(candidates).toHaveLength(1);
  });

  it("refuses to size a borrow without a stated floor, and says what to say", () => {
    const { candidates, rejected } = resolvePlans([plan("Lever", lever)], ctx({ capacity: { ...CAPACITY, floor: null } }));
    expect(candidates).toEqual([]);
    expect(rejected[0]).toMatchObject({ leg: "borrow XLM", reason: expect.stringMatching(/needs the health-factor floor you want kept/) });
  });

  /**
   * 15 Sep, live: "deposit 10 xlm and take 6x leverage with AqUSDC as a borrowed token" was
   * refused with "a borrow needs the health-factor floor you want kept — tell me the
   * number". The user's answer: "it should show a plan, not a rejection… show me in the plan
   * what the HF will be after that; if the user is ready to bear it, go ahead."
   *
   * A floor is only needed to SIZE a `to_floor` borrow. An amount the user stated themselves
   * needs no floor at all — `sizeLegs` projects the resulting health factor either way, and
   * refuses only what would actually leave the account liquidatable (the 1.1 line).
   */
  it("sizes a borrow stated as an amount with no floor, showing the health factor it leaves", () => {
    const stated: ProposedPlan["legs"] = [
      { op: "borrow", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "borrow 100 XLM" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ];
    const { candidates, rejected } = resolvePlans([plan("Borrow 100", stated)], ctx({
      messages: ["borrow 100 XLM and supply it to Blend"],
      capacity: { ...CAPACITY, floor: null },
    }));
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
    // The figure the user is being asked to bear is on the card, not demanded from them.
    expect(Number(candidates[0].finalHealthFactor)).toBeGreaterThan(1.1);
    expect(candidates[0].steps?.[0]).toMatchObject({ op: "borrow", amount: "100" });
  });

  it("allows a plain literal borrow with no floor without treating it as an investment carry trade", () => {
    const stated: ProposedPlan["legs"] = [
      { op: "borrow", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "borrow 100 XLM" } },
    ];
    const { candidates, rejected } = resolvePlans([plan("Borrow 100", stated)], ctx({
      messages: ["borrow 100 XLM"],
      capacity: { ...CAPACITY, floor: null },
      comparisons: [],
    }));
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ borrows: true, netAprPct: null, supplyAprPct: null });
  });

  it("still refuses a stated borrow with no floor when it would leave the account liquidatable", () => {
    const huge: ProposedPlan["legs"] = [
      { op: "borrow", asset: "XLM", sizing: { kind: "literal", amount: "500000", sourceQuote: "borrow 500000 XLM" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ];
    const { candidates, rejected } = resolvePlans([plan("Borrow far too much", huge)], ctx({
      messages: ["borrow 500000 XLM and supply it to Blend"],
      capacity: { ...CAPACITY, floor: null },
    }));
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toContain("liquidatable");
  });

  it("refuses to size a borrow to a floor at the liquidation line, naming the line", () => {
    const { rejected } = resolvePlans([plan("Lever", lever)], ctx({ capacity: { ...CAPACITY, floor: "1.1" } }));
    expect(rejected[0].reason).toMatch(/at or below 1.1 is the liquidation line/);
  });
});

describe("resolvePlans — an account already under its floor", () => {
  it("still sizes a deposit that brings it back up (the PR #58 defect)", () => {
    // HF 1.2946 today; the user's floor is 1.5. Depositing raises HF to 1.65 — allowed.
    const { candidates, rejected } = resolvePlans([plan("Deposit", [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
    ])], ctx({ capacity: { ...CAPACITY, floor: "1.5" } }));
    expect(rejected).toEqual([]);
    expect(Number(candidates[0].finalHealthFactor)).toBeCloseTo(1.6546, 3);
  });

  it("still refuses a borrow that would end below that floor", () => {
    const { rejected } = resolvePlans([plan("Lever", [
      { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
    ])], ctx({ capacity: { ...CAPACITY, floor: "1.5" } }));
    expect(rejected[0].reason).toMatch(/no headroom at your health-factor floor/);
  });
});

describe("resolvePlans — a share of what the leg draws on (13 Sep: 'repay 25% of my xlm debt', 'lend 25% of xlm that i hold')", () => {
  const wallet = (xlm: string) => obs("e1", "wallet_balances", { assets: [
    { symbol: "XLM", balance: xlm, spendable: xlm, status: "ok" },
    { symbol: "XLM_SAC", balance: xlm, decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" });
  const debt = obs("e10", "account_debt", { debt: [{ symbol: "XLM", balance: "14113.496721182603715676" }] });
  const observations = [...OBSERVATIONS.map((o) => o.id !== "e1" ? o : wallet("9999.8772246")), debt];

  it("lends a share of the idle balance, cut to the token's precision", () => {
    const { candidates, rejected } = resolvePlans(
      [plan("Lend a quarter", [{ op: "lend", asset: "XLM", sizing: { kind: "fraction", percent: "25", of: "idle", sourceQuote: "lend 25% of xlm that i hold" } }])],
      ctx({ observations, messages: ["lend 25% of xlm that i hold and also repay 25% of xlm debt"] }),
    );
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.[0]).toEqual(expect.objectContaining({ op: "lend", amount: "2499.9693061" }));
  });

  it("repays a share of the debt through the account: deposit the share, then repay it", () => {
    const { candidates, rejected } = resolvePlans(
      [plan("Repay a quarter of the XLM debt", [{ op: "repay", asset: "XLM", sizing: { kind: "fraction", percent: "25", of: "position", sourceQuote: "repay 25% of xlm debt" } }])],
      ctx({ observations, messages: ["lend 25% of xlm that i hold and also repay 25% of xlm debt"] }),
    );
    expect(rejected).toEqual([]);
    // 25% of 14113.4967211 = 3528.3741802 (cut to 7 places), well within the 9,999 XLM the wallet spends.
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "3528.3741802"], ["repay", "3528.3741802"]]);
    expect(candidates[0]?.rationale).toMatch(/Leaves 10,585\.1225 XLM of debt/);
  });

  it("caps a debt share by what the wallet can spend", () => {
    const small = [...OBSERVATIONS.map((o) => o.id !== "e1" ? o : wallet("1000")), debt];
    const { candidates } = resolvePlans(
      [plan("Repay half", [{ op: "repay", asset: "XLM", sizing: { kind: "fraction", percent: "50", of: "position", sourceQuote: "repay half of my xlm debt" } }])],
      ctx({ observations: small, messages: ["repay half of my xlm debt"] }),
    );
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "1000"], ["repay", "1000"]]);
  });

  it("understands a share said in words, and refuses one the user never said", () => {
    const half = resolvePlans(
      [plan("Lend half", [{ op: "lend", asset: "XLM", sizing: { kind: "fraction", percent: "50", of: "idle", sourceQuote: "lend half of my idle xlm" } }])],
      ctx({ observations, messages: ["lend half of my idle xlm to earn"] }),
    );
    expect(half.candidates[0]?.steps?.[0]).toEqual(expect.objectContaining({ op: "lend", amount: "4999.9386123" }));
    const invented = resolvePlans(
      [plan("Lend a third", [{ op: "lend", asset: "XLM", sizing: { kind: "fraction", percent: "40", of: "idle", sourceQuote: "lend some of my xlm" } }])],
      ctx({ observations, messages: ["lend some of my xlm"] }),
    );
    expect(invented.candidates).toEqual([]);
    expect(invented.rejected[0]?.reason).toBe("the share 40% does not appear in your request");
  });

  it("withdraws a share of the posted collateral, against the floor", () => {
    const posted = [...observations, obs("e11", "account_collateral", { collateral: [{ symbol: "XLM", balance: "20000" }] })];
    const { candidates, rejected } = resolvePlans(
      [plan("Withdraw a tenth", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "fraction", percent: "10", of: "position", sourceQuote: "withdraw 10% of my xlm collateral" } }])],
      ctx({ observations: posted, messages: ["withdraw 10% of my xlm collateral, keep HF above 1.2"] }),
    );
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.[0]).toEqual(expect.objectContaining({ op: "withdraw_collateral", amount: "2000" }));
  });
});

describe("resolvePlans — two legs may not spend the same idle balance twice (14 Sep)", () => {
  const wallet = obs("e1", "wallet_balances", { assets: [
    { symbol: "XLM", balance: "3316.1252875", spendable: "3315.6252875", status: "ok" },
    { symbol: "XLM_SAC", balance: "3316.1252875", decimals: 7, status: "ok" },
  ], fee_reserve_xlm: "0.5" });
  const debt = obs("e10", "account_debt", { debt: [{ symbol: "XLM", balance: "14113.4967211" }] });
  const observations = [...OBSERVATIONS.map((o) => (o.id === "e1" ? wallet : o)), debt];

  /**
   * "can you repay all the debt and increase my HF, if i dont have the fund please deposit
   * in my margin acc" — the model wrote the funding deposit itself, and the repay expanded
   * into a second one. The plan deposited 3,315.63 XLM, deposited it again, then repaid it;
   * the approve-time funds check blocked the run with "not enough XLM in the wallet".
   */
  it("collapses a repay that follows the model's own funding deposit, instead of asking the wallet twice", () => {
    const { candidates, rejected } = resolvePlans(
      [plan("Deposit then repay", [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
        { op: "repay", asset: "XLM", sizing: { kind: "all_position" } },
      ])],
      ctx({ observations, messages: ["repay all the debt, if i dont have the fund please deposit in my margin acc"] }),
    );
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.map((step) => [step.op, step.amount])).toEqual([
      ["deposit_collateral", "3315.6252875"],
      ["repay", "3315.6252875"],
    ]);
  });

  it("refuses a second leg that draws on an idle balance the first already spent", () => {
    const { candidates, rejected } = resolvePlans(
      [plan("Lend it and deposit it", [
        { op: "lend", asset: "XLM", sizing: { kind: "all_idle" } },
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      ])],
      ctx({ observations, messages: ["lend all my idle XLM and deposit all my idle XLM"] }),
    );
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe("the legs before this one already use all 3315.6252875 XLM the wallet can spend");
  });

  it("counts what an earlier leg puts BACK into the wallet: a redeem funds the deposit after it", () => {
    const position = obs("e8", "earn_position", {
      symbol: "AQUSDC", vtoken_symbol: "VAQUSDC", decimals: 7, human: "500", redeemable_human: "510.5",
    }, { asset: "AQUSDC" });
    const { candidates, rejected } = resolvePlans(
      [plan("Redeem then deposit", [
        { op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } },
        { op: "deposit_collateral", asset: "AQUSDC", sizing: { kind: "all_idle" } },
      ])],
      ctx({ observations: [...observations, position], messages: ["move my AQUSDC from Earn into collateral"] }),
    );
    expect(rejected).toEqual([]);
    // The wallet held no AQUSDC; the redeem lands 510.5 and the deposit spends exactly that.
    expect(candidates[0]?.steps?.map((step) => [step.op, step.amount])).toEqual([
      ["redeem", "500"],
      ["deposit_collateral", "510.5"],
    ]);
  });
});

describe("resolvePlans — withdraw to the floor (14 Sep: 'how much xlm can i withdraw', 'withdraw all … keep my HF > 2.5')", () => {
  const posted = [...OBSERVATIONS, obs("e11", "account_collateral", { collateral: [{ symbol: "XLM", balance: "20000" }] })];

  it("sizes the withdrawal that leaves the health factor exactly at the floor: G − F·D, in tokens", () => {
    // (6605.84 − 1.2 × 5102.54) = 482.792 USD → / 0.18 = 2682.1777 XLM, well under the 20,000 posted.
    const { candidates, rejected } = resolvePlans(
      [plan("Withdraw to the floor", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "to_floor" } }])],
      ctx({ observations: posted, messages: ["withdraw as much XLM as keeps my HF above 1.2"] }),
    );
    expect(rejected).toEqual([]);
    /**
     * A derived max is sized one basis point INSIDE the floor (`FLOOR_MARGIN_BPS` in
     * sizing.ts), so this withdraws slightly less than the exact-floor figure and lands
     * the health factor at 1.20012, not exactly 1.2.
     */
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["withdraw_collateral", "2678.7760844"]]);
    expect(Number(candidates[0]?.finalHealthFactor)).toBeCloseTo(1.20012, 5);
    expect(candidates[0]?.amountBasis).toBe("derived_max_at_floor");
  });

  it("takes no more than is posted, and says so when the floor leaves no room", () => {
    const little = [...OBSERVATIONS, obs("e11", "account_collateral", { collateral: [{ symbol: "XLM", balance: "500" }] })];
    const capped = resolvePlans(
      [plan("Withdraw to the floor", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "to_floor" } }])],
      ctx({ observations: little, messages: ["withdraw all my XLM, keep HF above 1.2"] }),
    );
    expect(capped.candidates[0]?.steps?.[0]?.amount).toBe("500");
    const none = resolvePlans(
      [plan("Withdraw to the floor", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "to_floor" } }])],
      ctx({ observations: posted, messages: ["withdraw all my XLM, keep HF above 2.5"], capacity: { ...CAPACITY, floor: "2.5" } }),
    );
    expect(none.candidates).toEqual([]);
    expect(none.rejected[0]?.reason).toMatch(/^there is no headroom at your health-factor floor; to fit at a 2\.5 floor/);
  });

  it("with no floor stated, names what could come out at the 1.1 line and asks for the floor — never invents one", () => {
    const { candidates, rejected } = resolvePlans(
      [plan("Withdraw to the floor", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "to_floor" } }])],
      ctx({ observations: posted, messages: ["how much xlm can i withdraw ??"], capacity: { ...CAPACITY, floor: null } }),
    );
    expect(candidates).toEqual([]);
    // 6605.84 − 1.1 × 5102.54 = 993.046 USD → / 0.18 = 5516.9222 XLM.
    expect(rejected[0]?.reason).toBe("a withdraw sized to the floor needs the health-factor floor you want kept, above the 1.1 liquidation line — tell me the number; at the line itself up to 5516.9222222 XLM of the 20000 posted could come out");
  });
});

describe("resolvePlans — repay from what the wallet has", () => {
  /**
   * 13 Sep, "I want zero debt but keep all my collateral": the model sized the repay
   * `all_idle` — repay from the wallet — and the card said only "an idle wallet balance
   * does not size a repay". What was owed never appeared. And the account is what repays
   * (`vanna_repay` draws on the smart account; "to repay from the wallet, deposit first"),
   * so the plan is two protocol legs: deposit, capped by the debt, then repay it.
   */
  const withDebt = (walletXlm: string) => ({
    observations: [
      ...OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
        { symbol: "XLM", balance: walletXlm, spendable: walletXlm, status: "ok" },
        { symbol: "XLM_SAC", balance: walletXlm, decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" })),
      obs("e10", "account_debt", { debt: [{ symbol: "XLM", balance: "5000" }] }),
    ],
    messages: ["I want zero debt but keep all my collateral"],
  });
  const legs: ProposedPlan["legs"] = [{ op: "repay", asset: "XLM", sizing: { kind: "all_idle" } }];

  it("deposits what the wallet can cover, capped by the debt, then repays it — two protocol legs", () => {
    const partial = resolvePlans([plan("Repay from wallet", legs)], ctx(withDebt("100")));
    expect(partial.rejected).toEqual([]);
    expect(partial.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "100"], ["repay", "100"]]);
    const whole = resolvePlans([plan("Repay from wallet", legs)], ctx(withDebt("12000")));
    expect(whole.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "5000"], ["repay", "5000"]]);
    // The option's id is the model's plan, not the expanded legs — propose re-resolves by it.
    expect(whole.candidates[0]?.id).toBe(partial.candidates[0]?.id);
  });

  it("sizes 'repay the whole debt' (all_position) to what the wallet funds, and says what remains — never an unfundable plan", () => {
    // 13 Sep: two debts (2,559.65 BLUSDC and 14,113.50 XLM), a wallet with 9,999.88 XLM and no BLUSDC.
    // The card offered "Repay 14113 XLM, then 2559 BLUSDC" and projected health factor 2,495,879.
    const observations = [
      ...OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
        { symbol: "XLM", balance: "9999.8772246", spendable: "9999.8772246", status: "ok" },
        { symbol: "XLM_SAC", balance: "9999.8772246", decimals: 7, status: "ok" },
        { symbol: "BLUSDC", balance: "0", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" })),
      obs("e10", "account_debt", { debt: [{ symbol: "USDC", balance: "2559.646930640709802460" }, { symbol: "XLM", balance: "14113.496721182603715676" }], total_debt_usd: "5076.86" }),
    ];
    const { candidates, rejected } = resolvePlans(
      [plan("Repay XLM and BLUSDC Margin Debts", [{ op: "repay", asset: "XLM", sizing: { kind: "all_position" } }])],
      ctx({ observations, messages: ["I want zero debt but keep all my collateral"] }),
    );
    expect(rejected).toEqual([]);
    const c = candidates[0]!;
    expect(c.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "9999.8772246"], ["repay", "9999.8772246"]]);
    expect(c.repaysAllDebt).toBe(false);
    expect(c.rationale).toMatch(/Leaves 2,559\.6469 BLUSDC and 4,113\.6195 XLM of debt — the wallet covers no more\.$/);
    expect(Number(c.finalHealthFactor)).toBeLessThan(100);
  });

  it("projects no health factor, not a huge one, when every debt row is covered", () => {
    const observations = [
      ...OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
        { symbol: "XLM", balance: "20000", spendable: "20000", status: "ok" },
        { symbol: "XLM_SAC", balance: "20000", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" })),
      obs("e10", "account_debt", { debt: [{ symbol: "XLM", balance: "14113.496721182603715676" }] }),
    ];
    const { candidates } = resolvePlans(
      [plan("Repay all", [{ op: "repay", asset: "XLM", sizing: { kind: "all_position" } }])],
      ctx({ observations, messages: ["repay all my debt"] }),
    );
    const c = candidates[0]!;
    expect(c.steps?.[1]).toEqual(expect.objectContaining({ op: "repay", amount: "14113.4967211" }));
    expect(c.repaysAllDebt).toBe(true);
    expect(c.finalHealthFactor).toBeNull();
    expect(c.rationale).toMatch(/No debt remains after this\.$/);
  });

  it("names the debt and what to add when the wallet holds none of it", () => {
    const { candidates, rejected } = resolvePlans([plan("Repay from wallet", legs)], ctx(withDebt("0")));
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe("you owe 5000 XLM (~$900.00) and the wallet holds no spendable XLM — add 5000 XLM to the wallet, or redeem it from Earn first");
  });
});

describe("resolvePlans — dust is not idle", () => {
  /**
   * 13 Sep, live: "Lend 0.0003729 AQUSDC to Earn — about 20.18 % APR on $0.00" was offered,
   * approved, and paid 0.096 XLM in fees to deposit $0.00007. The wallet read states the fee
   * reserve a transaction needs; a line worth less than that is named, not sized.
   */
  it("rules out lending a wallet line worth less than one transaction's fee reserve, with the figures", () => {
    const observations = OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
      { symbol: "XLM", balance: "3.9736786", spendable: "0", status: "ok" },
      { symbol: "XLM_SAC", balance: "3.9736786", decimals: 7, status: "ok" },
      { symbol: "AQUSDC", balance: "0.0003729", decimals: 7, status: "ok" },
    ], fee_reserve_xlm: "0.5" }));
    const { candidates, rejected } = resolvePlans(
      [plan("Lend idle AQUSDC in Earn", [{ op: "lend", asset: "AQUSDC", sizing: { kind: "all_idle" } }])],
      ctx({ observations: [...observations, obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" })] }),
    );
    expect(candidates).toEqual([]);
    // 0.5 XLM at $0.18 = $0.09 is what a transaction needs; $0.0004 of AQUSDC is not worth it.
    expect(rejected[0]?.reason).toBe("0.0003729 AQUSDC ($0.00) is worth less than the fee reserve one transaction needs ($0.09) — not worth moving");
  });

  it("calls nothing dust when the wallet read states no fee reserve — the floor would be a guess", () => {
    const observations = OBSERVATIONS.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
      { symbol: "XLM", balance: "0.01", spendable: "0.01", status: "ok" },
      { symbol: "XLM_SAC", balance: "0.01", decimals: 7, status: "ok" },
    ] }));
    const { candidates } = resolvePlans(
      [plan("Lend idle XLM in Earn", [{ op: "lend", asset: "XLM", sizing: { kind: "all_idle" } }])],
      ctx({ observations }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.steps?.[0]?.amount).toBe("0.01");
  });
});

describe("resolvePlans — negative carry and spendable balance", () => {
  it("rules out borrowing BLUSDC at 32% to supply Blend at 0.9%, with the rates (13 Sep live card)", () => {
    const { candidates, rejected } = resolvePlans([plan("Lever BLUSDC", [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "borrow", asset: "BLUSDC", sizing: { kind: "to_floor" } },
      { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
    ])], ctx({ capacity: { ...CAPACITY, floor: "1.3" } }));
    expect(candidates).toEqual([]);
    expect(rejected[0]).toEqual({
      title: "Lever BLUSDC", leg: "borrow BLUSDC",
      // The refusal now ends by naming the way out, as the price-impact guard's already
      // does, and is marked liftable so the caller can put it as a question.
      reason: "borrowing BLUSDC costs 32.47% APR and supplying BLUSDC earns 0.90% — this loses money by construction. "
        + "Say you accept the loss and it will be prepared as asked",
      acceptable: true,
    });
  });

  it("uses the wallet read's own spendable figure when the MCP provides it", () => {
    const observations = OBSERVATIONS.map((o) => o.id !== "e1" ? o : {
      ...o, data: { ...o.data, assets: [
        // Horizon balance 10,206.84; chain minimum 3.5 + fee 0.5 → the MCP says 10,202.84 can move.
        { symbol: "XLM", balance: "10206.8356118", spendable: "10202.8356118", min_balance: "3.5", decimals: 7, status: "ok" },
      ] },
    });
    const { candidates } = resolvePlans([plan("Deposit", [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }])], ctx({ observations }));
    expect(candidates[0].steps![0].amount).toBe("10202.8356118");
  });
});

describe("resolvePlans — when a plan does not fit, say what would make it fit", () => {
  it("names the collateral to add or the debt to repay when there is no headroom at the floor", () => {
    // HF is 1.2946 today; a 1.5 floor needs G ≥ 1.5·D = 7,653.81 → add $1,047.97, or repay (F·D − G)/(F − 1) = $2,095.94.
    const { rejected } = resolvePlans([plan("Lever", [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }])], ctx({ capacity: { ...CAPACITY, floor: "1.5" } }));
    expect(rejected[0].reason).toBe(
      "there is no headroom at your health-factor floor; to fit at a 1.5 floor, add $1047.97 of collateral (≈ 5822.06 XLM from your wallet) or repay $2095.94 of debt first",
    );
  });

  it("sizes the shortfall for a literal borrow that would breach the floor", () => {
    // Borrow $1,800 at a 1.3 floor: needs 1.3·(5102.54 + 1800) − (6605.84 + 1800) = $567.46 more collateral.
    const { rejected } = resolvePlans([plan("Borrow", [
      { op: "borrow", asset: "BLUSDC", sizing: { kind: "literal", amount: "1800", sourceQuote: "borrow 1800 BLUSDC" } },
    ])], ctx({ capacity: { ...CAPACITY, floor: "1.3" }, messages: ["borrow 1800 BLUSDC, HF above 1.3"] }));
    expect(rejected[0].reason).toMatch(/^this would take the health factor below your floor; to fit at a 1.3 floor, add \$567\.46 of collateral \(≈ 3152\.\d+ XLM from your wallet\) or repay \$1891\.5\d of debt first$/);
  });
});


describe("resolvePlans — borrowing permission", () => {
  it("offers a levered shape when borrowing is unspecified — permission is optional, only a prohibition rules it out", () => {
    const { candidates } = resolvePlans([plan("Lever", [
      { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], ctx({ borrowing: "unspecified" }));
    expect(candidates).toHaveLength(1);
  });
});

/**
 * Two ops the MCP always had and the copilot could not compose: redeem (Earn → wallet) and
 * withdraw_collateral. The owner's own scenario: "use the AqUSDC sitting in Earn as
 * collateral" — redeem all of it, deposit what comes back.
 */
describe("resolvePlans — redeem and withdraw", () => {
  const withEarn = [
    ...OBSERVATIONS,
    obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }),
    // 4,918.27 vTokens redeem for 5,000.79 AQUSDC — the 13 Sep position.
    obs("e8", "earn_position", { symbol: "AQUSDC", vtoken_symbol: "VAQUSDC", decimals: 7, human: "4918.2651397", redeemable_human: "5000.786863027758031020" }, { asset: "AQUSDC" }),
    obs("e9", "account_collateral", { collateral: [
      { symbol: "XLM", balance: "720", value_usd: "129.38" },
      { symbol: "AQ_XLM_USDC", balance: "0", balance_untrusted: true },
    ] }),
    obs("e10", "account_debt", { debt: [{ symbol: "USDC", balance: "256.64" }] }),
  ];

  it("redeems the whole Earn position, then deposits the underlying it returned", () => {
    const { candidates, rejected } = resolvePlans([plan("Bring AqUSDC from Earn into margin", [
      { op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } },
      { op: "deposit_collateral", asset: "AQUSDC", sizing: { kind: "previous_leg" } },
    ])], ctx({ observations: withEarn }));
    expect(rejected).toEqual([]);
    const c = candidates[0];
    expect(c.id).toBe("composed:re.AQUSDC+dc.AQUSDC");
    // The tool takes vTokens; the deposit takes the underlying that comes back — at the token's
    // 7 decimals, not the read's 18 (the approval gate refused 5000.948562526353068375 on 13 Sep).
    expect(c.steps!.map((s) => [s.op, s.amount, s.tool])).toEqual([
      ["redeem", "4918.2651397", "vanna_redeem"],
      ["deposit_collateral", "5000.786863", "vanna_deposit_collateral"],
    ]);
    expect(c.steps![0].args).toEqual({ symbol: "AQUSDC", redeem_all: true, lender: SCOPE.trader });
    expect(c.steps![0].sizing).toEqual({ basis: "whole_position", read: "earn_position" });
    expect(c.steps![0].label).toMatch(/Redeem 4918.2651397 VAQUSDC from Earn \(≈ 5000.78/);
    expect(c.steps![1].args).toEqual({ smart_account: SCOPE.smartAccount, symbol: "AQUSDC", amount: "5000.786863", trader: SCOPE.trader });
    // One sum of money passes through two legs: deployed is what lands, not twice that.
    expect(Number(c.amountUsd)).toBeCloseTo(5000.79, 1);
    // Collateral rises by the deposit; nothing lowers health, so no floor was needed.
    expect(Number(c.finalHealthFactor)).toBeCloseTo((6605.84 + 5000.79) / 5102.54, 3);
    expect(c.borrows).toBe(false);
  });

  it("uses vtoken_symbol from the mocked on-chain read in the redeem step label", () => {
    const customEarn = withEarn.map((o) =>
      o.capability === "earn_position"
        ? { ...o, data: { ...(o.data as Record<string, unknown>), vtoken_symbol: "vXYZ" } }
        : o
    );
    const { candidates, rejected } = resolvePlans([plan("Redeem custom vToken", [
      { op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } },
    ])], ctx({ observations: customEarn }));
    expect(rejected).toEqual([]);
    expect(candidates[0].steps![0].label).toMatch(/^Redeem 4918.2651397 vXYZ from Earn \(≈ 5000.78/);
  });

  it("falls back to '{tokens} {asset} vTokens' when the on-chain read carried no vtoken_symbol", () => {
    const noSymbolEarn = withEarn.map((o) => {
      if (o.capability !== "earn_position") return o;
      const { vtoken_symbol: _, ...restData } = o.data as Record<string, unknown>;
      return { ...o, data: restData };
    });
    const { candidates, rejected } = resolvePlans([plan("Redeem fallback", [
      { op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } },
    ])], ctx({ observations: noSymbolEarn }));
    expect(rejected).toEqual([]);
    expect(candidates[0].steps![0].label).toMatch(/^Redeem 4918.2651397 AQUSDC vTokens from Earn \(≈ 5000.78/);
  });

  it("converts a literal redeem amount from the underlying the user named into vTokens", () => {
    const { candidates } = resolvePlans([plan("Redeem some", [
      { op: "redeem", asset: "AQUSDC", sizing: { kind: "literal", amount: "1000", sourceQuote: "redeem 1000 AQUSDC" } },
    ])], ctx({ observations: withEarn, messages: ["redeem 1000 AQUSDC from earn"] }));
    // 1000 / 5000.79 of the position → 983.5 vTokens.
    expect(Number(candidates[0].steps![0].amount)).toBeCloseTo(983.50, 1);
  });

  it("formats user-facing refusal amounts to the token's own decimals rather than 18-decimal WAD", () => {
    const { rejected } = resolvePlans([plan("Redeem too much", [
      { op: "redeem", asset: "AQUSDC", sizing: { kind: "literal", amount: "6000", sourceQuote: "redeem 6000 AQUSDC" } },
    ])], ctx({ observations: withEarn, messages: ["redeem 6000 AQUSDC from earn"] }));
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("only 5000.786863 AQUSDC is redeemable from Earn");
  });

  it("withdraws the posted collateral against the stated floor, and refuses when it would breach it", () => {
    const ok = resolvePlans([plan("Take XLM out", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({ observations: withEarn, capacity: { ...CAPACITY, floor: "1.2" } }));
    expect(ok.rejected).toEqual([]);
    expect(ok.candidates[0].steps![0]).toMatchObject({ op: "withdraw_collateral", amount: "720", tool: "vanna_withdraw_collateral", args: { smart_account: SCOPE.smartAccount, symbol: "XLM", amount: "720", trader: SCOPE.trader } });
    // (6605.84 − 129.6) / 5102.54 = 1.269 — still above 1.2.
    expect(Number(ok.candidates[0].finalHealthFactor)).toBeCloseTo(1.269, 2);
    const breach = resolvePlans([plan("Take XLM out", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({ observations: withEarn, capacity: { ...CAPACITY, floor: "1.28" } }));
    expect(breach.rejected[0].reason).toMatch(/^this would take the health factor below your floor/);
  });

  it("with no stated floor, a withdraw is held to the liquidation line only", () => {
    const { candidates } = resolvePlans([plan("Take XLM out", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({ observations: withEarn, capacity: { ...CAPACITY, floor: null } }));
    expect(candidates).toHaveLength(1);
  });

  /**
   * A disagreement is not a missing basis. The app counts everything the account holds and
   * the contract counts only what is posted, so any account with an unposted token or an LP
   * receipt disagrees permanently — and the sizer is already using the contract's figures,
   * the ones that liquidate you. Refusing on top of that blocked every withdraw and borrow
   * on the live account while protecting nothing (15 Sep). Only a missing CONTRACT basis
   * still refuses.
   */
  it("sizes a withdraw while the sizing sources merely disagree — the contract's figures are the basis either way", () => {
    const { candidates, rejected } = resolvePlans([plan("Take XLM out", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({
      observations: withEarn,
      capacity: { ...CAPACITY, issue: { reason: "sizing_sources_disagree", app: { grossCollateralUsd: "1", debtUsd: "1" }, contract: { grossCollateralUsd: "1", debtUsd: "1" } } },
    }));
    expect(rejected).toEqual([]);
    expect(candidates[0].steps![0]).toMatchObject({ op: "withdraw_collateral" });
  });

  it("refuses a withdraw when the contract basis itself could not be read — nothing authoritative to size from", () => {
    const { rejected } = resolvePlans([plan("Take XLM out", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({
      observations: withEarn,
      capacity: { ...CAPACITY, issue: { reason: "sizing_contract_unavailable", app: { grossCollateralUsd: "1", debtUsd: "1" }, contract: null } },
    }));
    expect(rejected[0].reason).toMatch(/could not be confirmed against the liquidation engine/);
  });

  it("repays the whole debt of an asset from the debt read — funded through the account, so deposit then repay", () => {
    // The account is what repays; the wallet funds it. With no BLUSDC in the wallet the plan
    // cannot run and says so (13 Sep: an unfundable full repay was offered instead).
    const empty = resolvePlans([plan("Clear USDC debt", [{ op: "repay", asset: "BLUSDC", sizing: { kind: "all_position" } }])], ctx({ observations: withEarn }));
    expect(empty.candidates).toEqual([]);
    expect(empty.rejected[0]?.reason).toMatch(/^you owe 256\.64 BLUSDC \(~\$256\.64\) and the wallet holds no spendable BLUSDC/);
    const funded = withEarn.map((o) => o.id !== "e1" ? o : obs("e1", "wallet_balances", { assets: [
      { symbol: "XLM", balance: "100", spendable: "100", status: "ok" }, { symbol: "XLM_SAC", balance: "100", decimals: 7, status: "ok" },
      { symbol: "BLUSDC", balance: "300", decimals: 7, status: "ok" },
    ], fee_reserve_xlm: "0.5" }));
    const { candidates } = resolvePlans([plan("Clear USDC debt", [{ op: "repay", asset: "BLUSDC", sizing: { kind: "all_position" } }])], ctx({ observations: funded }));
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount, s.args.symbol])).toEqual([["deposit_collateral", "256.64", "USDC"], ["repay", "256.64", "USDC"]]);
    expect(candidates[0]?.repaysAllDebt).toBe(true);
  });

  /**
   * 14 Sep, live: an account holding 842.46 XLM against 68.49 XLM of debt was told "the
   * wallet holds no spendable XLM" for "clear all my debt". The account IS a source, and
   * "repay all my debt" names no other one, so it repays from itself when it can.
   */
  it("repays the whole debt from the account when the account already covers it, with no wallet deposit", () => {
    const covered = [
      ...withEarn.filter((o) => o.capability !== "account_debt" && o.capability !== "account_collateral"),
      obs("e10", "account_debt", { debt: [{ symbol: "XLM", balance: "68.49" }] }),
      obs("e11", "account_collateral", { collateral: [{ symbol: "XLM", balance: "842.46" }] }),
    ];
    const { candidates, rejected } = resolvePlans([plan("Clear XLM debt", [{ op: "repay", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({ observations: covered }));
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "68.49"]]);
  });

  it("still deposits first when the account cannot cover the whole debt on its own", () => {
    const short = [
      ...withEarn.filter((o) => o.capability !== "account_debt" && o.capability !== "account_collateral"),
      obs("e10", "account_debt", { debt: [{ symbol: "XLM", balance: "68.49" }] }),
      obs("e11", "account_collateral", { collateral: [{ symbol: "XLM", balance: "10" }] }),
    ];
    const { candidates } = resolvePlans([plan("Clear XLM debt", [{ op: "repay", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({ observations: short }));
    expect(candidates[0]?.steps?.map((s) => s.op)).toEqual(["deposit_collateral", "repay"]);
  });

  it("names what is missing when the position was not read", () => {
    const { rejected } = resolvePlans([plan("Bring AqUSDC", [{ op: "redeem", asset: "AQUSDC", sizing: { kind: "all_position" } }])], ctx({ observations: [...OBSERVATIONS, obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" })] }));
    expect(rejected[0].reason).toBe("no AQUSDC position in Earn was read this investigation");
  });
});

describe("resolvePlans — precision comes from the protocol", () => {
  it("refuses to emit an amount for a token whose precision no read stated, rather than guess", () => {
    const noDecimals = OBSERVATIONS.map((o) => o.id !== "e1" ? o : { ...o, data: { assets: [{ symbol: "XLM", balance: "10206.8356118", status: "ok" }], fee_reserve_xlm: "0.5" } });
    const { rejected } = resolvePlans([plan("Lever", [
      { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], ctx({ observations: noDecimals }));
    expect(rejected[0].reason).toBe("the on-chain precision of XLM was not read this investigation");
  });
});

/**
 * A handoff is bound to the leg that produced the asset, not to the line above it.
 *
 * `previous_leg` used to read `drafts[index - 1]`, which made the link positional: a dual
 * borrow puts an unrelated leg between the borrow and the supply that spends it, and the
 * whole plan was refused with "previous_leg needs a preceding leg in the same asset" even
 * though nothing about it was wrong. Every pipeline that passes values between steps binds
 * them by identity for this reason — Argo names the producing task and its artifact — and
 * here the asset is that identity, since a leg produces exactly one.
 *
 * The second half matters as much: one producer funds one consumer. Two legs must not be
 * able to spend the same borrow.
 */
describe("previous_leg follows the asset, not the line above", () => {
  const interleaved: ProposedPlan["legs"] = [
    { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
    { op: "borrow", asset: "BLUSDC", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
    { op: "borrow", asset: "XLM", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
    { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
  ];
  const messages = ["deposit 100 XLM and borrow 2x BLUSDC and XLM, then supply the BLUSDC to Blend"];

  it("reaches the borrow two legs back instead of refusing the plan", () => {
    const { rejected } = resolvePlans([plan("Dual borrow then supply", interleaved)], ctx({ messages }));
    // Whatever else this plan runs into, it must not die on the handoff any more.
    expect(rejected[0]?.reason ?? "").not.toMatch(/previous_leg needs a preceding leg/);
  });

  it("still refuses when no preceding leg produced that asset at all", () => {
    const orphan: ProposedPlan["legs"] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
      { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
    ];
    const { rejected } = resolvePlans([plan("Nothing made BLUSDC", orphan)], ctx({ messages: ["deposit 100 XLM then supply the BLUSDC"] }));
    expect(rejected[0]?.reason).toMatch(/previous_leg needs a preceding leg in the same asset/);
  });

  it("will not let two legs spend the same producer", () => {
    const doubleSpend: ProposedPlan["legs"] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
      { op: "borrow", asset: "BLUSDC", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
      { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
      { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
    ];
    const { candidates, rejected } = resolvePlans([plan("Spend it twice", doubleSpend)], ctx({ messages }));
    /**
     * The property that matters is that the single borrow is not spent twice, so the plan
     * must not become something the user can approve. Which guard catches it is not
     * pinned: claiming the borrow for the first supply leaves the second to resolve
     * against the supply itself, and the op-flow table refuses that handoff first.
     */
    expect(candidates).toHaveLength(0);
    expect(rejected).not.toHaveLength(0);
  });
});

/**
 * An unreadable return is an unknown, not a loss.
 *
 * The carry guard sums supplied × supply APR against borrowed × borrow APR, and skipped
 * any leg whose op carries no rate. An LP leg is exactly that — its income is trading
 * fees, not a protocol rate — so a leveraged LP strategy had its borrow counted as a cost
 * and the position it funds counted as earning nothing. "Deposit, borrow 2x, supply some
 * to Blend and LP the rest on Soroswap" was ruled out as losing "by construction", from a
 * number nobody had, for a position the Margin page opens without complaint.
 *
 * Scoring an unknown as zero and then reporting it as a loss is the same error the Blend
 * answer made when it printed a rate as a balance. The guard now fires only when it can
 * see the whole return, and `netAprPct` goes null — the contract the card already renders
 * as "not read".
 */
describe("a plan whose return cannot be read is not called a loss", () => {
  const levered: ProposedPlan["legs"] = [
    { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
    { op: "borrow", asset: "BLUSDC", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
    { op: "add_liquidity", asset: "BLUSDC", assetOut: "XLM", venue: "soroswap", sizing: { kind: "previous_leg" } },
  ];
  const messages = ["deposit 100 XLM, borrow 2x BLUSDC and put it in the Soroswap pool with XLM"];

  it("does not rule out a leveraged LP as losing money by construction", () => {
    const { rejected } = resolvePlans([plan("Levered Soroswap LP", levered)], ctx({ messages }));
    expect(rejected[0]?.reason ?? "").not.toMatch(/loses money by construction/);
  });

  it("still rules out a borrow deployed entirely into a readable rate that cannot cover it", () => {
    // Every leg's return IS readable here — Blend supply at 0.9% against an Earn borrow
    // at 32.47% — so the guard must keep refusing exactly as it did.
    const carry: ProposedPlan["legs"] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
      { op: "borrow", asset: "BLUSDC", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
      { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
    ];
    const { rejected } = resolvePlans([plan("Negative carry", carry)], ctx({ messages: ["deposit 100 XLM and borrow 2x BLUSDC into Blend"] }));
    expect(rejected[0]?.reason ?? "").toMatch(/loses money by construction/);
  });
});

/**
 * Whose idea it was decides whether a losing carry is refused or offered.
 *
 * The same arithmetic warrants two different answers. A shape the MODEL composed that
 * cannot cover its own borrow cost should never reach the user — proposing it is the
 * mistake. A shape the USER stated is not a proposal: they asked for it, the Margin page
 * opens it without objecting, and refusing it outright leaves them to do the whole thing
 * by hand. That is the copilot failing at its job, not protecting them.
 *
 * Aditya, 20 Sep: *"ui se ho ra to copilot se bhi hona chahiye ni to fir mtlb ni hua ...
 * atleast kuch to way hoga"*.
 */
describe("a losing carry the user asked for is offered, not refused", () => {
  const legs: ProposedPlan["legs"] = [
    { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
    { op: "borrow", asset: "BLUSDC", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
    { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
  ];
  const messages = ["deposit 100 XLM and borrow 2x BLUSDC into Blend"];
  const shape = plan("Levered Blend", legs);

  it("still rules the shape out when the model composed it", () => {
    const { rejected } = resolvePlans([shape], ctx({ messages }));
    expect(rejected[0]?.reason ?? "").toMatch(/loses money by construction/);
  });

  it("does not rule it out when it is the plan the user stated", () => {
    const { rejected } = resolvePlans([shape], ctx({ messages, statedPlanId: planCandidateId(shape) }));
    expect(rejected[0]?.reason ?? "").not.toMatch(/loses money by construction/);
  });
});

/**
 * The way out of a losing carry is the one the swap guard already offers.
 *
 * The price-impact guard states the principle in its own comment — "what this guard owes
 * them is the number, not a veto they cannot lift" — and its refusal ends by telling the
 * user how to lift it. The carry guard had the number and no way out, so a shape the user
 * can open from the Margin page was a dead end in the copilot.
 *
 * The acceptance is the same fact in both places: the user, in their own words, taking a
 * quantified loss that was put to them. (The field is still called `slippageAccepted`
 * because the sealed proposal stores it under that name; its meaning is broader.)
 */
describe("a priced loss can be accepted, not only refused", () => {
  const legs: ProposedPlan["legs"] = [
    { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } },
    { op: "borrow", asset: "BLUSDC", sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" } },
    { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } },
  ];
  const messages = ["deposit 100 XLM and borrow 2x BLUSDC into Blend, i am ready to bear the loss"];
  const shape = plan("Levered Blend", legs);

  it("tells the user how to lift the refusal instead of only refusing", () => {
    const { rejected } = resolvePlans([shape], ctx({ messages }));
    expect(rejected[0]?.reason).toMatch(/loses money by construction/);
    expect(rejected[0]?.reason).toMatch(/accept the loss/);
  });

  it("prepares the plan once the user has accepted the loss in their own words", () => {
    const { rejected } = resolvePlans([shape], ctx({
      messages,
      goal: { slippageAccepted: { accepted: true, sourceQuote: "i am ready to bear the loss" } },
    }));
    expect(rejected[0]?.reason ?? "").not.toMatch(/loses money by construction/);
  });
});
