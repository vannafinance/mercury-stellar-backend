/**
 * Multi-leg agent runner (mcp-use inspired loop, Vanna-owned).
 *
 * Plan → expand nested multi-leg ops → execute each leg → observe → next.
 * Never invents hashes. Honest partial reports.
 *
 * @see docs/multi-leg-agent-plan.md
 */

import { isUnfundedWalletError, unfundedWalletMessage } from "@/lib/errors/normalize";
import { copilotConfig } from "./config";
import {
  leverageLegs,
  leveragePriceSymbols,
  planLeverage,
  sameAsset,
  type LeverageGap,
} from "./leverage-plan";
import { splitLeverageAmounts } from "./mcp-write";
import { netOfOriginationFee } from "@/lib/borrow-fee";
import { actionFrom, toSlots, type IntentSlots } from "./registry/intent";
import { expandStepViaWorkflow } from "./registry/workflows";
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
  /**
   * A swap leg's destination, carried so a resume can replay it — or, when the leg is
   * paused because that destination is exactly what's wrong ("BLUSDC is Blend USDC,
   * use SOUSDC instead"), so the client knows what to replace when the user answers.
   * Dropped once already: this type never had them, so the wire payload for a stopped
   * swap leg carried no way to tell what its ORIGINAL (blocked) destination even was.
   */
  token_in?: string | null;
  token_out?: string | null;
  /** AMM LP pair — pause UI lets the user size either side. */
  token_a?: string | null;
  token_b?: string | null;
};

/**
 * One on-chain leg, ready to execute.
 *
 * Extends `IntentSlots` rather than re-listing fields: this type was a hand-picked
 * subset (op/asset/amount/leverage/borrow_asset/token_in/token_out), so every other
 * executable slot — `fraction`, `amount_a/b`, `venue`, `min_hf` — was dropped in the
 * expansion regardless of what the plan said. An approved "remove half my liquidity"
 * reached the executor with no fraction to act on. Carrying the slot record means a new
 * slot survives expansion without this file being edited.
 */
export type ExpandedWrite = Omit<
  IntentSlots,
  "asset" | "amount" | "leverage" | "borrow_asset"
> & {
  op: string;
  label: string;
  multi_leg?: boolean;
  /** Swap spelling of token_a / token_b — the same two slots downstream. */
  token_in?: string | null;
  token_out?: string | null;
  /**
   * Narrowed re-declarations of the slots consumers read directly.
   *
   * `IntentSlots` types every slot as `string | number | boolean | null` because it is
   * the generic wire form. These four are read as strings/numbers all over the executor,
   * so they are pinned here — the record still carries every other slot untyped, which
   * is what makes a NEW slot survive without touching this file.
   */
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  borrow_asset?: string | null;
};

/**
 * Every slot EXCEPT the four the leg re-derives, so a spread cannot widen their types.
 *
 * The point is the rest: `fraction`, `amount_a/b`, `venue`, `min_hf`,
 * `prefer_max_yield` and anything added to EXECUTABLE_SLOTS later ride along without
 * this file naming them.
 */
function otherSlots(step: PlanStep): Omit<
  IntentSlots,
  "asset" | "amount" | "leverage" | "borrow_asset"
> {
  const { asset, amount, leverage, borrow_asset, ...rest } = toSlots(step);
  void asset;
  void amount;
  void leverage;
  void borrow_asset;
  return rest;
}

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
    case "swap":
      return qty ? `Swap ${qty}` : "Swap";
    default:
      return `${op.replace(/_/g, " ")}${qty ? ` ${qty}` : ""}${
        leverage != null && leverage > 1 ? ` at ${leverage}×` : ""
      }`.trim();
  }
}

export function humanSwapLabel(
  amount?: number | null,
  tokenIn?: string | null,
  tokenOut?: string | null,
): string {
  const n = amount != null && Number.isFinite(amount) ? String(amount) : "";
  const a = (tokenIn || "XLM").toUpperCase();
  const b = (tokenOut || "USDC").toUpperCase();
  return n ? `Swap ${n} ${a} → ${b}` : `Swap ${a} → ${b}`;
}

/**
 * Expand high-level plan ops into atomic executable legs.
 *
 * Order and split metadata live in {@link ./registry/workflows}. Sizing still
 * uses shared helpers (leverage / origination fee).
 *
 * deploy_to_blend @ L>1 → deposit, borrow, supply_to_blend
 * deposit_and_borrow @ L>1 → deposit, borrow
 */
export function expandPlanWrites(steps: PlanStep[]): ExpandedWrite[] {
  const out: ExpandedWrite[] = [];
  const labels = { write: humanWriteLabel, swap: humanSwapLabel };

  for (const step of steps) {
    if (step.kind !== "write" || !(step.op || step.tool)) continue;
    const legs = expandStepViaWorkflow(step, labels) as ExpandedWrite[];
    out.push(...legs);
  }

  const cap = copilotConfig.multiLegMaxLegs;
  return out.slice(0, Math.min(12, Math.max(1, cap)));
}

/**
 * Pre-Phase-3 expander — kept only so the differential harness can prove the
 * workflow table emits an identical step list. Do not call from production paths.
 *
 * @deprecated Prefer {@link expandPlanWrites}.
 */
export function expandPlanWritesLegacy(steps: PlanStep[]): ExpandedWrite[] {
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
    const borrowAsset =
      (step.args?.borrow_asset as string | undefined) ??
      (step as { borrow_asset?: string | null }).borrow_asset ??
      null;

    if (op === "swap") {
      const slots = toSlots(step);
      const tokenIn = (slots.token_a as string) || asset || "XLM";
      const tokenOut = (slots.token_b as string) || null;
      out.push({
        ...otherSlots(step),
        op: "swap",
        asset: tokenIn,
        amount,
        token_in: tokenIn,
        token_out: tokenOut,
        label: humanSwapLabel(amount, tokenIn, tokenOut),
      });
      continue;
    }

    if ((op === "deploy_to_blend" || op === "supply_to_blend") && leverage != null && leverage > 1) {
      if (amount == null || !(amount > 0)) {
        out.push({
          ...otherSlots(step),
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
      const supplyAmt = borrow > 0 ? netOfOriginationFee(borrow) : deposit;
      out.push({
        ...otherSlots(step),
        op: "deposit_collateral",
        asset,
        amount: deposit,
        label: humanWriteLabel("deposit_collateral", deposit, asset),
      });
      out.push({
        ...otherSlots(step),
        op: "borrow",
        asset,
        amount: borrow,
        label: humanWriteLabel("borrow", borrow, asset),
      });
      out.push({
        ...otherSlots(step),
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
          ...otherSlots(step),
          op: "deposit_and_borrow",
          asset,
          amount: null,
          leverage: leverage ?? 2,
          borrow_asset: borrowAsset,
          label: humanWriteLabel("deposit_and_borrow", null, asset, leverage ?? 2) + " — need amount",
          multi_leg: true,
        });
        continue;
      }
      const L = leverage ?? 2;
      if (borrowAsset && asset && !sameAsset(borrowAsset, asset)) {
        out.push({
          ...otherSlots(step),
          op: "deposit_and_borrow",
          asset,
          amount,
          leverage: L,
          borrow_asset: borrowAsset,
          label: humanWriteLabel("deposit_and_borrow", amount, asset, L),
          multi_leg: true,
        });
        continue;
      }
      const { deposit, borrow } = splitLeverageAmounts(amount, L, null);
      out.push({
        ...otherSlots(step),
        op: "deposit_collateral",
        asset,
        amount: deposit,
        label: humanWriteLabel("deposit_collateral", deposit, asset),
      });
      out.push({
        ...otherSlots(step),
        op: "borrow",
        asset: borrowAsset || asset,
        amount: borrow,
        label: humanWriteLabel("borrow", borrow, borrowAsset || asset),
      });
      continue;
    }

    out.push({
      ...otherSlots(step),
      op,
      asset,
      amount,
      leverage,
      borrow_asset: borrowAsset,
      label: humanWriteLabel(op, amount, asset, leverage),
      multi_leg: false,
    });
  }

  const cap = copilotConfig.multiLegMaxLegs;
  return out.slice(0, Math.min(12, Math.max(1, cap)));
}

/**
 * Turn any remaining `deposit_and_borrow` expanded writes into atomic deposit + borrow.
 *
 * Sync `expandPlanWrites` keeps cross-asset levered positions whole (no oracle there).
 * The multi-leg runner then marked that single write "done" after deposit and **dropped**
 * `runWrite`'s `next_step` borrow — live: AQUSDC@2× "borrow XLM" settled 1 tx, debt $0,
 * UI still claimed XLM was borrowed. Size here with prices, then the one-leg-per-hop
 * loop runs deposit then borrow like same-asset already does.
 */
export function materializeLeverageWrites(
  writes: ExpandedWrite[],
  prices: Record<string, number> = {},
):
  | { ok: true; writes: ExpandedWrite[] }
  | {
      ok: false;
      gap: LeverageGap;
      symbol?: string;
      write: ExpandedWrite;
    } {
  const out: ExpandedWrite[] = [];
  for (let i = 0; i < writes.length; i += 1) {
    const w = writes[i]!;
    if (w.op !== "deposit_and_borrow") {
      out.push(w);
      continue;
    }
    const collateralAsset = w.asset || "XLM";
    const borrowAsset = w.borrow_asset || collateralAsset;

    /**
     * "Deposit X and borrow 3x BLUSDC and AqUSDC" expands into THREE writes: this
     * `deposit_and_borrow` (collateral + first borrow asset) immediately followed by
     * a separate, unsized `borrow` for the second asset. Reported live: the second
     * write was left completely untouched here — no leverage, no amount — so the
     * first write alone consumed the FULL (L−1) leveraged amount and the second asked
     * "how much?" with zero sizing context. A user answering with a similarly-sized
     * number silently doubled the account's real leverage past what was asked for.
     * Confirmed against the real Margin page's own Dual Borrow control: "Nx" is the
     * TOTAL leveraged position, split across every named borrow asset, not applied to
     * each independently.
     *
     * Splitting the SAME (L−1) leveraged amount across N assets means each individual
     * asset sizes as if leverage were only `1 + (L−1)/N` — for N=2 that is exactly
     * half the original (L−1) total, and the formula generalizes past two without a
     * special case for "two".
     */
    const next = writes[i + 1];
    const isDualBorrowSplit =
      next != null &&
      next.op === "borrow" &&
      !!next.asset &&
      !sameAsset(next.asset, borrowAsset) &&
      !sameAsset(next.asset, collateralAsset) &&
      (next.amount == null || !(Number(next.amount) > 0));
    const splitCount = isDualBorrowSplit ? 2 : 1;
    const effectiveLeverage =
      splitCount > 1 && w.leverage != null ? 1 + (w.leverage - 1) / splitCount : w.leverage;

    const sized = planLeverage(
      {
        collateralAsset,
        collateralAmount: w.amount,
        leverage: effectiveLeverage,
        borrowAsset,
        borrowAmount:
          !isDualBorrowSplit && w.borrow_amount != null && Number.isFinite(Number(w.borrow_amount))
            ? Number(w.borrow_amount)
            : null,
      },
      prices,
    );
    if ("gap" in sized) {
      return { ok: false, gap: sized.gap, symbol: sized.symbol, write: w };
    }
    const legs = leverageLegs(sized.plan);
    out.push({
      ...otherSlotsFromExpanded(w),
      op: "deposit_collateral",
      asset: legs.deposit.asset,
      amount: legs.deposit.amount,
      leverage: null,
      borrow_asset: null,
      label: humanWriteLabel("deposit_collateral", legs.deposit.amount, legs.deposit.asset),
      multi_leg: false,
    });
    // Display leverage is the ORIGINAL total the user asked for (e.g. 3×), not the
    // internal `effectiveLeverage` used to size a SPLIT leg (e.g. 2× per asset) — a
    // split's two halves still together make up the one leveraged position the user
    // named, and a label reading "2× leverage" on it would misstate what was approved.
    // Equal to `sized.plan.leverage` in the non-split case, so this is a no-op then.
    out.push({
      ...otherSlotsFromExpanded(w),
      op: "borrow",
      asset: legs.borrow.asset,
      amount: legs.borrow.amount,
      leverage: w.leverage,
      borrow_asset: null,
      label: humanWriteLabel("borrow", legs.borrow.amount, legs.borrow.asset),
      multi_leg: false,
    });

    if (isDualBorrowSplit && next) {
      const sized2 = planLeverage(
        {
          collateralAsset,
          collateralAmount: w.amount,
          leverage: effectiveLeverage,
          borrowAsset: next.asset || collateralAsset,
          borrowAmount: null,
        },
        prices,
      );
      if ("gap" in sized2) {
        return { ok: false, gap: sized2.gap, symbol: sized2.symbol, write: next };
      }
      out.push({
        ...otherSlotsFromExpanded(next),
        op: "borrow",
        asset: sized2.plan.borrowAsset,
        amount: sized2.plan.borrowAmount,
        leverage: w.leverage,
        borrow_asset: null,
        label: humanWriteLabel("borrow", sized2.plan.borrowAmount, sized2.plan.borrowAsset),
        multi_leg: false,
      });
      i += 1; // the second borrow write is fully consumed above — do not re-push it plain
    }
  }
  const cap = copilotConfig.multiLegMaxLegs;
  return { ok: true, writes: out.slice(0, Math.min(12, Math.max(1, cap))) };
}

/** Symbols the oracle must supply before {@link materializeLeverageWrites} can finish. */
export function materializeLeveragePriceSymbols(writes: ExpandedWrite[]): string[] {
  const needed = new Set<string>();
  for (const w of writes) {
    if (w.op !== "deposit_and_borrow") continue;
    for (const s of leveragePriceSymbols({
      collateralAsset: w.asset || "XLM",
      collateralAmount: w.amount,
      leverage: w.leverage,
      borrowAsset: w.borrow_asset || w.asset || "XLM",
    })) {
      needed.add(s);
    }
  }
  return [...needed];
}

function otherSlotsFromExpanded(
  w: ExpandedWrite,
): Omit<IntentSlots, "asset" | "amount" | "leverage" | "borrow_asset"> {
  const {
    op: _op,
    label: _label,
    multi_leg: _ml,
    token_in: _ti,
    token_out: _to,
    asset: _a,
    amount: _am,
    leverage: _l,
    borrow_asset: _b,
    ...rest
  } = w;
  return rest as Omit<IntentSlots, "asset" | "amount" | "leverage" | "borrow_asset">;
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

/**
 * One leg of an expanded plan → the action that executes it.
 *
 * Was one of five hand-written conversions, each with its own subset of the slots —
 * this one silently dropped `fraction`, `amount_a/b` and `venue`, so an approved
 * "remove half my liquidity" arrived with nothing to act on. Now it reads every slot in
 * EXECUTABLE_SLOTS by iteration (see registry/intent.ts), so a new slot cannot be
 * missing from this site while present in another.
 *
 * `token_in`/`token_out` are the swap spelling of `token_a`/`token_b` — the same two
 * slots `mapOpToMcpStep` reads — so they are mapped in before the read.
 */
export function actionFromExpanded(
  w: ExpandedWrite,
  ctx: { smartAccount: string | null; trader: string | null; minHf: number | null },
): CopilotAction {
  return actionFrom(
    {
      ...w,
      token_a: w.token_a ?? w.token_in ?? null,
      token_b: w.token_b ?? w.token_out ?? null,
    },
    { smartAccount: ctx.smartAccount, trader: ctx.trader, minHf: ctx.minHf, multiLeg: !!w.multi_leg },
  );
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
 * Build client next_step chain for remaining expanded legs.
 * Nests follow_up recursively so deposit→borrow→supply is not truncated.
 */
export function remainingNextStep(
  remaining: ExpandedWrite[],
  stepIndex1Based: number,
  totalSteps: number,
): NonNullable<ChatResponse["next_step"]> | null {
  if (!remaining.length) return null;
  const [first, ...rest] = remaining;
  return {
    op: first.op,
    asset: first.asset ?? null,
    amount: first.amount ?? null,
    leverage: first.leverage ?? null,
    label: first.label,
    step: stepIndex1Based,
    total_steps: totalSteps,
    follow_up: remainingNextStep(rest, stepIndex1Based + 1, totalSteps),
  };
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
  // Same wallet-has-no-XLM case as the single-write path — a strategy leg must not
  // report it as a bare RPC dump when the single-write path explains it.
  if (isUnfundedWalletError(m)) return unfundedWalletMessage();
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

/**
 * Legs that can still be (re)run: failed, skipped, pending, needs_sign, clarification.
 *
 * A leg with NO amount is included, and that is the whole point.
 *
 * This used to require `amount != null && amount > 0`, which made an amount-less leg
 * invisible to the entire resume machinery: `resume_legs` came back empty, `can_resume`
 * came back false, so the auto-approve chain had nothing to continue and the client's
 * post-signature path fell through to "final leg" and declared the strategy live. A
 * delta-neutral carry therefore deposited its collateral and stopped dead — the borrow
 * and lend legs sat on "pending" forever, nothing ever asked for their size, and the
 * user's only way forward was to re-send the prompt, which re-planned from scratch and
 * deposited the collateral A SECOND TIME.
 *
 * Passing the amount-less leg through instead lets `runPlan` reach it and return its
 * `clarification` status, which the run card renders as a "needs input" leg with a
 * number field. Only a non-positive amount is dropped now, since that is malformed
 * rather than merely unknown.
 */
export function resumableLegsFromSteps(steps: MultiLegStep[]): Array<{
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label?: string;
  token_in?: string | null;
  token_out?: string | null;
}> {
  return steps
    .filter((s) =>
      ["error", "skipped", "pending", "needs_sign", "blocked", "clarification"].includes(s.status),
    )
    .filter((s) => s.amount == null || s.amount > 0)
    .map((s) => ({
      op: s.op,
      asset: s.asset ?? null,
      amount: s.amount ?? null,
      leverage: s.leverage ?? null,
      label: s.label,
      // A swap's destination, so a later resume can carry a CORRECTED token_out instead
      // of silently replaying the original (possibly just-refused) one.
      token_in: s.token_in ?? null,
      token_out: s.token_out ?? null,
    }));
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
  const resume_legs = resumableLegsFromSteps(opts.steps);
  const done = opts.steps.filter((s) => s.status === "ok").length;
  const total = opts.steps.length;
  // Plan-and-execute pattern (LangChain / Anthropic): always surface progress + observe.
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
    /** Client “Continue remaining” / “Retry failed” uses this payload. */
    resume_legs: resume_legs.length ? resume_legs : null,
    can_resume: resume_legs.length > 0,
    /** Observe: how far through the fixed plan we got */
    progress: { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 },
    pattern: "plan_then_execute",
    ...(opts.extra || {}),
  };
}
