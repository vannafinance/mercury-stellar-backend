/**
 * Phase 2 planner hygiene: never treat HF floors as amounts, prefer keyword
 * multi-goal plans when Vertex collapses a strategy to a single write.
 */

import { parseMinHealthFactor } from "./router";
import type { RoutedIntent } from "./types";

export type PlanStep = Extract<RoutedIntent, { kind: "plan" }>["steps"][number];

const ASSET_AMT_RE =
  /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC)\b/gi;

/** Collect explicit "N ASSET" pairs from the user message (never bare HF floors). */
export function explicitAssetAmounts(message: string): Array<{ amount: number; asset: string }> {
  const out: Array<{ amount: number; asset: string }> = [];
  const re = new RegExp(ASSET_AMT_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const amount = Number(m[1]);
    const asset = m[2].toUpperCase();
    if (Number.isFinite(amount) && amount > 0) out.push({ amount, asset });
  }
  return out;
}

/**
 * Reject amounts that are almost certainly health-factor floors mis-parsed as size.
 * e.g. "keep HF above 1.4" must never become amount=1.4.
 */
export function isLikelyHfFloorAmount(amount: number | null | undefined, message: string): boolean {
  if (amount == null || !Number.isFinite(amount)) return false;
  const floor = parseMinHealthFactor(message);
  if (floor != null && Math.abs(amount - floor) < 1e-9) {
    // Allow only if the user also wrote "N ASSET" with that same number.
    const explicit = explicitAssetAmounts(message);
    return !explicit.some((e) => Math.abs(e.amount - amount) < 1e-9);
  }
  // Typical HF floors are small decimals in (1, 5) with one decimal place.
  if (amount > 1 && amount < 5 && Math.abs(amount * 10 - Math.round(amount * 10)) < 1e-9) {
    if (/\b(hf|health\s*factor|liquidat)\b/i.test(message)) {
      const explicit = explicitAssetAmounts(message);
      if (!explicit.some((e) => Math.abs(e.amount - amount) < 1e-9)) return true;
    }
  }
  return false;
}

function countWriteSteps(plan: Extract<RoutedIntent, { kind: "plan" }>): number {
  return plan.steps.filter((s) => s.kind === "write").length;
}

/** Sanitize a plan's write steps (amounts + leverage on farm). */
export function sanitizePlan(
  plan: Extract<RoutedIntent, { kind: "plan" }>,
  message: string,
): Extract<RoutedIntent, { kind: "plan" }> {
  const explicit = explicitAssetAmounts(message);
  const leverageM = message.match(/(\d+(?:\.\d+)?)\s*x\b/i);
  const leverage =
    leverageM && Number.isFinite(Number(leverageM[1])) ? Number(leverageM[1]) : null;

  const steps = plan.steps.map((step) => {
    if (step.kind !== "write") return step;
    let amount = step.amount ?? null;
    if (isLikelyHfFloorAmount(amount, message)) amount = null;

    // Fill amount from matching "N ASSET" when missing
    if ((amount == null || !(amount > 0)) && step.asset) {
      const hit = explicit.find((e) => e.asset === String(step.asset).toUpperCase());
      if (hit) amount = hit.amount;
    }

    const op = (step.op || "").toLowerCase();
    const args = { ...(step.args || {}) };
    if (
      (op === "deploy_to_blend" || op === "supply_to_blend" || op === "deposit_and_borrow") &&
      leverage != null &&
      leverage > 1 &&
      args.leverage == null
    ) {
      args.leverage = leverage;
    }

    return {
      ...step,
      amount: amount != null && Number.isFinite(amount) && amount > 0 ? amount : null,
      args: Object.keys(args).length ? args : step.args,
    };
  });

  // Prefer a short product summary when missing
  let summary = plan.summary;
  if (!summary || !summary.trim()) {
    const parts = steps
      .filter((s) => s.kind === "write")
      .map((s) => {
        const a = s.amount != null ? `${s.amount} ` : "";
        const L =
          s.args?.leverage != null && Number(s.args.leverage) > 1
            ? ` at ${s.args.leverage}×`
            : "";
        return `${s.op} ${a}${s.asset ?? ""}${L}`.trim();
      });
    summary = parts.length ? `Strategy: ${parts.join(" → ")}` : plan.summary;
  }

  return { ...plan, steps, summary };
}

/**
 * When Vertex returns a single write but keywords built a multi-step plan,
 * prefer the keyword plan (amounts are safer). When both are plans, fill gaps.
 */
export function preferMultiGoalPlan(
  routed: RoutedIntent,
  keyword: RoutedIntent,
  message: string,
): RoutedIntent {
  if (keyword.kind !== "plan" || countWriteSteps(keyword) < 2) {
    return routed.kind === "plan" ? sanitizePlan(routed, message) : routed;
  }

  const kwSan = sanitizePlan(keyword, message);

  if (routed.kind !== "plan") {
    return kwSan;
  }

  // Merge: keep Vertex step order if it has ≥2 writes; fill missing amounts from keyword
  if (countWriteSteps(routed) < 2) {
    return kwSan;
  }

  const vx = sanitizePlan(routed, message);
  const kwByOp = new Map(
    kwSan.steps
      .filter((s) => s.kind === "write" && s.op)
      .map((s) => [String(s.op), s] as const),
  );

  const steps = vx.steps.map((step) => {
    if (step.kind !== "write" || !step.op) return step;
    const kw = kwByOp.get(step.op);
    if (!kw) return step;
    return {
      ...step,
      amount:
        step.amount != null && step.amount > 0
          ? step.amount
          : kw.amount != null && kw.amount > 0
            ? kw.amount
            : step.amount,
      asset: step.asset || kw.asset || null,
      args: {
        ...(kw.args || {}),
        ...(step.args || {}),
        leverage:
          (step.args?.leverage as number | undefined) ??
          (kw.args?.leverage as number | undefined),
      },
    };
  });

  return sanitizePlan({ ...vx, steps }, message);
}

/** True when the user message is a multi-domain strategy (for routing preference). */
export function looksLikeMultiGoal(message: string): boolean {
  const t = message.trim();
  if (t.length > 90) {
    const verbs =
      t.match(
        /\b(swap|lend|borrow|deposit|repay|farm|invest|supply|withdraw|redeem|park|deploy)\b/gi,
      ) || [];
    if (new Set(verbs.map((v) => v.toLowerCase())).size >= 2) return true;
  }
  if (/\b(park|lend|earn|yield)\b/i.test(t) && /\b(farm|blend|deploy)\b/i.test(t)) return true;
  if (/\bthen\b/i.test(t)) {
    const n = (t.match(/\b(lend|borrow|deposit|farm|supply|swap|invest|park|repay)\b/gi) || [])
      .length;
    if (n >= 2) return true;
  }
  if (/\b(and|then)\b/i.test(t) && /\b(health|liquidat|farm|earn|hf)\b/i.test(t)) return true;
  return false;
}
