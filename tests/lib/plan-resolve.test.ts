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
    { symbol: "XLM", balance: "10206.8356118", status: "ok" },
    { symbol: "USDC", status: "not_resolvable", balance: null },
    { symbol: "AQUSDC", balance: "0.0000000", status: "ok" },
    { symbol: "BLUSDC", balance: "0.0000000", status: "ok" },
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

  it.each([
    ["borrowing forbidden", { borrowing: "forbidden" as const }, [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }], "borrow XLM", "you said no new borrowing"],
    ["floor at the liquidation line", { capacity: { ...CAPACITY, floor: "1.1" } }, [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }], null, /floor at or below 1.1 is the liquidation line/],
    ["Blend supply from the wallet directly", {}, [{ op: "supply_blend", asset: "XLM", sizing: { kind: "all_idle" } }], "supply blend XLM", /deposit the idle tokens as collateral first/],
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
        { symbol: "XLM", balance: "10206.8356118", spendable: "10202.8356118", min_balance: "3.5", status: "ok" },
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
