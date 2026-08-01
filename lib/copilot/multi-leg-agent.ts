/**
 * Multi-leg agent runner (mcp-use inspired loop, Vanna-owned).
 *
 * Plan → expand nested multi-leg ops → execute each leg → observe → next.
 * Never invents hashes. Honest partial reports.
 *
 * @see docs/multi-leg-agent-plan.md
 */

import { copilotConfig } from "./config";
import { splitLeverageAmounts } from "./mcp-write";
import type { ChatResponse, CopilotAction, RoutedIntent } from "./types";

export type PlanStep = Extract<RoutedIntent, { kind: "plan" }>["steps"][number];

export type MultiLegStepStatus =
  | "pending"
  | "ok"
  | "error"
  | "skipped"
  | "needs_sign"
  | "blocked"
  | "clarification"
  | "stopped_hf";

export type MultiLegStep = {
  index: number;
  op: string;
  label: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  status: MultiLegStepStatus;
  message: string;
  tx_hash?: string | null;
  hf_after?: number | null;
};

export type ExpandedWrite = {
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label: string;
  multi_leg?: boolean;
};

/** Clean product labels for agent runs / step table (no "2× leg 2/3" clutter). */
export function humanWriteLabel(
  op: string,
  amount?: number | null,
  asset?: string | null,
  leverage?: number | null,
): string {
  const a = asset || "";
  const n = amount != null && Number.isFinite(amount) ? String(amount) : "";
  const qty = [n, a].filter(Boolean).join(" ").trim();
  switch (op) {
    case "lend":
    case "supply":
      return qty ? `Lend ${qty} on Earn` : "Lend on Earn";
    case "redeem":
      return qty ? `Redeem ${qty}` : "Redeem";
    case "deposit_collateral":
      return qty ? `Deposit ${qty} as collateral` : "Deposit collateral";
    case "withdraw_collateral":
      return qty ? `Withdraw ${qty} collateral` : "Withdraw collateral";
    case "borrow":
      return qty ? `Borrow ${qty}` : "Borrow";
    case "repay":
      return qty ? `Repay ${qty}` : "Repay";
    case "supply_to_blend":
    case "deploy_to_blend":
      return qty
        ? `Supply ${qty} to Blend${leverage != null && leverage > 1 ? ` at ${leverage}×` : ""}`
        : "Supply to Blend";
    case "deposit_and_borrow":
      return qty
        ? `Deposit and borrow ${qty}${leverage != null && leverage > 1 ? ` at ${leverage}×` : ""}`
        : "Deposit and borrow";
    case "create_account":
      return "Open margin account";
    default:
      return `${op.replace(/_/g, " ")}${qty ? ` ${qty}` : ""}${
        leverage != null && leverage > 1 ? ` at ${leverage}×` : ""
      }`.trim();
  }
}

/**
 * Expand high-level plan ops into atomic executable legs.
 * deploy_to_blend @ L>1 → deposit, borrow, supply_to_blend
 * deposit_and_borrow @ L>1 → deposit, borrow
 */
export function expandPlanWrites(steps: PlanStep[]): ExpandedWrite[] {
  const out: ExpandedWrite[] = [];

  for (const step of steps) {
    if (step.kind !== "write" || !(step.op || step.tool)) continue;
    const op = step.op || String(step.tool);
    const asset = step.asset ?? (step.args?.symbol as string) ?? null;
    const amount =
      step.amount ?? (step.args?.amount != null ? Number(step.args.amount) : null);
    const leverage =
      step.args?.leverage != null && Number.isFinite(Number(step.args.leverage))
        ? Number(step.args.leverage)
        : (step as { leverage?: number | null }).leverage != null &&
            Number.isFinite(Number((step as { leverage?: number | null }).leverage))
          ? Number((step as { leverage?: number | null }).leverage)
          : null;

    if ((op === "deploy_to_blend" || op === "supply_to_blend") && leverage != null && leverage > 1) {
      if (amount == null || !(amount > 0)) {
        out.push({
          op: "deploy_to_blend",
          asset,
          amount: null,
          leverage,
          label: humanWriteLabel("deploy_to_blend", null, asset, leverage) + " — need amount",
          multi_leg: true,
        });
        continue;
      }
      const { deposit, borrow } = splitLeverageAmounts(amount, leverage, null);
      const supplyAmt = borrow > 0 ? borrow : deposit;
      out.push({
        op: "deposit_collateral",
        asset,
        amount: deposit,
        label: humanWriteLabel("deposit_collateral", deposit, asset),
      });
      out.push({
        op: "borrow",
        asset,
        amount: borrow,
        label: humanWriteLabel("borrow", borrow, asset),
      });
      out.push({
        op: "supply_to_blend",
        asset,
        amount: supplyAmt,
        leverage: null,
        label: humanWriteLabel("supply_to_blend", supplyAmt, asset),
      });
      continue;
    }

    if (op === "deposit_and_borrow" && (leverage == null || leverage > 1)) {
      if (amount == null || !(amount > 0)) {
        out.push({
          op: "deposit_and_borrow",
          asset,
          amount: null,
          leverage: leverage ?? 2,
          label: humanWriteLabel("deposit_and_borrow", null, asset, leverage ?? 2) + " — need amount",
          multi_leg: true,
        });
        continue;
      }
      const L = leverage ?? 2;
      const { deposit, borrow } = splitLeverageAmounts(amount, L, null);
      out.push({
        op: "deposit_collateral",
        asset,
        amount: deposit,
        label: humanWriteLabel("deposit_collateral", deposit, asset),
      });
      out.push({
        op: "borrow",
        asset,
        amount: borrow,
        label: humanWriteLabel("borrow", borrow, asset),
      });
      continue;
    }

    out.push({
      op,
      asset,
      amount,
      leverage,
      label: humanWriteLabel(op, amount, asset, leverage),
      multi_leg: false,
    });
  }

  const cap = copilotConfig.multiLegMaxLegs;
  return out.slice(0, Math.min(12, Math.max(1, cap)));
}

export function formatMultiLegReport(opts: {
  summary: string;
  steps: MultiLegStep[];
  minHf?: number | null;
  finalHf?: number | null;
  smartAccount?: string | null;
}): string {
  const { summary, steps, minHf, finalHf, smartAccount } = opts;
  const lines: string[] = [];
  lines.push(summary || "Multi-step strategy");
  lines.push("");
  if (smartAccount) {
    lines.push(`Account ${smartAccount.slice(0, 8)}…${smartAccount.slice(-4)}`);
  }
  if (minHf != null) {
    lines.push(`Keep health factor ≥ ${minHf}`);
  }
  lines.push("");
  lines.push("Progress");
  for (const s of steps) {
    const mark =
      s.status === "ok"
        ? "Done"
        : s.status === "needs_sign"
          ? "Needs sign"
          : s.status === "stopped_hf"
            ? "Stopped (HF)"
            : s.status === "skipped"
              ? "Skipped"
              : s.status === "pending"
                ? "Pending"
                : s.status === "blocked"
                  ? "Blocked"
                  : s.status === "clarification"
                    ? "Needs input"
                    : s.status === "error"
                      ? "Failed"
                      : s.status;
    const hash = s.tx_hash ? ` · ${s.tx_hash.slice(0, 10)}…` : "";
    const hf =
      s.hf_after != null
        ? s.hf_after >= 999
          ? " · HF ∞"
          : ` · HF ≈ ${s.hf_after.toFixed(2)}`
        : "";
    lines.push(`${s.index}. ${mark} — ${s.label}${hash}${hf}`);
    if (s.message && s.status !== "ok" && s.status !== "pending") {
      // Drop internal multi-leg debug prefixes from nested write messages
      const clean = s.message
        .replace(/^multi-leg step \d+\/\d+:\s*/i, "")
        .slice(0, 200);
      if (clean) lines.push(`   ${clean}`);
    }
  }
  if (finalHf != null) {
    lines.push("");
    const hfLabel = finalHf >= 999 ? "∞" : finalHf.toFixed(2);
    lines.push(
      minHf != null
        ? `Final health ≈ ${hfLabel} (${finalHf >= minHf ? "above" : "below"} floor ${minHf}).`
        : `Final health ≈ ${hfLabel}.`,
    );
  }
  const anyFail = steps.some((s) =>
    ["error", "blocked", "stopped_hf", "needs_sign"].includes(s.status),
  );
  const allOk = steps.length > 0 && steps.every((s) => s.status === "ok");
  lines.push("");
  if (allOk) {
    lines.push("All steps finished.");
  } else if (anyFail) {
    lines.push(
      "Stopped early. Steps marked Done are on-chain; later steps were not run.",
    );
  }
  return lines.join("\n");
}

export function extractTxHash(res: ChatResponse): string | null {
  const h =
    res.execution?.tx_hash ||
    (res.data && typeof res.data === "object" && (res.data as any).tx_hash) ||
    (res.mcp as any)?.tx_hash ||
    null;
  return typeof h === "string" && h.length > 8 ? h : null;
}

export function actionFromExpanded(
  w: ExpandedWrite,
  ctx: { smartAccount: string | null; trader: string | null; minHf: number | null },
): CopilotAction {
  return {
    op: w.op,
    asset: w.asset ?? null,
    amount: w.amount ?? null,
    leverage: w.leverage ?? null,
    multi_leg: !!w.multi_leg,
    requires_amount: w.amount == null,
    requires_account: !["lend", "redeem", "create_account"].includes(w.op),
    smart_account: ctx.smartAccount,
    trader: ctx.trader,
    min_hf: ctx.minHf,
  };
}

/** Map ChatResponse kind to multi-leg step status. */
export function statusFromWriteResult(res: ChatResponse): MultiLegStepStatus {
  if (res.kind === "executed") return "ok";
  if (res.kind === "needs_auto_sign" || res.kind === "needs_wallet_sign") return "needs_sign";
  if (res.kind === "blocked") return "blocked";
  if (res.kind === "clarification") return "clarification";
  if (res.kind === "error") return "error";
  // preview / answer treated as incomplete for writes
  if (res.kind === "preview") return "needs_sign";
  return "error";
}

/** Ops that change margin position and warrant a post-leg HF sample. */
export function affectsHealth(op: string): boolean {
  return [
    "deposit_collateral",
    "withdraw_collateral",
    "borrow",
    "repay",
    "deposit_and_borrow",
    "deploy_to_blend",
    "supply_to_blend",
  ].includes(op);
}

/**
 * Build client next_step chain for remaining expanded legs (max 2 deep via follow_up).
 * Used when auto-sign pauses mid-plan.
 */
export function remainingNextStep(
  remaining: ExpandedWrite[],
  stepIndex1Based: number,
  totalSteps: number,
): NonNullable<ChatResponse["next_step"]> | null {
  if (!remaining.length) return null;
  const [first, ...rest] = remaining;
  const head: NonNullable<ChatResponse["next_step"]> = {
    op: first.op,
    asset: first.asset ?? null,
    amount: first.amount ?? null,
    leverage: first.leverage ?? null,
    label: first.label,
    step: stepIndex1Based,
    total_steps: totalSteps,
    follow_up: null,
  };
  if (rest.length > 0) {
    const second = rest[0];
    head.follow_up = {
      op: second.op,
      asset: second.asset ?? null,
      amount: second.amount ?? null,
      leverage: second.leverage ?? null,
      label: second.label,
      step: stepIndex1Based + 1,
      total_steps: totalSteps,
    };
  }
  return head;
}

/** Map MultiLegStep → execution.steps row. */
export function toExecutionStep(s: MultiLegStep): {
  tool: string;
  label: string;
  status: string;
  message: string;
  tx_hash?: string | null;
  hf_after?: number | null;
} {
  return {
    tool: s.op,
    label: s.label,
    status: s.status,
    message: s.message,
    tx_hash: s.tx_hash ?? null,
    hf_after: s.hf_after ?? null,
  };
}

/** Turn MCP/network noise into a short user-facing reason. */
export function humanizeLegError(raw: string | null | undefined): string {
  const m = (raw || "").trim();
  if (!m) return "Something went wrong on this step.";
  if (/fetch failed|failed to fetch|networkerror|econnrefused|enotfound|etimedout|abort(ed)?|timeout/i.test(m)) {
    return "Could not reach the Vanna MCP server (network). Check you’re online, MCP URL is up, then retry.";
  }
  if (/401|403|unauthorized|rejected the token|workos/i.test(m)) {
    return "MCP auth failed — refresh the page or check WorkOS credentials.";
  }
  if (/Budget|ExceededLimit/i.test(m)) {
    return "Soroban resource budget exceeded on this account — try a smaller size or retry.";
  }
  // Drop internal multi-leg debug prefixes
  return m.replace(/^multi-leg step \d+\/\d+:\s*/i, "").slice(0, 220);
}

/** One-line headline for strategy UI (not the full text dump). */
export function multiLegHeadline(steps: MultiLegStep[]): string {
  const failed = steps.find((s) => s.status === "error" || s.status === "blocked");
  if (failed) {
    return `Stopped at “${failed.label}” — later steps were not run.`;
  }
  if (steps.some((s) => s.status === "stopped_hf")) {
    return "Stopped to protect your health-factor floor.";
  }
  if (steps.some((s) => s.status === "needs_sign")) {
    return "Paused for signature — finish signing to continue.";
  }
  if (steps.some((s) => s.status === "clarification")) {
    return "Need a bit more detail before continuing.";
  }
  if (steps.length > 0 && steps.every((s) => s.status === "ok")) {
    return "All strategy steps finished.";
  }
  if (steps.some((s) => s.status === "ok")) {
    return "Partial progress — some steps finished on-chain.";
  }
  return "Strategy did not complete.";
}

/** Clean payload for the UI card — never dump internal plan flags into FactsGrid. */
export function multiLegUiData(opts: {
  steps: MultiLegStep[];
  summary: string;
  minHf?: number | null;
  finalHf?: number | null;
  smartAccount?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    multi_leg: true,
    multi_leg_steps: opts.steps.map((s) => ({
      ...s,
      message: humanizeLegError(s.message),
    })),
    strategy_summary: opts.summary,
    min_hf: opts.minHf ?? null,
    final_hf: opts.finalHf ?? null,
    smart_account: opts.smartAccount ?? null,
    headline: multiLegHeadline(opts.steps),
    ...(opts.extra || {}),
  };
}
