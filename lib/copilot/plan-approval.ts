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
  /** Things the user should read before approving. */
  warnings: string[];
}

type PlanIntent = Extract<RoutedIntent, { kind: "plan" }>;

const VENUE_BY_OP: Record<string, PlanStepView["venue"]> = {
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

function labelFor(op: string, asset: string | null, amount: number | null, venue: PlanStepView["venue"]): string {
  const verb = OP_VERB[op] ?? op.replace(/_/g, " ");
  if (op === "create_account") return "Open your margin account";
  const qty = amount != null ? `${amount} ` : "";
  const sym = asset ?? "";
  const tail = VENUE_SUFFIX[venue];
  return [verb, `${qty}${sym}`.trim(), tail].filter(Boolean).join(" ");
}

/**
 * Fingerprint the executable content of a plan.
 *
 * Only the fields that change what happens on-chain are hashed — labels and summaries
 * are presentation, and including them would break approval on a harmless copy edit.
 */
export function planFingerprint(steps: Array<Pick<PlanStepView, "op" | "asset" | "amount" | "leverage">>): string {
  const canonical = steps
    .map((s) => `${s.op}|${s.asset ?? ""}|${s.amount ?? ""}|${s.leverage ?? ""}`)
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
      return { n: i + 1, op, asset, amount, leverage, label: labelFor(op, asset, amount, venue), venue };
    });

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
  if (steps.some((s) => s.asset === "USDC")) {
    warnings.push(
      "USDC is ambiguous on this network (BLUSDC, AQUSDC, SOUSDC) — I'll ask which one before that leg runs.",
    );
  }

  if (steps.some((s) => s.venue === "farm") && steps.some((s) => s.venue === "earn")) {
    warnings.push("This plan touches both Earn and Farm — check each step is against the product you meant.");
  }

  // Every leg needs its own signature; there is no batching today.
  if (steps.length > 1) {
    warnings.push(`${steps.length} separate signatures — the plan stops if you cancel partway.`);
  }

  return {
    plan_id: planFingerprint(steps),
    summary: plan.summary?.trim() || "Multi-step strategy",
    steps,
    created_at: nowMs,
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
        args: {},
        asset: s.asset ?? null,
        amount: s.amount ?? null,
      })),
    },
  };
}
