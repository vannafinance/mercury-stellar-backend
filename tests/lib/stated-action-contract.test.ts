import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { planFromStatedActions } from "@/lib/copilot/investigation/plan";

/**
 * A stated instruction must be able to say everything a plan leg can say.
 *
 * `goal.actions` is the deterministic route from "the user asked for exactly this" to a
 * sized plan: it does not depend on the model composing anything, which is what stops a
 * concrete request from being answered with alternatives. It used to be validated against
 * `{op, asset, amount, sourceQuote}` — a bare decimal — while `PlanLeg` carried `sizing`,
 * `assetOut` and `venue`. The narrower form fed the wider one, so an instruction the plan
 * contract could hold perfectly well was rejected on the way in: `"2x"` failed the decimal
 * test, and `exactKeys` dropped any action naming a pool's other token or its DEX.
 *
 * The prompt that exposed it, live:
 *
 *   "deposit 100 XLM into the margin account and borrow 2x bLUSD and SOUSDC and then
 *    provide liqudity of busd in blend and sousdc and XLM in the soroswap"
 *
 * Three of its five legs could not be written down, so the user's own instruction came
 * back as unrelated ranked options.
 *
 * These tests use that prompt's shapes rather than a single-field probe, because the point
 * is not that one field was added — it is that the two contracts are now the SAME contract
 * (one `parseLeg`, one `legSchema`) and cannot drift apart again.
 */

const QUOTE =
  "deposit 100 XLM into the margin account and borrow 2x bLUSD and SOUSDC and then " +
  "provide liqudity of busd in blend and sousdc and XLM in the soroswap";

function decide(actions: unknown[]) {
  return parseDecision({
    kind: "research_complete",
    goal: {
      intent: "strategy",
      objective: "deposit, borrow at 2x, then provide liquidity",
      constraints: [],
      borrowing: "required",
      actions,
    },
    // A stated-action handoff is allowed to cite no observations; the decision parser
    // still requires at least one finding.
    findings: [{ summary: "The user stated these legs outright.", evidenceIds: [] }],
    openQuestions: [],
  });
}

function actionsOf(decision: ReturnType<typeof decide>) {
  return decision?.kind === "research_complete" ? (decision.goal.actions ?? []) : [];
}

describe("a stated action carries everything a plan leg carries", () => {
  it("keeps a leverage-sized borrow the user asked for", () => {
    const actions = actionsOf(
      decide([
        {
          op: "borrow",
          asset: "BLUSDC",
          sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x bLUSD" },
          sourceQuote: QUOTE,
        },
      ]),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].sizing).toMatchObject({ kind: "leverage", multiple: "2" });
  });

  it("keeps the paired asset and the DEX on an add_liquidity leg", () => {
    const actions = actionsOf(
      decide([
        {
          op: "add_liquidity",
          asset: "SOUSDC",
          assetOut: "XLM",
          venue: "soroswap",
          sizing: { kind: "previous_leg" },
          sourceQuote: "sousdc and XLM in the soroswap",
        },
      ]),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ asset: "SOUSDC", assetOut: "XLM", venue: "soroswap" });
  });

  it("carries the whole multi-leg instruction into a plan, sizings intact", () => {
    const actions = actionsOf(
      decide([
        {
          op: "deposit_collateral",
          asset: "XLM",
          sizing: { kind: "literal", amount: "100", sourceQuote: "deposit 100 XLM" },
          sourceQuote: QUOTE,
        },
        {
          op: "borrow",
          asset: "BLUSDC",
          sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x bLUSD" },
          sourceQuote: QUOTE,
        },
        {
          op: "borrow",
          asset: "SOUSDC",
          sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" },
          sourceQuote: QUOTE,
        },
        {
          op: "supply_blend",
          asset: "BLUSDC",
          sizing: { kind: "previous_leg" },
          sourceQuote: "provide liqudity of busd in blend",
        },
        {
          op: "add_liquidity",
          asset: "SOUSDC",
          assetOut: "XLM",
          venue: "soroswap",
          sizing: { kind: "previous_leg" },
          sourceQuote: "sousdc and XLM in the soroswap",
        },
      ]),
    );

    expect(actions).toHaveLength(5);

    const plan = planFromStatedActions(actions, "deposit, borrow at 2x, then provide liquidity");
    expect(plan).not.toBeNull();
    expect(plan!.legs.map((leg) => `${leg.op}:${leg.asset}:${leg.sizing.kind}`)).toEqual([
      "deposit_collateral:XLM:literal",
      "borrow:BLUSDC:leverage",
      "borrow:SOUSDC:leverage",
      "supply_blend:BLUSDC:previous_leg",
      "add_liquidity:SOUSDC:previous_leg",
    ]);
    // The pair and the DEX survive the trip; rebuilding legs as bare literals lost both.
    expect(plan!.legs[4]).toMatchObject({ assetOut: "XLM", venue: "soroswap" });
  });

  it("still refuses a leg that names a second asset on an op that has none", () => {
    // The widened contract must not have widened into nonsense: `assetOut` belongs to the
    // ops in ASSET_OUT_OPS and nowhere else, exactly as it does on a plan leg.
    const actions = actionsOf(
      decide([
        {
          op: "borrow",
          asset: "BLUSDC",
          assetOut: "XLM",
          sizing: { kind: "leverage", multiple: "2", sourceQuote: "borrow 2x" },
          sourceQuote: QUOTE,
        },
      ]),
    );

    expect(actions).toHaveLength(0);
  });
});
