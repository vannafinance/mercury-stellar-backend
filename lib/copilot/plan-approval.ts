/**
 * Plan → approve → execute.
 *
 * Multi-leg prompts used to go straight from text to "sign this". The decomposition
 * was already correct — "deposit 10 XLM, borrow 5 USDC, then supply that to Blend"
 * produced three ordered steps — but the user never saw it before the first signature
 * request. The only check on a wrong plan was the wallet prompt, which shows one leg at
 * a time and cannot show intent. A prompt whose condition had been dropped ("if my
 * health factor is above 2, borrow…") reached that prompt looking completely ordinary.
 *
 * The safety property that matters is: WHAT EXECUTES IS WHAT WAS APPROVED. That rules
 * out re-deriving the plan on approval — running the model twice can produce two
 * different plans, and the user only ever saw the first. So the plan is frozen,
 * fingerprinted, and replayed verbatim.
 *
 *   1. FREEZE       build and annotate the steps, return them, execute nothing
 *   2. FINGERPRINT  hash the steps into plan_id; approval must present a matching hash
 *   3. REPLAY       an approved plan skips routing entirely and goes to the executor
 *   4. EXPIRE       plans are built on live prices and health; stale ones re-plan
 *
 * Replay also removes an LLM round-trip, so approving is faster than the old path.
 */

import { createHash } from "crypto";
import type { RoutedIntent } from "./types";

/** A plan is built on live prices and account health; both move. */
export const PLAN_TTL_MS = 5 * 60_000;

export interface PlanStepView {
  n: number;
  op: string;
  asset: string | null;
  amount: number | null;
  leverage: number | null;
  /**
   * The loan asset, when it differs from the collateral — a first-class slot, not a
   * detail of `asset`.
   *
   * It has to survive the approve round-trip for the same reason `leverage` does, and
   * it did not: a plan approved as "deposit 500 AQUSDC, borrow XLM at 3×" replayed with
   * this slot empty, `expandPlanWrites` then read the position as same-asset, and the
   * user got `borrow 1000 AQUSDC` — the dollar value of the debt spent as collateral
   * tokens, which failed on chain with a contract error. A different trade from the one
   * that was approved, which is precisely what this module exists to prevent.
   */
  borrow_asset: string | null;
  /** Human label, e.g. "Deposit 10 XLM as margin collateral". */
  label: string;
  /** Which product this leg touches, so venue mistakes are visible. */
  venue: "earn" | "margin" | "farm" | "wallet" | "other";
}

export interface FrozenPlan {
  plan_id: string;
  summary: string;
  steps: PlanStepView[];
  created_at: number;
  /**
   * Total on-chain legs, which is what the user will actually be asked to sign.
   * Higher than steps.length whenever a step is levered — see legCount().
   */
  signature_count: number;
  /** Things the user should read before approving. */
  warnings: string[];
}

type PlanIntent = Extract<RoutedIntent, { kind: "plan" }>;

/**
 * Exported so the live run card badges legs from the same table the plan card does.
 * A second copy would drift, and a leg labelled with the wrong venue is precisely the
 * mistake the badge exists to prevent.
 */
export const VENUE_BY_OP: Record<string, PlanStepView["venue"]> = {
  lend: "earn",
  redeem: "earn",
  deposit_collateral: "margin",
  withdraw_collateral: "margin",
  borrow: "margin",
  repay: "margin",
  deposit_and_borrow: "margin",
  settle_account: "margin",
  close_account: "margin",
  create_account: "margin",
  deploy_to_blend: "farm",
  supply_to_blend: "farm",
  add_liquidity: "farm",
  remove_liquidity: "farm",
  swap: "other",
};

const OP_VERB: Record<string, string> = {
  lend: "Supply",
  redeem: "Redeem",
  deposit_collateral: "Deposit",
  withdraw_collateral: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
  deposit_and_borrow: "Deposit and borrow against",
  deploy_to_blend: "Supply",
  supply_to_blend: "Supply",
  create_account: "Open",
  settle_account: "Settle",
  close_account: "Close",
  swap: "Swap",
  add_liquidity: "Add liquidity with",
  remove_liquidity: "Remove liquidity from",
};

const VENUE_SUFFIX: Record<PlanStepView["venue"], string> = {
  earn: "into the Vanna earn pool",
  margin: "on your margin account",
  farm: "into Blend",
  wallet: "in your wallet",
  other: "",
};

function labelFor(
  op: string,
  asset: string | null,
  amount: number | null,
  venue: PlanStepView["venue"],
  leverage: number | null,
  borrowAsset: string | null = null,
): string {
  const verb = OP_VERB[op] ?? op.replace(/_/g, " ");
  if (op === "create_account") return "Open your margin account";
  const qty = amount != null ? `${amount} ` : "";
  const sym = asset ?? "";
  const tail = VENUE_SUFFIX[venue];
  // Leverage changes what the step does, so it belongs in the label. "farm 10 BLUSDC at
  // 2x" was rendering as "Supply 10 BLUSDC into Blend", which reads as an unlevered
  // supply and hides the borrow the leverage implies.
  const lev = leverage != null && leverage > 1 ? `at ${leverage}× leverage` : "";
  // Which token the debt is in, when it is not the collateral. The step read "Deposit
  // and borrow against 500 AQUSDC … at 3× leverage" — true, but silent about the one
  // slot the user stated explicitly, so a wrong borrow asset was invisible on the very
  // card meant to catch it.
  const loan =
    borrowAsset && asset && borrowAsset.toUpperCase() !== asset.toUpperCase()
      ? `borrowing ${borrowAsset}`
      : "";
  return [verb, `${qty}${sym}`.trim(), tail, loan, lev].filter(Boolean).join(" ");
}

/**
 * On-chain legs this step becomes, and therefore signatures.
 *
 * Mirrors expandPlanWrites() in multi-leg-agent.ts: a levered farm is not one
 * transaction, it is deposit → borrow → supply. Counting steps instead of legs told the
 * user "2 signatures" for a plan that actually asks for four.
 */
function legCount(op: string, leverage: number | null): number {
  const levered = leverage != null && leverage > 1;
  if (!levered) return 1;
  if (op === "deploy_to_blend" || op === "supply_to_blend") return 3;
  if (op === "deposit_and_borrow") return 2;
  return 1;
}

/**
 * Fingerprint the executable content of a plan.
 *
 * Only the fields that change what happens on-chain are hashed — labels and summaries
 * are presentation, and including them would break approval on a harmless copy edit.
 */
export function planFingerprint(
  steps: Array<
    Pick<PlanStepView, "op" | "asset" | "amount" | "leverage"> & {
      borrow_asset?: string | null;
    }
  >,
): string {
  const canonical = steps
    .map(
      (s) =>
        // borrow_asset is hashed because it changes what happens on-chain — an
        // unhashed executable slot is one a client could alter after approval, which
        // is the hole this fingerprint exists to close.
        `${s.op}|${s.asset ?? ""}|${s.amount ?? ""}|${s.leverage ?? ""}|${s.borrow_asset ?? ""}`,
    )
    .join(";");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Turn a routed plan into something a user can read and approve. */
export function freezePlan(plan: PlanIntent, nowMs: number): FrozenPlan {
  const steps: PlanStepView[] = plan.steps
    .filter((s) => s.kind === "write" && s.op)
    .map((s, i) => {
      const op = String(s.op);
      const venue = VENUE_BY_OP[op] ?? "other";
      const asset = s.asset ?? null;
      const amount = typeof s.amount === "number" && Number.isFinite(s.amount) ? s.amount : null;
      const leverage =
        typeof (s as { leverage?: unknown }).leverage === "number"
          ? ((s as { leverage?: number }).leverage as number)
          : null;
      // Producers spell this either way: the clause extractor and the coalesce pass put
      // it in `args.borrow_asset`, the router puts it on the step. Read both, or the
      // slot is dropped depending on which path built the plan.
      const fromArgs = (s.args as { borrow_asset?: unknown } | undefined)?.borrow_asset;
      const fromStep = (s as { borrow_asset?: unknown }).borrow_asset;
      const rawBorrow = typeof fromArgs === "string" ? fromArgs : fromStep;
      const borrow_asset =
        typeof rawBorrow === "string" && rawBorrow.trim() ? rawBorrow.trim() : null;
      return {
        n: i + 1,
        op,
        asset,
        amount,
        leverage,
        borrow_asset,
        label: labelFor(op, asset, amount, venue, leverage, borrow_asset),
        venue,
      };
    });

  const signatureCount = steps.reduce((n, s) => n + legCount(s.op, s.leverage), 0);
  const warnings: string[] = [];

  // A missing amount becomes a prompt mid-execution, after earlier legs have already
  // settled on-chain. Better to say so while the whole thing can still be cancelled.
  const noAmount = steps.filter((s) => s.amount == null && s.op !== "create_account");
  if (noAmount.length) {
    warnings.push(
      `Step ${noAmount.map((s) => s.n).join(" and ")} has no amount yet — I'll have to ask once it gets there.`,
    );
  }

  // "USDC" is three different tokens here, and picking the wrong one is unrecoverable.
  // Checked on BOTH slots: a bare-USDC loan against a specific collateral is just as
  // ambiguous, and only the collateral was being looked at.
  if (steps.some((s) => s.asset === "USDC" || s.borrow_asset === "USDC")) {
    warnings.push(
      "USDC is ambiguous on this network (BLUSDC, AQUSDC, SOUSDC) — I'll ask which one before that leg runs.",
    );
  }

  if (steps.some((s) => s.venue === "farm") && steps.some((s) => s.venue === "earn")) {
    warnings.push("This plan touches both Earn and Farm — check each step is against the product you meant.");
  }

  // A levered step is several transactions, so say what it expands into rather than
  // letting "2 steps" imply two signatures.
  const levered = steps.filter((s) => legCount(s.op, s.leverage) > 1);
  for (const s of levered) {
    const n = legCount(s.op, s.leverage);
    // Say what the legs ACTUALLY are. This read "…borrow against it, then supply" for
    // every levered step, but a margin deposit_and_borrow is two legs and supplies
    // nothing — describing a third leg that never runs on the card whose job is to
    // show what will run.
    const loan = s.borrow_asset && s.borrow_asset !== s.asset ? ` ${s.borrow_asset}` : "";
    const legs =
      n === 2
        ? `deposit ${s.asset ?? ""} as collateral, then borrow${loan} against it`
        : `deposit ${s.asset ?? ""} as collateral, borrow${loan} against it, then supply`;
    warnings.push(
      `Step ${s.n} is ${s.leverage}× leverage, so it runs as ${n} transactions: ` +
        `${legs}. The borrow is what creates the leverage.`.replace(/\s+/g, " "),
    );
  }

  // Every leg needs its own signature; there is no batching today.
  if (signatureCount > 1) {
    warnings.push(
      `${signatureCount} separate signatures — the plan stops if you cancel partway.`,
    );
  }

  return {
    plan_id: planFingerprint(steps),
    summary: plan.summary?.trim() || "Multi-step strategy",
    steps,
    created_at: nowMs,
    signature_count: signatureCount,
    warnings,
  };
}

/** What the client sends back when the user presses Approve. */
export interface ApprovedPlan {
  plan_id: string;
  created_at: number;
  steps: Array<{
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    /** The loan slot. Must round-trip — see PlanStepView.borrow_asset. */
    borrow_asset?: string | null;
  }>;
}

export type ApprovalCheck =
  | { ok: true; plan: PlanIntent }
  | { ok: false; reason: string; message: string };

/**
 * Validate an approval before anything executes.
 *
 * Rejects rather than repairs. A plan that does not match its fingerprint, or that was
 * built too long ago, is not a plan to fix silently — it is one to show again.
 */
export function verifyApprovedPlan(approved: ApprovedPlan, nowMs: number): ApprovalCheck {
  if (!approved?.steps?.length) {
    return { ok: false, reason: "empty", message: "That plan had no steps left to run. Tell me what you'd like to do." };
  }

  const age = nowMs - Number(approved.created_at || 0);
  if (!Number.isFinite(age) || age < 0 || age > PLAN_TTL_MS) {
    return {
      ok: false,
      reason: "expired",
      message:
        "That plan is more than a few minutes old, and it was built on prices and a health factor that have since moved. " +
        "Ask me again and I'll draw up a fresh one.",
    };
  }

  const recomputed = planFingerprint(
    approved.steps.map((s) => ({
      op: s.op,
      asset: s.asset ?? null,
      amount: s.amount ?? null,
      leverage: s.leverage ?? null,
      borrow_asset: s.borrow_asset ?? null,
    })),
  );
  if (recomputed !== approved.plan_id) {
    return {
      ok: false,
      reason: "fingerprint_mismatch",
      message:
        "These steps don't match the plan you approved, so I've stopped rather than run something you haven't seen. " +
        "Ask again and approve the new plan.",
    };
  }

  return {
    ok: true,
    plan: {
      kind: "plan",
      template_id: "approved_plan",
      summary: "Approved plan",
      steps: approved.steps.map((s) => ({
        kind: "write" as const,
        op: s.op,
        // Leverage must survive the replay. expandPlanWrites() reads it from either
        // step.args.leverage or step.leverage, and dropping it turned an approved
        // "deploy_to_blend 10 BLUSDC at 2x" into a plain 1x supply — a silently
        // different trade from the one the user approved. Both spellings are set so a
        // change to which one the expander prefers cannot reintroduce this.
        //
        // borrow_asset is exactly the same hazard and was exactly the same bug: an
        // approved "deposit 500 AQUSDC, borrow XLM at 3×" replayed without it, so
        // expandPlanWrites saw a same-asset position and emitted `borrow 1000 AQUSDC`
        // — the USD size of the debt as collateral tokens. It failed on chain, which
        // is the lucky outcome; the unlucky one is a wrong borrow that succeeds. Set in
        // both spellings for the same reason as leverage.
        args: {
          ...(s.leverage != null ? { leverage: s.leverage } : {}),
          ...(s.borrow_asset ? { borrow_asset: s.borrow_asset } : {}),
        },
        leverage: s.leverage ?? null,
        asset: s.asset ?? null,
        amount: s.amount ?? null,
        borrow_asset: s.borrow_asset ?? null,
      })),
    },
  };
}
