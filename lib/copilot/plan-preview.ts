/**
 * Plan-preview sizing: freeze a routed plan for approval before anything executes.
 *
 * Extracted from handle.ts so that file can shrink toward write execution. Copilot
 * free-text never reaches this (`investigation_owns_planning`); assistant / page
 * surfaces still do.
 */
import { findBalanceFraction } from "./amount-intent";
import { fetchLeveragePrices } from "./leverage-plan";
import { lpSides, readAmmOtherPerXlm } from "./lp-pair";
import { staticStepBlocker } from "./mcp-write";
import type { MCPClient } from "./mcp-client";
import {
  expandPlanWrites,
  materializeLeveragePriceSymbols,
  materializeLeverageWrites,
} from "./multi-leg-agent";
import { freezePlan } from "./plan-approval";
import { toSlots } from "./registry/intent";
import { findLeverage } from "./router";
import { coalesceLeveragedDepositBorrow } from "./step-extractor";
import type { ChatResponse, RoutedIntent } from "./types";

/**
 * Plan ops that can be sized as a share of a live balance.
 *
 * Mirrors `FRACTION_SIZED_OPS` in registry/intent, minus the ops a plan never produces
 * as a bare leg. Deliberately excludes `borrow` and `deposit_and_borrow`: their size
 * comes from the leverage multiple, so a share would contradict it.
 */
const FRACTION_SIZED_PLAN_OPS = new Set([
  "lend",
  "supply",
  "deposit_collateral",
  "withdraw_collateral",
  "repay",
]);

export function freezeLeveragedPlanPreview(
  steps: Array<{ op: string; asset: string | null; amount: number | null; leverage?: number | null; args?: Record<string, unknown> }>,
  opts: { templateId: string; summary: string; requestId: string },
): ChatResponse {
  const frozen = freezePlan(
    { kind: "plan", template_id: opts.templateId, summary: opts.summary, steps: steps.map((s) => ({ kind: "write" as const, ...s })) },
    Date.now(),
  );
  console.warn(`[copilot] plan_preview ${frozen.plan_id} (${frozen.steps.length} steps) awaiting approval — leveraged position`);
  const lines = frozen.steps.map((s) => `${s.n}. ${s.label}`);
  return {
    kind: "plan_preview",
    message: [
      `Here's the plan — nothing has run yet.`,
      "",
      ...lines,
      "",
      ...(frozen.warnings.length ? frozen.warnings.map((w) => `Note: ${w}`) : []),
      "Approve it to run, or tell me what to change.",
    ]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n"),
    plan: frozen,
    intent: { template_id: "plan_preview", slots: { plan_id: frozen.plan_id } },
    request_id: opts.requestId,
  };
}

/**
 * Size, block, and freeze a routed plan. Returns a plan_preview, a blocked
 * response, or null when the freeze produced no steps (caller falls through to
 * `runPlan`).
 */
export async function previewRoutedPlan(input: {
  routed: Extract<RoutedIntent, { kind: "plan" }>;
  message: string;
  mcp: MCPClient;
  userId: string;
  request_id: string;
}): Promise<ChatResponse | null> {
  let routed = input.routed;
  const share = findBalanceFraction(input.message);
  if (share != null) {
    routed = {
      ...routed,
      steps: routed.steps.map((s) =>
        s.kind === "write" &&
        s.amount == null &&
        (s as { fraction?: number | null }).fraction == null &&
        FRACTION_SIZED_PLAN_OPS.has(String(s.op))
          ? { ...s, fraction: share, args: { ...(s.args || {}), fraction: share } }
          : s,
      ),
    };
  }
  routed = {
    ...routed,
    steps: coalesceLeveragedDepositBorrow(routed.steps, {
      leverage: findLeverage(input.message),
      message: input.message,
    }),
  };
  if (routed.steps.some((s) => s.kind === "write" && s.op === "deposit_and_borrow" && Number(s.leverage) > 1)) {
    try {
      const rawExpanded = expandPlanWrites(routed.steps);
      const priceSymbols = materializeLeveragePriceSymbols(rawExpanded);
      const prices = priceSymbols.length ? await fetchLeveragePrices(input.mcp, priceSymbols, input.userId) : {};
      const materialized = materializeLeverageWrites(rawExpanded, prices);
      if (materialized.ok) {
        routed = {
          ...routed,
          steps: materialized.writes.map((w) => ({
            kind: "write" as const,
            op: w.op,
            asset: w.asset ?? null,
            amount: w.amount ?? null,
            leverage: w.leverage ?? null,
            args: toSlots(w),
          })),
        };
      }
    } catch {
      /* best-effort — an unreachable oracle must never block the preview */
    }
  }
  for (const s of routed.steps) {
    if (s.kind !== "write" || !s.op) continue;
    const slots = toSlots(s);
    const blocked = staticStepBlocker(String(s.op), {
      asset: (slots.asset as string) ?? s.asset ?? null,
      token_a: (slots.token_a as string) ?? null,
      token_b: (slots.token_b as string) ?? null,
    });
    if (blocked) {
      return { kind: "blocked", message: blocked, intent: { template_id: String(s.op) }, request_id: input.request_id };
    }
  }
  const frozen = freezePlan(routed, Date.now());
  if (!frozen.steps.length) return null;
  const unsizedLp = routed.steps.find(
    (s) => s.kind === "write" && s.op === "add_liquidity" && !(typeof s.amount === "number" && s.amount > 0),
  );
  if (unsizedLp && unsizedLp.kind === "write") {
    const sides = lpSides(
      unsizedLp.asset,
      typeof unsizedLp.args?.token_b === "string" ? unsizedLp.args.token_b : null,
      typeof unsizedLp.args?.venue === "string" ? unsizedLp.args.venue : null,
    );
    frozen.lp_input = {
      sides,
      other_per_xlm: await readAmmOtherPerXlm(sides[1]),
    };
  }
  console.warn(`[copilot] plan_preview ${frozen.plan_id} (${frozen.steps.length} steps) awaiting approval`);
  const lines = frozen.steps.map((s) => `${s.n}. ${s.label}`);
  return {
    kind: "plan_preview",
    message: [
      `Here's the plan — nothing has run yet.`,
      "",
      ...lines,
      "",
      ...(frozen.warnings.length ? frozen.warnings.map((w) => `Note: ${w}`) : []),
      frozen.warnings.length ? "" : "",
      "Approve it to run, or tell me what to change.",
    ]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n"),
    plan: frozen,
    intent: { template_id: "plan_preview", slots: { plan_id: frozen.plan_id } },
    request_id: input.request_id,
  };
}
