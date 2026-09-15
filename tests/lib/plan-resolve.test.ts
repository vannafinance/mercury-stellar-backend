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
import { resolvePlans, planCandidateId } from "@/lib/copilot/investigation/plan";
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

  it("rejects exact-output swaps instead of treating the desired output as input", () => {
    const result = resolvePlans([plan("Receive AQUSDC", [{
      op: "swap",
      asset: "XLM",
      assetOut: "AQUSDC",
      sizing: {
        kind: "literal",
        amount: "961.4183674",
        sourceQuote: "swap XLM to receive 961.4183674 AQUSDC",
      },
    }])], ctx({
      messages: ["swap XLM to receive 961.4183674 AQUSDC"],
      observations: [...OBSERVATIONS, obs("e7", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" })],
    }));
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("exact-output swaps are not supported yet");
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
    // x = (G − F·D)/(F − 1) = (6605.84 − 1.2·5102.54)/0.2 = 2413.96 USD → /0.18 XLM
    expect(Number(c.amountUsd)).toBeCloseTo(2413.96, 2);
    expect(Number(c.steps?.[0].amount)).toBeCloseTo(13410.89, 1);
    expect(c.steps?.[1].amount).toBe(c.steps?.[0].amount);
    expect(Number(c.finalHealthFactor)).toBeCloseTo(1.2, 6);
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
      expect(rejected[0]?.reason).toMatch(/needs the deposit that funds it stated immediately before/);
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

  it("honours a literal amount only when it is anchored to the user's words", () => {
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }];
    const ok = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["please lend 100 XLM to earn"] }));
    expect(ok.candidates[0]?.steps).toEqual([expect.objectContaining({ op: "lend", amount: "100", args: { symbol: "XLM", amount: "100", lender: SCOPE.trader } })]);
    expect(ok.candidates[0]?.venue).toBe("earn");
    const bad = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["lend some XLM"] }));
    expect(bad.candidates).toEqual([]);
    expect(bad.rejected[0]).toEqual({ title: "Lend 100 XLM", leg: "lend XLM", reason: "the amount 100 does not appear in your request" });
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
    ["Blend supply from the wallet directly", {}, [{ op: "supply_blend", asset: "XLM", sizing: { kind: "all_idle" } }], "supply blend XLM", /deposit the idle tokens as collateral first/],
    ["a literal Blend supply with nothing put in before it", { messages: ["supply 100 XLM to Blend"] }, [{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }], "supply blend XLM", /add that leg before it/],
    ["a literal Blend supply larger than the deposit before it", { messages: ["deposit 100 XLM and supply 200 XLM to Blend"] }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } }, { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "200", sourceQuote: "supply 200 XLM" } }], "supply blend XLM", "only 100 XLM is in the margin account after the legs before it"],
    ["nothing idle", {}, [{ op: "lend", asset: "AQUSDC", sizing: { kind: "all_idle" } }], "lend AQUSDC", "no idle AQUSDC in the wallet"],
    ["previous_leg across assets", {}, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }, { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } }], "supply blend BLUSDC", /preceding leg in the same asset/],
    ["margin position not read", { capacity: null }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }], "deposit collateral XLM", /margin position was not read/],
    ["no margin account", { scope: { ...SCOPE, smartAccount: null } }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }], "deposit collateral XLM", /margin account is needed/],
    ["no price read", {}, [{ op: "lend", asset: "AQUA", sizing: { kind: "all_idle" } }], "lend AQUA", "no AQUA price was read this investigation"],
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
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["withdraw_collateral", "2682.1777777"]]);
    expect(Number(candidates[0]?.finalHealthFactor)).toBeCloseTo(1.2, 6);
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
      reason: "borrowing BLUSDC costs 32.47% APR and supplying BLUSDC earns 0.90% — this loses money by construction",
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
    expect(c.steps![0].args).toEqual({ symbol: "AQUSDC", amount: "4918.2651397", lender: SCOPE.trader });
    expect(c.steps![0].label).toMatch(/Redeem 4918.2651397 AQUSDC vTokens from Earn \(≈ 5000.78/);
    expect(c.steps![1].args).toEqual({ smart_account: SCOPE.smartAccount, symbol: "AQUSDC", amount: "5000.786863", trader: SCOPE.trader });
    // One sum of money passes through two legs: deployed is what lands, not twice that.
    expect(Number(c.amountUsd)).toBeCloseTo(5000.79, 1);
    // Collateral rises by the deposit; nothing lowers health, so no floor was needed.
    expect(Number(c.finalHealthFactor)).toBeCloseTo((6605.84 + 5000.79) / 5102.54, 3);
    expect(c.borrows).toBe(false);
  });

  it("converts a literal redeem amount from the underlying the user named into vTokens", () => {
    const { candidates } = resolvePlans([plan("Redeem some", [
      { op: "redeem", asset: "AQUSDC", sizing: { kind: "literal", amount: "1000", sourceQuote: "redeem 1000 AQUSDC" } },
    ])], ctx({ observations: withEarn, messages: ["redeem 1000 AQUSDC from earn"] }));
    // 1000 / 5000.79 of the position → 983.5 vTokens.
    expect(Number(candidates[0].steps![0].amount)).toBeCloseTo(983.50, 1);
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
