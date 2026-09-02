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
import {
  compactSlots,
  slotsFingerprint,
  toSlots,
  type IntentSlots,
} from "./registry/intent";
import { workflowLegCount } from "./registry/workflows";
import type { PlanConstraints } from "./plan-ir";
import type { RoutedIntent } from "./types";

/** A plan is built on live prices and account health; both move. */
export const PLAN_TTL_MS = 5 * 60_000;

export interface PlanStepView {
  n: number;
  /**
   * Writes move funds and need a signature; reads report a number and do not.
   *
   * Read legs exist because a strategy sentence often ends in a question — "…then tell me
   * my health factor". `freezePlan` used to filter them out, so the card showed one step
   * for a two-part instruction, the leg was excluded from the fingerprint, and the client
   * replayed a plan the question had been silently removed from. The user approved
   * something narrower than what they asked for and was never told.
   */
  kind: "write" | "read";
  /** Read legs only — the MCP tool that answers the question. */
  tool?: string | null;
  op: string;
  asset: string | null;
  amount: number | null;
  /**
   * A share of a live balance, when the size was given as one. Rendered as "50% of your
   * XLM" instead of "amount to be confirmed" — the user stated a size, and a card that
   * says the amount is missing is telling them they did not.
   */
  fraction: number | null;
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
  /** Stated health-factor floor (e.g. min_hf: 2.0). */
  min_hf?: number | null;
  /**
   * EVERY executable slot for this step, as one record.
   *
   * This is the field that closes the bug class rather than patching one instance of it.
   * The named fields above are a display view derived from it; this is what is hashed
   * and what is replayed, so a slot added to EXECUTABLE_SLOTS survives approval without
   * this file being touched. `leverage` needed a manual fix here once, `borrow_asset` a
   * second time, and `token_out` was still broken — all three were the same omission in
   * three different fields.
   */
  slots: IntentSlots;
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
  /**
   * A stated HF floor etc., read once from the message that built this plan.
   *
   * Absent for plans from the LLM planner. Carried so approval — which sends back
   * `message: "approve plan"`, not the original text — can still see it; `runPlan`'s
   * fallback of re-parsing `ctx.message` finds nothing in that generic string.
   */
  constraints?: PlanConstraints | null;
  /**
   * AMM LP sizer for an unsized add_liquidity leg. Shown on the plan card so the
   * user picks XLM or the venue stable BEFORE anything signs.
   */
  lp_input?: {
    sides: [string, string];
    other_per_xlm: number | null;
  } | null;
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
  withdraw_from_blend: "farm",
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
  withdraw_from_blend: "Withdraw",
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

/**
 * Aquarius and Soroswap LP legs share the "farm" venue bucket with Blend (both are farm
 * actions, same as the app's own Farm tab covers all three) — but that bucket's suffix is
 * a flat "into Blend", so every add/remove-liquidity step read "... into Blend" even
 * though Blend has no AMM/liquidity concept at all. Live result: a real Soroswap LP leg
 * (added after swapping into SOUSDC, which only trades on Soroswap) rendered as "Add
 * liquidity with 5 SOUSDC into Blend" — badged FARM like a Blend supply, reading as one.
 * Which venue actually applies is determined by the USDC variant the step names — SOUSDC
 * only trades on Soroswap, AQUSDC only on Aquarius.
 */
function lpVenueSuffix(asset: string | null): string {
  const a = (asset ?? "").toUpperCase();
  if (a === "SOUSDC" || a === "SOROSWAP_USDC") return "on Soroswap";
  if (a === "AQUSDC" || a === "AQUARIUS_USDC") return "on Aquarius";
  return "on the LP pool";
}

function labelFor(
  op: string,
  asset: string | null,
  amount: number | null,
  venue: PlanStepView["venue"],
  leverage: number | null,
  borrowAsset: string | null = null,
  minHf: number | null = null,
): string {
  const verb = OP_VERB[op] ?? op.replace(/_/g, " ");
  if (op === "create_account") return "Open your margin account";
  const qty = amount != null ? `${amount} ` : "";
  const sym = asset ?? "";
  const tail =
    op === "add_liquidity" || op === "remove_liquidity"
      ? lpVenueSuffix(asset)
      // VENUE_SUFFIX.farm is "into Blend" — the right direction for a supply, backwards
      // for a withdrawal ("Withdraw 50 BLUSDC into Blend" reads as moving money the wrong
      // way). Same fix shape as the LP venue suffix above: the op's own direction wins.
      : op === "withdraw_from_blend"
        ? "from Blend"
        : VENUE_SUFFIX[venue];
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
  const hfFloor = minHf != null && minHf > 0 ? `(Max keeping HF ≥ ${minHf.toFixed(1)})` : "";
  return [verb, `${qty}${sym}`.trim(), tail, loan, lev, hfFloor].filter(Boolean).join(" ");
}

/**
 * On-chain legs this step becomes, and therefore signatures.
 *
 * Sourced from {@link workflowLegCount} so the plan card cannot disagree with
 * expandPlanWrites about how many hops a levered farm / deposit+borrow needs.
 */
function legCount(op: string, leverage: number | null): number {
  return workflowLegCount(op, leverage);
}

/**
 * Fingerprint the executable content of a plan.
 *
 * Only the fields that change what happens on-chain are hashed — labels and summaries
 * are presentation, and including them would break approval on a harmless copy edit.
 */
export function planFingerprint(
  steps: Array<{
    op: string;
    kind?: "write" | "read";
    tool?: string | null;
    slots?: IntentSlots;
    // Legacy top-level spellings, still accepted: `toSlots` reads either, so a caller
    // that predates `slots` hashes to the same value as one that does not.
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    borrow_asset?: string | null;
  }>,
): string {
  const canonical = steps
    .map((s) => {
      // A read leg has no slots that move funds, but it must still be hashed: otherwise a
      // client could add or drop the reporting step after approval and the fingerprint
      // would still match. The tool name is the whole executable content.
      if (s.kind === "read") return `read:${s.tool ?? ""}`;
      // Derived from EXECUTABLE_SLOTS by iteration, so every slot that changes what
      // happens on-chain is hashed automatically. Hand-listing the fields here is what
      // left `leverage`, then `borrow_asset`, then `token_out` outside the hash — and an
      // unhashed executable slot is one a client can alter after approval, which is the
      // exact hole this fingerprint exists to close.
      const slots = s.slots ? compactSlots(s.slots) : toSlots(s);
      return `${s.op}|${slotsFingerprint(slots)}`;
    })
    .join(";");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Turn a routed plan into something a user can read and approve. */
export function freezePlan(plan: PlanIntent, nowMs: number): FrozenPlan {
  const steps: PlanStepView[] = plan.steps
    // Read legs are kept. Only a step that is neither runnable shape is dropped.
    .filter((s) => (s.kind === "write" && s.op) || (s.kind === "read" && s.tool))
    .map((s, i) => {
      if (s.kind === "read") {
        const tool = String(s.tool);
        return {
          n: i + 1,
          kind: "read" as const,
          tool,
          op: tool,
          asset: null,
          amount: null,
          fraction: null,
          leverage: null,
          borrow_asset: null,
          slots: {} as IntentSlots,
          label: `Report ${tool.replace(/^vanna_(get_)?/, "").replace(/_/g, " ")}`,
          venue: "other" as const,
        };
      }
      const op = String(s.op);
      const venue = VENUE_BY_OP[op] ?? "other";
      const asset = s.asset ?? null;
      const amount = typeof s.amount === "number" && Number.isFinite(s.amount) ? s.amount : null;
      // One read of every slot, handling both spellings (args.x and x) for all of them —
      // rather than a per-field rescue for whichever slot was noticed to be missing.
      const slots = toSlots(s);
      const leverage = typeof slots.leverage === "number" ? slots.leverage : null;
      const borrow_asset =
        typeof slots.borrow_asset === "string" && slots.borrow_asset ? slots.borrow_asset : null;
      const min_hf =
        typeof slots.min_hf === "number"
          ? slots.min_hf
          : typeof (plan as any).min_hf === "number"
            ? (plan as any).min_hf
            : typeof plan.constraints?.minHf === "number"
              ? plan.constraints.minHf
              : null;
      const stepSlots = {
        ...slots,
        ...(min_hf != null ? { min_hf } : {}),
      };
      return {
        n: i + 1,
        kind: "write" as const,
        op,
        // Display fields are DERIVED from slots, so the card and the hash can never
        // describe two different trades.
        asset: (slots.asset as string) ?? asset,
        amount: typeof slots.amount === "number" ? slots.amount : amount,
        fraction: typeof slots.fraction === "number" ? slots.fraction : null,
        leverage,
        borrow_asset,
        min_hf,
        slots: stepSlots,
        label: labelFor(op, (slots.asset as string) ?? asset, amount, venue, leverage, borrow_asset, min_hf),
        venue,
      };
    });

  /**
   * Cap the number of top-level steps a single plan can carry.
   *
   * Nothing upstream limits how many clauses a sentence can chain — "do 15 things" builds
   * 15 real steps, each a signature, with no ceiling. Dropped rather than shown-then-refused,
   * because every one of them would otherwise reach `Approve & run` looking identical to an
   * intended plan.
   */
  const MAX_PLAN_STEPS = 8;
  const overflow = steps.length > MAX_PLAN_STEPS ? steps.length - MAX_PLAN_STEPS : 0;
  const cappedSteps = overflow ? steps.slice(0, MAX_PLAN_STEPS) : steps;
  const renumberedSteps = cappedSteps.map((s, i) => ({ ...s, n: i + 1 }));

  /**
   * Only writes are signed. A read leg reports a number and asks nothing of the wallet, so
   * counting it here would tell the user to expect one more signature than they will see —
   * and "how many times will I be asked to sign" is the number this card exists to get
   * right.
   */
  const writeSteps = renumberedSteps.filter((s) => s.kind === "write");
  const signatureCount = writeSteps.reduce((n, s) => n + legCount(s.op, s.leverage), 0);
  const warnings: string[] = [];
  if (overflow) {
    warnings.push(
      `This plan is capped at ${MAX_PLAN_STEPS} steps — ${overflow} more you asked for were dropped. ` +
        `Ask again for the rest once these run.`,
    );
  }

  // A missing amount becomes a prompt mid-execution, after earlier legs have already
  // settled on-chain. Better to say so while the whole thing can still be cancelled.
  // Reads are exempt: a report has no size to be missing.
  // A step sized as a share of a balance is NOT missing its amount — it has one, stated
  // as "50%" and resolved against the live balance when the leg runs. Warning about it
  // told the user their own instruction had not been understood.
  const noAmount = writeSteps.filter(
    (s) => s.amount == null && s.fraction == null && s.op !== "create_account",
  );
  if (noAmount.length) {
    warnings.push(
      `Step ${noAmount.map((s) => s.n).join(" and ")} has no amount yet — I'll have to ask once it gets there.`,
    );
  }

  // "USDC" is three different tokens here, and picking the wrong one is unrecoverable.
  // Checked on BOTH slots: a bare-USDC loan against a specific collateral is just as
  // ambiguous, and only the collateral was being looked at.
  if (renumberedSteps.some((s) => s.asset === "USDC" || s.borrow_asset === "USDC")) {
    warnings.push(
      "USDC is ambiguous on this network (BLUSDC, AQUSDC, SOUSDC) — I'll ask which one before that leg runs.",
    );
  }

  if (renumberedSteps.some((s) => s.venue === "farm") && renumberedSteps.some((s) => s.venue === "earn")) {
    warnings.push("This plan touches both Earn and Farm — check each step is against the product you meant.");
  }

  // A levered step is several transactions, so say what it expands into rather than
  // letting "2 steps" imply two signatures.
  const levered = writeSteps.filter((s) => legCount(s.op, s.leverage) > 1);
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
    plan_id: planFingerprint(renumberedSteps),
    summary: plan.summary?.trim() || "Multi-step strategy",
    steps: renumberedSteps,
    created_at: nowMs,
    signature_count: signatureCount,
    warnings,
    constraints: plan.constraints ?? null,
  };
}

/** What the client sends back when the user presses Approve. */
export interface ApprovedPlan {
  plan_id: string;
  created_at: number;
  steps: Array<{
    op: string;
    /**
     * The whole executable record, echoed back verbatim. This is the field approval
     * actually runs from; the named ones below are accepted so an older client (or a
     * hand-written payload) still validates, and are merged in when `slots` is absent.
     */
    slots?: IntentSlots;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    borrow_asset?: string | null;
  }>;
  /** Echoed back from the plan_preview's own `constraints` — e.g. a stated HF floor. */
  constraints?: PlanConstraints | null;
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

  // One canonical read per step, whichever shape the client sent. A read leg carries only
  // its tool, and is passed through so the fingerprint covers it and runPlan can run it.
  const replay = approved.steps.map((s) => {
    const isRead =
      (s as { kind?: string }).kind === "read" || (!s.op && !!(s as { tool?: string }).tool);
    if (isRead) {
      const tool = String((s as { tool?: string }).tool ?? s.op ?? "");
      return { kind: "read" as const, op: tool, tool, slots: {} as IntentSlots };
    }
    return {
      kind: "write" as const,
      op: s.op,
      slots: s.slots ? compactSlots({ ...toSlots(s), ...compactSlots(s.slots) }) : toSlots(s),
    };
  });

  const recomputed = planFingerprint(replay);
  if (recomputed !== approved.plan_id) {
    /**
     * A slot present at freeze and absent at approval now lands HERE, which is the whole
     * gain: it used to be outside the hash, so the fingerprint matched and a different
     * trade executed silently.
     *
     * The message stays generic on purpose. Only the hash of the original plan is held,
     * not the plan, so this cannot know WHICH slot went missing — and an earlier draft
     * that claimed to name it was reading the already-stripped payload against itself,
     * which would have reported "nothing missing" on every real drop. A log line carries
     * the two hashes for whoever debugs it; the user gets the one fact that matters.
     */
    console.warn(
      `[copilot] ${JSON.stringify({
        event: "approved_plan_fingerprint_mismatch",
        presented: approved.plan_id,
        recomputed,
        steps: replay.map((s) => ({ op: s.op, slots: slotsFingerprint(s.slots) })),
      })}`,
    );
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
      constraints: approved.constraints ?? undefined,
      /**
       * Replayed from the slot record, in both spellings.
       *
       * `args` carries the whole record because `expandPlanWrites` reads slots from
       * either place, and the top-level fields are set for the consumers that read them
       * directly. Neither is a hand-picked subset any more, which is what let an
       * approved trade differ from the executed one — twice, in two different fields.
       */
      steps: replay.map((s) =>
        s.kind === "read"
          ? { kind: "read" as const, tool: s.tool, args: {} }
          : {
              kind: "write" as const,
              op: s.op,
              args: s.slots,
              leverage: typeof s.slots.leverage === "number" ? s.slots.leverage : null,
              asset: (s.slots.asset as string) ?? null,
              amount: typeof s.slots.amount === "number" ? s.slots.amount : null,
              borrow_asset: (s.slots.borrow_asset as string) ?? null,
              fraction: typeof s.slots.fraction === "number" ? s.slots.fraction : null,
              token_a: (s.slots.token_a as string) ?? null,
              token_b: (s.slots.token_b as string) ?? null,
              amount_a: typeof s.slots.amount_a === "number" ? s.slots.amount_a : null,
              amount_b: typeof s.slots.amount_b === "number" ? s.slots.amount_b : null,
              venue: (s.slots.venue as string) ?? null,
              min_hf: typeof s.slots.min_hf === "number" ? s.slots.min_hf : null,
              prefer_max_yield:
                typeof s.slots.prefer_max_yield === "boolean" ? s.slots.prefer_max_yield : null,
            },
      ),
    },
  };
}
