/**
 * The finished reply for a run: what actually happened, in the terms the user acts in.
 *
 * 24 Sep, owner: "supply 5 XLM to blend. All 1 step completed on-chain." is a status line,
 * not an answer. The reply should say what was done and what it now means, e.g. "Done.
 * Supplied 5 XLM to Blend. It's earning about 450.73% APY." Every figure here comes from
 * the run itself (settled steps), the rates read for the plan, or the plan's own sized
 * figures. Nothing is re-derived from the user's wording.
 */
import { OP_FLOW, type WorkflowOp, type WorkflowView } from "../workflow/types";
import { resolveAssetDef } from "../registry/assets";
import type { RateComparison } from "./rate-comparison";
import { pct, shownApyPct } from "./apy";

/**
 * What each op did, in the past tense. One entry per op, and the type makes it exhaustive,
 * so a new op cannot be left out. This is the same per-op copy as `verbOf` in plan.ts, not a
 * list matched against anything the user wrote.
 */
const DONE: Record<WorkflowOp, string> = {
  lend: "Lent", redeem: "Redeemed", deposit_collateral: "Deposited", withdraw_collateral: "Withdrew",
  borrow: "Borrowed", repay: "Repaid", supply_blend: "Supplied", blend_withdraw: "Withdrew",
  swap: "Swapped", remove_liquidity: "Removed", add_liquidity: "Added",
};

/** Beyond this many steps, the reply names the plan instead of listing every step. */
const LISTED_STEPS = 3;

type Step = WorkflowView["steps"][number];

/**
 * A step's own label turned into what was done. The label is ours (plan.ts builds every one
 * as "<verb> <amount> <asset> <where>"), so swapping its first word for the past tense keeps
 * the amount and venue exactly as the card showed them.
 */
function doneClause(step: Step): string {
  const rest = step.label.trim().split(/\s+/).slice(1).join(" ");
  return `${DONE[step.op as WorkflowOp] ?? step.op} ${rest}`.trim();
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The read rate for a settled step that earns or pays one, in the convention its page uses. */
function rateSentence(steps: readonly Step[], comparisons: readonly RateComparison[]): string | null {
  const parts: string[] = [];
  for (const step of steps) {
    const kind = OP_FLOW[step.op as WorkflowOp]?.rate;
    if (!kind) continue;
    const row = comparisons.find((comparison) => comparison.asset === step.asset);
    const apr = kind === "earn_supply" ? row?.earnSupplyApr : kind === "blend_supply" ? row?.blendSupplyApr : row?.marginBorrowApr;
    if (apr == null || !Number.isFinite(Number(apr))) continue;
    const label = resolveAssetDef(step.asset)?.displayLabel ?? step.asset;
    const figure = pct(shownApyPct(kind, apr));
    parts.push(kind === "earn_borrow" ? `the ${label} borrow costs about ${figure}% a year` : `it's earning about ${figure}% APY`);
  }
  if (!parts.length) return null;
  const sentence = [...new Set(parts)].join(", and ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export interface CompletionContext {
  /** The plan's title, used when there are too many steps to list. */
  title?: string | null;
  comparisons?: readonly RateComparison[];
  /** The plan's own projected health factor after it ran, when it sized one. */
  healthFactorAfter?: string | null;
  repaysAllDebt?: boolean;
}

/** The reply once a run has finished or stopped, or null while it is still going. */
export function completionReply(view: WorkflowView, context: CompletionContext = {}): string | null {
  const settled = view.steps.filter((step) => step.status === "settled");
  const finished = view.status === "completed" ||
    ((view.status === "blocked" || view.status === "cancelled") && settled.length > 0);
  if (!finished) return null;
  const total = view.steps.length;
  const listed = settled.length <= LISTED_STEPS
    ? settled.map((step, index) => (index ? lowerFirst(doneClause(step)) : doneClause(step))).join(", then ")
    : null;
  const title = context.title?.trim() || view.objective;

  const lead = view.status === "completed"
    ? listed ? `Done. ${listed}.` : `Done. ${title}: all ${total} steps went through.`
    : `${settled.length} of ${total} steps went through${view.status === "cancelled" ? " before you cancelled" : ""}. ${
        listed ? `${listed}.` : ""} The rest was not submitted.`;

  const tail: string[] = [];
  const rate = rateSentence(settled, context.comparisons ?? []);
  if (rate) tail.push(rate);
  if (view.status === "completed" && context.repaysAllDebt) tail.push("No debt remains.");
  else if (view.status === "completed" && context.healthFactorAfter && Number.isFinite(Number(context.healthFactorAfter))) {
    tail.push(`Your health factor should now be about ${Number(context.healthFactorAfter).toFixed(2)}.`);
  }
  return [lead.replace(/\s+/g, " ").trim(), ...tail].join(" ");
}
