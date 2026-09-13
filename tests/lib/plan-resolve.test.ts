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

  it("honours a literal amount only when it is anchored to the user's words", () => {
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }];
    const ok = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["please lend 100 XLM to earn"] }));
    expect(ok.candidates[0]?.steps).toEqual([expect.objectContaining({ op: "lend", amount: "100", args: { symbol: "XLM", amount: "100", lender: SCOPE.trader } })]);
    expect(ok.candidates[0]?.venue).toBe("earn");
    const bad = resolvePlans([plan("Lend 100 XLM", legs)], ctx({ messages: ["lend some XLM"] }));
    expect(bad.candidates).toEqual([]);
    expect(bad.rejected[0]).toEqual({ title: "Lend 100 XLM", leg: "lend XLM", reason: "the amount 100 does not appear in your request" });
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
    ["a literal Blend supply larger than the deposit before it", { messages: ["deposit 100 XLM and supply 200 XLM to Blend"] }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" } }, { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "200", sourceQuote: "supply 200 XLM" } }], "supply blend XLM", "only 100 XLM is put into the account by the deposit before it"],
    ["nothing idle", {}, [{ op: "lend", asset: "AQUSDC", sizing: { kind: "all_idle" } }], "lend AQUSDC", "no idle AQUSDC in the wallet"],
    ["previous_leg across assets", {}, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }, { op: "supply_blend", asset: "BLUSDC", sizing: { kind: "previous_leg" } }], "supply blend BLUSDC", /preceding leg in the same asset/],
    ["margin position not read", { capacity: null }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }], "deposit collateral XLM", /margin position was not read/],
    ["no margin account", { scope: { ...SCOPE, smartAccount: null } }, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } }], "deposit collateral XLM", /margin account is needed/],
    ["no price read", {}, [{ op: "lend", asset: "AQUA", sizing: { kind: "all_idle" } }], "lend AQUA", "no AQUA price was read this investigation"],
    ["to_floor on a deposit", {}, [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "to_floor" } }], "deposit collateral XLM", /only a borrow can be sized to the health-factor floor/],
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
    expect(rejected[0].reason).toMatch(/no borrowing headroom at your health-factor floor/);
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
      "there is no borrowing headroom at your health-factor floor; to fit at a 1.5 floor, add $1047.97 of collateral (≈ 5822.06 XLM from your wallet) or repay $2095.94 of debt first",
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

  it("refuses a withdraw while the sizing sources disagree — it lowers health like a borrow", () => {
    const { rejected } = resolvePlans([plan("Take XLM out", [{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "all_position" } }])], ctx({
      observations: withEarn,
      capacity: { ...CAPACITY, issue: { reason: "sizing_sources_disagree", app: { grossCollateralUsd: "1", debtUsd: "1" }, contract: { grossCollateralUsd: "1", debtUsd: "1" } } },
    }));
    expect(rejected[0].reason).toMatch(/disagree on your position, so nothing that lowers health is sized/);
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
 * A venue the user NAMES is a constraint, not a hint.
 *
 * 13 Sep, signed in: *"invest into earn pool where i can get good returns?"* The registry
 * rule said a named venue fixes the USDC variant and left the venue itself open, so the
 * model compared every venue, found Blend XLM at 168% against Earn XLM at 5%, and composed
 * a Blend supply. 19,353 XLM moved to a product the user had not asked for. A better rate
 * is a finding; it is not permission to substitute.
 *
 * The quote is anchored the same way an amount or a floor is: the model locates the phrase,
 * the user's own text vouches for it. An unanchored quote is discarded, so the model cannot
 * invent a constraint any more than it can invent a number.
 */
describe("resolvePlans — a named venue binds the plan", () => {
  const earnMessages = ["invest into earn pool where i can get good returns?"];

  it("rejects a Blend shape when the user said earn, and names both venues in the reason", () => {
    const { candidates, rejected } = resolvePlans([{
      ...plan("Supply idle XLM to Blend", [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ]),
      venueQuote: "earn pool",
    }], ctx({ messages: earnMessages }));
    expect(candidates).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("earn");
    expect(rejected[0].reason).toContain("blend");
  });

  it("keeps an Earn shape when the user said earn", () => {
    const { candidates, rejected } = resolvePlans([{
      ...plan("Lend idle XLM into Vanna Earn", [{ op: "lend", asset: "XLM", sizing: { kind: "all_idle" } }]),
      venueQuote: "earn pool",
    }], ctx({ messages: earnMessages }));
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].venue).toBe("earn");
  });

  /** The model cannot manufacture a constraint: a quote that is not in the user's text is ignored. */
  it("ignores a venueQuote the user never typed", () => {
    const { candidates, rejected } = resolvePlans([{
      ...plan("Supply idle XLM to Blend", [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ]),
      venueQuote: "earn pool",
    }], ctx({ messages: ["put my idle XLM somewhere sensible"] }));
    expect(rejected).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].venue).toBe("blend");
  });
});
