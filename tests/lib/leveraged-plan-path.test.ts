/**
 * The PLAN path must size a levered position the same way the write path does.
 *
 * ## Why this file exists next to leveraged-margin.test.ts
 *
 * That file already pins this exact sentence, and every unit it tests was correct:
 * `routeMessage` returns `deposit_and_borrow` with `borrow_asset: "XLM"`, `planLeverage`
 * sizes it off the oracle, `expandPlanWrites` keeps a cross-asset position whole.
 *
 * And it still failed live. Because the sentence never reached any of them.
 *
 * "Deposit 500 AqUSDC and take 3x leverage and borrow XLM in borrowed capital" has two
 * verbs and an "and", so `looksLikeMultiGoal` routes it to the PLAN path, which builds
 * its legs from clauses instead. The clause splitter keeps "deposit and borrow" whole
 * only when the verbs are ADJACENT; here they are separated, so it split into a deposit
 * clause and a bare "borrow XLM" clause. The halves lost what only the whole had:
 *
 *   deposit_collateral 500 AQUSDC   ← fine
 *   borrow USDC / amount null       ← size implied by leverage, asset defaulted away
 *
 * Which the user saw as "amount to be confirmed USDC", a "which USDC?" chip for a token
 * they never named, and — after the deposit had settled on chain — a prompt asking them
 * to type a size the backend could compute. Debt stayed $0, HF stayed ∞.
 *
 * So a unit test on the write path cannot protect this. These tests assert the PLAN
 * path's own output, which is the surface that was broken, for both operator repros.
 */

import { describe, expect, it } from "vitest";
import {
  coalesceLeveragedDepositBorrow,
  extractPlanIR,
  preferExtractedPlan,
} from "@/lib/copilot/step-extractor";
import { sanitizePlan } from "@/lib/copilot/plan-sanitize";
import { freezePlan, planFingerprint, verifyApprovedPlan } from "@/lib/copilot/plan-approval";
import { routeMessage } from "@/lib/copilot/router";
import { planLeverage } from "@/lib/copilot/leverage-plan";
import { actionFromExpanded, expandPlanWrites } from "@/lib/copilot/multi-leg-agent";
import { ambiguousUsdcSlot } from "@/lib/copilot/mcp-write";
import type { RoutedIntent } from "@/lib/copilot/types";

/** The oracle's answer, not a guess — same feed the sibling suite uses. */
const PRICES = { XLM: 0.11, AQUA: 0.004 };

/** The two strings the operator ran on localhost, verbatim. */
const REPRO = [
  {
    message: "Deposit 500 AqUSDC and take 3x leverage and borrow XLM in borrowed capital",
    collateralAsset: "AQUSDC",
    collateralAmount: 500,
    leverage: 3,
  },
  {
    message: "Deposit 100 BLUSDC at 2x and borrow XLM",
    collateralAsset: "BLUSDC",
    collateralAmount: 100,
    leverage: 2,
  },
] as const;

/** Dollar stables are $1, so collateral USD is the collateral amount. */
const expectedBorrowXlm = (collateralUsd: number, L: number) =>
  (collateralUsd * (L - 1)) / PRICES.XLM;

const writeSteps = (r: RoutedIntent) =>
  r.kind === "plan" ? r.steps.filter((s) => s.kind === "write") : [];

describe.each(REPRO)(
  "levered deposit+borrow survives the plan path — $message",
  ({ message, collateralAsset, collateralAmount, leverage }) => {
    it("THE LIVE BUG: never becomes a borrow leg with no amount", () => {
      const steps = extractPlanIR(message).steps;
      const borrowLegs = steps.filter((s) => s.op === "borrow");
      // Live, this was `borrow USDC / amount null` — unexecutable, and the reason the
      // run stopped after the deposit with "Amount missing for Borrow USDC".
      for (const b of borrowLegs) {
        expect(b.amount, "a borrow leg reached the plan with no size").toBeTruthy();
      }
    });

    it("keeps the position whole, with the borrow asset the user named", () => {
      const [step, ...rest] = extractPlanIR(message).steps;
      expect(rest).toHaveLength(0);
      expect(step.op).toBe("deposit_and_borrow");
      expect(step.asset).toBe(collateralAsset);
      expect(step.amount).toBe(collateralAmount);
      expect(step.leverage).toBe(leverage);
      expect(step.args?.borrow_asset).toBe("XLM");
    });

    it("never rewrites the stated XLM borrow to USDC", () => {
      const json = JSON.stringify(extractPlanIR(message).steps);
      expect(json).not.toMatch(/"borrow_asset":"[A-Z]*USDC"/);
      // And no leg is a bare `borrow` denominated in a USDC variant.
      for (const s of extractPlanIR(message).steps) {
        if (s.op === "borrow") expect(s.asset).toBe("XLM");
      }
    });

    it("does not clobber the router's already-correct deposit_and_borrow", () => {
      // The regression mechanism: a 2-step extracted plan outranked the single correct
      // write. Merged back to one step, it drops below the two-step bar and the route
      // survives — so this prompt reaches runWrite's oracle sizing.
      const routed = routeMessage(message);
      const after = preferExtractedPlan(routed!, message);
      expect(after.kind).toBe("write");
      const w = after as Extract<RoutedIntent, { kind: "write" }>;
      expect(w.op).toBe("deposit_and_borrow");
      expect(w.borrow_asset).toBe("XLM");
      expect(w.amount).toBe(collateralAmount);
      expect(w.leverage).toBe(leverage);
    });

    it("shows no USDC variant chips on either slot", () => {
      const step = extractPlanIR(message).steps[0];
      expect(
        ambiguousUsdcSlot({
          asset: step.asset ?? null,
          borrow_asset: (step.args?.borrow_asset as string) ?? null,
        }),
      ).toBeNull();
    });

    it("expands and sizes to a concrete XLM borrow — no clarification", () => {
      const step = extractPlanIR(message).steps[0];
      const expanded = expandPlanWrites([
        {
          kind: "write",
          op: step.op!,
          asset: step.asset ?? null,
          amount: step.amount ?? null,
          args: step.args,
        },
      ]);
      // Cross-asset stays whole so the executor — which has the oracle — prices it.
      expect(expanded).toHaveLength(1);
      const action = actionFromExpanded(expanded[0], {
        smartAccount: null,
        trader: null,
        minHf: null,
      });
      expect(action.borrow_asset).toBe("XLM");

      const sized = planLeverage(
        {
          collateralAsset: action.asset!,
          collateralAmount: action.amount!,
          leverage: action.leverage,
          borrowAsset: action.borrow_asset!,
          borrowAmount: action.borrow_amount,
        },
        PRICES,
      );
      expect("gap" in sized, "sizing asked a question it could compute").toBe(false);
      if ("gap" in sized) return;
      expect(sized.plan.borrowAsset).toBe("XLM");
      expect(sized.plan.borrowAmount).toBeCloseTo(
        expectedBorrowXlm(collateralAmount, leverage),
        4,
      );
      expect(sized.plan.borrowAmount).toBeGreaterThan(0);
    });
  },
);

/**
 * The LLM planner emits the same two legs and its plan does not pass through the clause
 * extractor, so the merge has to live somewhere every plan reaches. `sanitizePlan` does.
 */
describe("a plan that arrives already split is repaired too", () => {
  const llmPlan = (borrowAsset: string | null): RoutedIntent => ({
    kind: "plan",
    template_id: "llm_plan",
    summary: "deposit then borrow",
    steps: [
      { kind: "write", op: "deposit_collateral", asset: "BLUSDC", amount: 100, args: {} },
      { kind: "write", op: "borrow", asset: borrowAsset, amount: null, args: {} },
    ],
  });

  it("merges an LLM two-leg plan into one sized position", () => {
    const out = sanitizePlan(
      llmPlan("XLM") as Extract<RoutedIntent, { kind: "plan" }>,
      "Deposit 100 BLUSDC at 2x and borrow XLM",
    );
    const writes = writeSteps(out);
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe("deposit_and_borrow");
    expect(writes[0].args?.borrow_asset).toBe("XLM");
    expect(writes[0].args?.leverage).toBe(2);
  });

  it("the user's words beat a USDC the planner filled in", () => {
    // Product rule B: a stated XLM borrow is never rewritten to a USDC variant, no
    // matter which producer guessed otherwise.
    const out = sanitizePlan(
      llmPlan("USDC") as Extract<RoutedIntent, { kind: "plan" }>,
      "Deposit 100 BLUSDC at 2x and borrow XLM",
    );
    expect(writeSteps(out)[0].args?.borrow_asset).toBe("XLM");
  });
});

describe("the merge is narrow on purpose", () => {
  it("leaves an explicitly sized borrow as two independent legs", () => {
    // "borrow 50 XLM" is the user's own answer. Both legs are already determined and
    // execute fine; merging would let a leverage figure elsewhere override a typed one.
    const steps = coalesceLeveragedDepositBorrow(
      [
        { kind: "write", op: "deposit_collateral", asset: "BLUSDC", amount: 100 },
        { kind: "write", op: "borrow", asset: "XLM", amount: 50 },
      ],
      { leverage: 2, message: "Deposit 100 BLUSDC at 2x and borrow 50 XLM" },
    );
    expect(steps).toHaveLength(2);
    expect(steps[1].op).toBe("borrow");
    expect(steps[1].amount).toBe(50);
  });

  it("leaves the pair alone when no leverage was stated", () => {
    // Nothing to size from, so asking is the honest outcome — not a guessed multiplier.
    const steps = coalesceLeveragedDepositBorrow(
      [
        { kind: "write", op: "deposit_collateral", asset: "BLUSDC", amount: 100 },
        { kind: "write", op: "borrow", asset: "XLM", amount: null },
      ],
      { leverage: null, message: "Deposit 100 BLUSDC and borrow XLM" },
    );
    expect(steps).toHaveLength(2);
  });

  it("leaves unrelated legs untouched", () => {
    const steps = coalesceLeveragedDepositBorrow(
      [
        { kind: "write", op: "swap", asset: "XLM", amount: 10 },
        { kind: "write", op: "lend", asset: "BLUSDC", amount: 20 },
      ],
      { leverage: 2, message: "swap 10 XLM then lend 20 BLUSDC at 2x" },
    );
    expect(steps.map((s) => s.op)).toEqual(["swap", "lend"]);
  });

  it("does not merge a borrow that belongs to a later, separate leg", () => {
    // deposit → lend → borrow: the borrow is not adjacent to the deposit, so it is not
    // part of that levered position and must keep its own identity.
    const steps = coalesceLeveragedDepositBorrow(
      [
        { kind: "write", op: "deposit_collateral", asset: "BLUSDC", amount: 100 },
        { kind: "write", op: "lend", asset: "XLM", amount: 5 },
        { kind: "write", op: "borrow", asset: "XLM", amount: null },
      ],
      { leverage: 2, message: "deposit 100 BLUSDC, lend 5 XLM, borrow XLM at 2x" },
    );
    expect(steps.map((s) => s.op)).toEqual(["deposit_collateral", "lend", "borrow"]);
  });
});

/**
 * The approve round-trip is a second, separate place the borrow asset was lost.
 *
 * The plan CARD was correct — "Deposit 500 AQUSDC as collateral and borrow XLM at 3×
 * leverage" — and execution still ran `Borrow 1000 AQUSDC`, failing on chain with
 * HostError #13. Both facts are consistent: `freezePlan` never carried `borrow_asset`
 * into `PlanStepView`, so the client had nothing to echo back, `verifyApprovedPlan`
 * rebuilt the step without it, and `expandPlanWrites` read the position as same-asset —
 * borrowing collateral-amount × (L−1) = 1000 in AQUSDC units, which is the DOLLAR size
 * of the debt spent as the wrong token.
 *
 * This module's stated safety property is "what executes is what was approved". A slot
 * that is displayed but neither fingerprinted nor replayed breaks it in both directions.
 */
describe("the approve round-trip preserves the borrow asset", () => {
  const message = "Deposit 500 AqUSDC and take 3x leverage and borrow XLM in borrowed capital";
  const NOW = 1_770_000_000_000;

  const frozen = () => {
    const step = extractPlanIR(message).steps[0];
    return freezePlan(
      {
        kind: "plan",
        template_id: "extracted_multi_goal",
        summary: "Deposit 500 AQUSDC as collateral and borrow XLM at 3× leverage",
        steps: [
          {
            kind: "write",
            op: step.op!,
            asset: step.asset ?? null,
            amount: step.amount ?? null,
            leverage: step.leverage ?? null,
            args: step.args,
          },
        ],
      },
      NOW,
    );
  };

  /** Exactly what components/copilot/copilot-workspace.tsx sends on Approve & run. */
  const approvalPayload = (p: ReturnType<typeof freezePlan>) => ({
    plan_id: p.plan_id,
    created_at: p.created_at,
    steps: p.steps.map((s) => ({
      op: s.op,
      asset: s.asset,
      amount: s.amount,
      leverage: s.leverage,
      borrow_asset: s.borrow_asset ?? null,
    })),
  });

  it("freezePlan carries the loan slot into the view the client echoes back", () => {
    const [step] = frozen().steps;
    expect(step.op).toBe("deposit_and_borrow");
    expect(step.asset).toBe("AQUSDC");
    expect(step.borrow_asset).toBe("XLM");
    // And it is visible on the card, so a wrong loan asset can be caught by reading it.
    expect(step.label).toMatch(/XLM/);
  });

  it("THE LIVE BUG: replay expands to an XLM borrow, not 1000 AQUSDC", () => {
    const check = verifyApprovedPlan(approvalPayload(frozen()), NOW + 1_000);
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const expanded = expandPlanWrites(check.plan.steps);
    // Cross-asset stays whole so the executor prices it off the oracle. Live this split
    // here into deposit 500 + "borrow 1000 AQUSDC".
    expect(expanded).toHaveLength(1);
    expect(expanded[0].op).toBe("deposit_and_borrow");
    expect(expanded[0].borrow_asset).toBe("XLM");
    const action = actionFromExpanded(expanded[0], {
      smartAccount: null,
      trader: null,
      minHf: null,
    });
    expect(action.borrow_asset).toBe("XLM");
    // The number that actually reached the chain, and what it should be.
    expect(JSON.stringify(expanded)).not.toMatch(/"amount":1000,"asset":"AQUSDC"/);

    const sized = planLeverage(
      {
        collateralAsset: action.asset!,
        collateralAmount: action.amount!,
        leverage: action.leverage,
        borrowAsset: action.borrow_asset!,
        borrowAmount: action.borrow_amount,
      },
      PRICES,
    );
    expect("gap" in sized).toBe(false);
    if ("gap" in sized) return;
    expect(sized.plan.borrowAsset).toBe("XLM");
    expect(sized.plan.borrowAmount).toBeCloseTo(expectedBorrowXlm(500, 3), 4);
  });

  it("replay sets both spellings, so either expander reading works", () => {
    const check = verifyApprovedPlan(approvalPayload(frozen()), NOW + 1_000);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const [s] = check.plan.steps;
    expect(s.args?.borrow_asset).toBe("XLM");
    expect((s as { borrow_asset?: string | null }).borrow_asset).toBe("XLM");
  });

  it("the loan slot is part of the fingerprint, not just the display", () => {
    // An unhashed executable slot is one a client could change after approval. Stripping
    // it must be REJECTED, not silently executed as a same-asset borrow.
    const p = frozen();
    const stripped = {
      ...approvalPayload(p),
      steps: approvalPayload(p).steps.map((s) => ({ ...s, borrow_asset: null })),
    };
    const check = verifyApprovedPlan(stripped, NOW + 1_000);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe("fingerprint_mismatch");
  });

  it("two plans differing only in borrow asset do not share a fingerprint", () => {
    const base = { op: "deposit_and_borrow", asset: "AQUSDC", amount: 500, leverage: 3 };
    expect(planFingerprint([{ ...base, borrow_asset: "XLM" }])).not.toBe(
      planFingerprint([{ ...base, borrow_asset: "AQUSDC" }]),
    );
  });

  it("warns about a bare-USDC loan, not only bare-USDC collateral", () => {
    const p = freezePlan(
      {
        kind: "plan",
        template_id: "t",
        summary: "s",
        steps: [
          {
            kind: "write",
            op: "deposit_and_borrow",
            asset: "AQUSDC",
            amount: 500,
            args: { leverage: 3, borrow_asset: "USDC" },
          },
        ],
      },
      NOW,
    );
    expect(p.warnings.join(" ")).toMatch(/USDC is ambiguous/);
  });

  it("describes a 2-leg margin position as two legs, with no phantom supply", () => {
    const p = frozen();
    const levered = p.warnings.find((w) => /leverage, so it runs as/.test(w));
    expect(levered).toBeTruthy();
    expect(levered).toMatch(/2 transactions/);
    // It used to promise a third leg — "then supply" — that a margin deposit_and_borrow
    // never runs, on the card whose job is to say what will run.
    expect(levered).not.toMatch(/then supply/);
    expect(levered).toMatch(/borrow XLM against it/);
  });

  it("an unlevered plan is unaffected", () => {
    const p = freezePlan(
      {
        kind: "plan",
        template_id: "t",
        summary: "s",
        steps: [{ kind: "write", op: "lend", asset: "BLUSDC", amount: 20, args: {} }],
      },
      NOW,
    );
    expect(p.steps[0].borrow_asset).toBeNull();
    expect(p.steps[0].label).not.toMatch(/borrowing/);
    const check = verifyApprovedPlan(
      {
        plan_id: p.plan_id,
        created_at: p.created_at,
        steps: p.steps.map((s) => ({
          op: s.op,
          asset: s.asset,
          amount: s.amount,
          leverage: s.leverage,
          borrow_asset: s.borrow_asset ?? null,
        })),
      },
      NOW + 1_000,
    );
    expect(check.ok).toBe(true);
  });
});

describe("a bare asset name is still an asset", () => {
  it("'borrow XLM' with no figure does not become USDC", () => {
    // The narrow defect under the split: only amount+asset PAIRS were read, so a token
    // named without a number fell through to the "USDC" default.
    const steps = extractPlanIR("deposit 100 BLUSDC, lend 5 XLM, borrow XLM").steps;
    const borrow = steps.find((s) => s.op === "borrow");
    expect(borrow?.asset).toBe("XLM");
  });

  it("still reads the pair's asset when one is given", () => {
    const steps = extractPlanIR("deposit 100 BLUSDC, lend 5 XLM, borrow 50 AQUSDC").steps;
    expect(steps.find((s) => s.op === "borrow")?.asset).toBe("AQUSDC");
  });

  it("does not read collateral named after 'against' as the borrow asset", () => {
    const steps = extractPlanIR("deposit 100 BLUSDC, lend 5 XLM, borrow against my XLM").steps;
    const borrow = steps.find((s) => s.op === "borrow");
    expect(borrow?.asset).not.toBe("XLM");
  });
});
