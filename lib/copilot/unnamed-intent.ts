/**
 * Unnamed-surface intent selection: keyword vs Vertex, venue corrections, and
 * LLM plan promotion. Copilot never reaches this (`investigation_owns_planning`).
 * Extracted from handle.ts so that file can shrink toward execution-only.
 */
import { looksLikeMultiGoal, preferMultiGoalPlan } from "./plan-sanitize";
import { isKeywordConfident } from "./intent-confidence";
import { extractPlanIR, preferExtractedPlan } from "./step-extractor";
import { classifyCoverage, residueIsMaterial } from "./residue";
import { logCopilotEvent } from "./log";
import { llmPlanStrategy, shouldLlmPlan } from "./llm-planner";
import { findUnsupportedAsset, routeMessage } from "./router";
import { vertexSelectTool } from "./vertex";
import type { PageDescriptorCtx, RoutedIntent } from "./types";

export type UnnamedIntentOk = {
  kind: "ok";
  routed: RoutedIntent;
  modelUnreachable: boolean;
};

export type UnnamedIntentBlocked = {
  kind: "blocked";
  template_id: string;
  message: string;
  slots?: Record<string, string>;
};

export type UnnamedIntentResult = UnnamedIntentOk | UnnamedIntentBlocked;

export async function resolveUnnamedIntent(input: {
  message: string;
  smartAccount: string | null;
  trader: string | null;
  pageContext: PageDescriptorCtx | null;
  request_id: string;
}): Promise<UnnamedIntentResult> {
  const { message, smartAccount, trader, pageContext, request_id } = input;

function isBlendRead(routed: RoutedIntent): boolean {
  return (
    routed.kind === "read" &&
    (routed.tool === "vanna_list_blend_reserves" ||
      routed.tool === "vanna_get_blend_reserve_stats" ||
      routed.tool === "vanna_get_blend_position")
  );
}

/**
 * Measure how much of the message the deterministic extractor accounted for, and log it.
 *
 * Shadow only: nothing here changes the response. The point is to collect a real over-ask
 * rate before the coverage check is allowed to interrupt anyone — turning it loud on an
 * assumed rate is how a safety check becomes a nuisance the user learns to click past.
 * Scoped to plan-shaped messages, since residue on "what is XLM worth" is not the signal.
 */
function logPlanCoverageShadow(
  message: string,
  routed: RoutedIntent,
  request_id: string,
): void {
  if (!looksLikeMultiGoal(message) && routed.kind !== "plan") return;
  try {
    const ir = extractPlanIR(message);
    const verdicts = classifyCoverage(ir.coverage);
    logCopilotEvent("plan_coverage_shadow", {
      request_id,
      routed: routed.kind,
      template_id: routed.kind === "plan" ? routed.template_id : null,
      steps: ir.steps.length,
      source: ir.source,
      verdict: ir.coverage.verdict,
      residue: verdicts.map((v) => `${v.class}:${v.decision}:${v.reason}`),
      residue_text: ir.coverage.residue.map((r) => r.text),
      material: residueIsMaterial(verdicts),
      intra_clause: ir.coverage.intraClause.map((r) => r.text),
      min_hf: ir.constraints.minHf,
      leverage: ir.constraints.leverage,
    });
  } catch (e) {
    // A measurement must never break a turn it is only observing.
    console.warn(`[copilot] coverage shadow failed: ${String(e)}`);
  }
}

  // ── Route intent (hybrid: fast keywords + smart Vertex for complex goals) ─
  // Simple single-action prompts (swap/lend/deposit…) skip Vertex for speed.
  // Multi-goal / long / strategy language always uses Gemini so understanding is
  // free-form — not a fixed prompt list. Keyword router still corrects venue
  // mistakes after Vertex (Blend vs Earn, USDC variants, etc.).
  // Copilot and assistant-write never reach here.
  const kwFast = routeMessage(message);
  const keywordConfident = isKeywordConfident(message, kwFast);

  let routed: RoutedIntent;
  /**
   * Whether the model was asked and could not answer.
   *
   * The keyword fallback is a good safety net for phrasings it knows, but when it lands on
   * the generic capability list the two failures are indistinguishable to the user: "I did
   * not understand you" and "the component that understands never ran" print the same
   * paragraph. On a machine whose `gcloud auth login` had expired, every unrecognised
   * phrasing came back as that blurb, which is what got reported as a hardcoded response.
   */
  let modelUnreachable = false;
  if (keywordConfident) {
    routed = kwFast;
  } else {
    try {
      routed = await vertexSelectTool(message, {
        smartAccount,
        trader,
        pageContext,
      });
    } catch (e) {
      console.warn("[copilot] vertex route failed, keyword fallback:", e instanceof Error ? e.message : e);
      modelUnreachable = true;
      routed = kwFast;
    }
  }

  // Prefer deterministic keyword routes for Sanujit earn multi-pool / farm / lend
  // phrases — Vertex often collapses "list all earn pools", mis-routes highest-APY,
  // or maps "supply to Blend" onto deposit_collateral.
  {
    const unsupported = findUnsupportedAsset(message);
    if (
      unsupported &&
      // LP and swap verbs belong here too. Without them "add liquidity to the XLM/BTC
      // pool" skipped this gate entirely and was answered with "how much of each token?"
      // — asking a user to size a position in a token that does not exist on this
      // network, and only failing once the amounts came back.
      /\b(lend|supply|earn|deposit|borrow|repay|farm|swap|provide|add|remove|park|invest|deploy|redeem|withdraw)\b/i.test(
        message,
      )
    ) {
      return {
        kind: "blocked",
        template_id: "unsupported_asset",
        message:
          `“${unsupported}” is not supported on Vanna testnet. Use XLM, BLUSDC, AQUSDC, or SOUSDC ` +
          `(not bare USDC without a variant — pick BLUSDC / AQUSDC / SOUSDC when you mean a dollar token).`,
        slots: { asset: unsupported },
      };
    }
    const kw = keywordConfident ? kwFast : routeMessage(message);
    const lowerMsg = message.toLowerCase();
    /**
     * "Can You Remove 50 BLUSDC fom Farm's Blend Pool" executed a real SUPPLY instead of
     * a withdrawal — router.ts's own `withdraw_from_blend` route (added for exactly this
     * report) correctly classified it, but this SEPARATE, independent regex re-derives
     * "is this a Blend write" from the raw message and force-overrides `routed` to
     * `deploy_to_blend` a few lines down whenever it fires, clobbering whatever `kw` said.
     * "farm's" satisfied `\bfarm\b` (the apostrophe is a `\b` word boundary) with no check
     * for which direction the money should move. Same removal-verb carve-out as router.ts.
     */
    const blendRemoveVerb = /\b(remove|withdraw|take out|takeout|pull out|unwind|redeem)\b/.test(lowerMsg);
    const blendWrite =
      /\bblend\b/.test(lowerMsg) &&
      /\b(supply|deposit|deploy|farm|add|liquidity)\b/.test(lowerMsg) &&
      !blendRemoveVerb &&
      !/\b(stats|apy|position|btoken|how much)\b/.test(lowerMsg);
    /**
     * "What is my Holdings in Blend Pool" said "Holdings", not any of the words this
     * list already knew — `blendRead` was FALSE for it, so this whole override never
     * ran and the message fell through to router.ts's/Vertex's original pool-wide
     * `query_blend`/`vanna_list_blend_reserves` pick, answering with the pool's total
     * supply instead of the user's own position (reported live, reproduced exactly).
     * "holdings"/"holding" added here and to the personal-position check below.
     */
    const blendRead =
      /\bblend\b/.test(lowerMsg) &&
      !blendWrite &&
      /\b(stats|apy|reserve|pays|yield|supplied|position|btoken|holdings?|how much)\b/.test(lowerMsg);

    /** Prefer explicit tickers in the message over nested "USDC" inside BLUSDC. */
    const assetFromMessage = (): string | null => {
      if (/\bblusdc\b|\bblend[_\s-]?usdc\b/i.test(message)) return "BLUSDC";
      if (/\baqusdc\b|\baquarius[_\s-]?usdc\b/i.test(message)) return "AQUSDC";
      if (/\bsousdc\b|\bsoroswap[_\s-]?usdc\b/i.test(message)) return "SOUSDC";
      if (/\bxlm\b/i.test(message)) return "XLM";
      return null;
    };

    if (kw.kind === "read" && kw.template_id === "query_all_earn_pools") {
      routed = kw;
    } else if (
      kw.kind === "write" &&
      (kw.op === "add_liquidity" || kw.op === "remove_liquidity" || kw.op === "swap") &&
      routed.kind !== "plan"
    ) {
      /**
       * "Swap 10 XLM to AQUSDC and add liquidity in Aquarius" executed ONLY the swap —
       * the add_liquidity clause never even reached a "how much?" follow-up, it was
       * silently discarded at intent-parsing time. Root cause: this override exists so
       * Vertex misclassifying a single LP/swap write as `deposit_collateral` gets
       * corrected back — but `routeMessage` (the deterministic router `kw` comes from)
       * can only ever see ONE clause of a multi-clause sentence, since it returns at
       * the FIRST matching `if` block; for this message it returns just the swap half.
       * Without this guard, that partial single-op guess unconditionally overwrote
       * `routed` even when `routed` was ALREADY a correct, complete multi-step PLAN
       * from Vertex that covered both clauses — throwing away the second leg. A plan
       * was never the failure mode this override was written for (Vertex recognising
       * 2 steps is not "misclassified as deposit_collateral"), so it no longer fires
       * once `routed` is already one.
       */
      // LP / swap must never become deposit_collateral.
      routed = kw;
    } else if (kw.kind === "write" && kw.template_id === "invest_max_yield") {
      routed = kw;
    } else if (kw.kind === "write" && (kw.op === "deploy_to_blend" || kw.op === "supply_to_blend")) {
      // Always honor keyword farm write; fix bare USDC when BLUSDC was named.
      const named = assetFromMessage();
      routed = {
        ...kw,
        asset:
          (named && named !== "USDC" ? named : null) ||
          (kw.asset && kw.asset !== "USDC" ? kw.asset : null) ||
          named ||
          kw.asset ||
          "XLM",
      };
    } else if (kw.kind === "write" && kw.op === "withdraw_from_blend") {
      // Same "always honor the keyword router's own classification" rule as the supply
      // case above — explicit, not left to fall through the blendWrite/blendRead chain
      // below, precisely because that chain is what clobbered this router decision before.
      const named = assetFromMessage();
      routed = {
        ...kw,
        asset:
          (named && named !== "USDC" ? named : null) ||
          (kw.asset && kw.asset !== "USDC" ? kw.asset : null) ||
          named ||
          kw.asset ||
          "XLM",
      };
    } else if (blendWrite) {
      // Force deploy_to_blend even if Vertex picked deposit_and_borrow / deposit_collateral.
      const fromKw = kw.kind === "write" ? kw : null;
      const assetFix =
        assetFromMessage() ||
        (fromKw?.asset && fromKw.asset !== "USDC" ? fromKw.asset : null) ||
        fromKw?.asset ||
        "XLM";
      routed = {
        kind: "write",
        op: "deploy_to_blend",
        template_id: "deploy_to_blend",
        asset: assetFix,
        amount: fromKw?.amount ?? null,
        multi_leg: true,
        requires_account: true,
        requires_amount: true,
        leverage: fromKw?.leverage ?? null,
      };
    } else if (
      // Vertex sometimes plans LP as deposit_collateral — override when Aquarius/LP named.
      // Never fire on a swap+LP sentence: this rewrite is a SINGLE add_liquidity write,
      // which is exactly how "Swap 10 XLM to AQUSDC and add liquidity in Aquarius"
      // lost the swap (or, after the plan-builder landed, clobbered a 2-step plan).
      !/\bswap\b/i.test(message) &&
      kw.kind !== "plan" &&
      routed.kind !== "plan" &&
      /\b(aquarius|add liquidity|provide liquidity)\b/i.test(message) &&
      /\b(add|provide)\b/i.test(message) &&
      (routed.kind !== "write" || routed.op !== "add_liquidity")
    ) {
      if (kw.kind === "write" && kw.op === "add_liquidity") {
        routed = kw;
      } else {
        const dualMatch = message.match(
          /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b(?:\s+and\s+|\s*\+\s*)(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b/i,
        );
        routed = {
          kind: "write",
          op: "add_liquidity",
          template_id: "add_liquidity",
          asset: dualMatch?.[4]?.toUpperCase() ?? "BLUSDC",
          amount: dualMatch ? Number(dualMatch[1]) : null,
          token_a: dualMatch?.[2]?.toUpperCase() ?? "XLM",
          token_b: dualMatch?.[4]?.toUpperCase() ?? "BLUSDC",
          amount_a: dualMatch ? Number(dualMatch[1]) : null,
          amount_b: dualMatch ? Number(dualMatch[3]) : null,
          multi_leg: true,
          requires_account: true,
          requires_amount: true,
        };
      }
    } else if (blendRead) {
      // Naming two reserves is a comparison — always list both (never single-symbol).
      const named = [
        /\bxlm\b/i.test(message) ? "XLM" : null,
        /\busdc\b/i.test(message) ? "USDC" : null,
      ].filter(Boolean) as string[];
      const compare =
        named.length > 1 ||
        /\b(vs|versus| or |compare|pays more|better than)\b/i.test(message);
      const sym = !compare && named.length === 1 ? named[0]! : null;
      const wantsPosition = /\b(supplied|positions?|btoken|holdings?|how much)\b/i.test(message);
      /**
       * "What is my Holdings in Blend Pool" — Vertex/router had already picked
       * `vanna_list_blend_reserves` (the pool-wide stats tool), and `isBlendRead`
       * only checks "is this SOME blend-read tool", so it counted that as "Vertex got
       * it right" and skipped this override entirely, even though the message clearly
       * asked for the user's OWN position, not the pool's totals (reported live,
       * reproduced exactly — same root cause the `blendRead` gate above had to fix,
       * one layer deeper). `vertexOk` must check Vertex picked the SAME category
       * (personal position vs pool stats) the message actually asks for, not merely
       * that it picked *a* Blend tool.
       */
      const vertexOk =
        !compare &&
        (wantsPosition
          ? routed.kind === "read" && routed.tool === "vanna_get_blend_position"
          : isBlendRead(routed));
      if (!vertexOk) {
        if (wantsPosition) {
          routed = {
            kind: "read",
            tool: "vanna_get_farm_overview",
            args: {
              venue: "blend",
              ...(sym ? { asset: sym === "USDC" ? "BLUSDC" : sym } : {}),
            },
            requires_account: true,
            template_id: "query_farm_position",
          };
        } else {
          routed = {
            kind: "read",
            tool: sym ? "vanna_get_blend_reserve_stats" : "vanna_list_blend_reserves",
            args: sym ? { symbol: sym } : {},
            template_id: "query_blend",
          };
        }
      }
    } else if (
      kw.kind === "write" &&
      kw.op === "lend" &&
      (routed.kind !== "write" ||
        routed.op !== "lend" ||
        kw.template_id === "lend_highest" ||
        (kw.amount != null && (routed.amount == null || kw.amount < 0)))
    ) {
      routed = kw;
    }

    // Multi-goal: keyword plan + clause-order extraction (plan-then-execute).
    // Never let Vertex collapse park+farm / swap+farm into one write.
    if (looksLikeMultiGoal(message) || kw.kind === "plan") {
      const before = routed.kind;
      routed = preferMultiGoalPlan(routed, kw, message);
      // LangChain-style: deterministic ordered decomposition of long prompts
      const extracted = preferExtractedPlan(routed, message);
      routed = extracted;
      if (extracted.kind === "plan" && before !== "plan") {
        console.warn(
          `[copilot] multi-goal: plan with ${extracted.steps.length} steps (was ${before})`,
        );
      }
    }
  }

  // Prefer a richer deterministic keyword plan over a shorter intermediate route.
  // This prevents the planner from being called just to rediscover a dropped LP leg.
  if (
    kwFast.kind === "plan" &&
    (routed.kind !== "plan" || kwFast.steps.length > routed.steps.length)
  ) {
    routed = kwFast;
  }

  // Late catch: long multi-verb messages that still arrived as a single write
  if (routed.kind === "write" && looksLikeMultiGoal(message)) {
    const upgraded = preferExtractedPlan(routed, message);
    if (upgraded.kind === "plan") {
      console.warn(
        `[copilot] multi-goal: upgraded single write to extracted plan (${upgraded.steps.length} steps)`,
      );
      routed = upgraded;
    }
  }

  logPlanCoverageShadow(message, routed, request_id);

  // LLM plan-then-execute (primary understanding for free-form multi-leg).
  // Keywords/extractors already ran; model fills gaps and free-form English.
  // Allowlist + sanitize keep this safe (not unrestricted tool calling).
  //
  // Skipped entirely once `routed` is a deterministically-recognized carry plan
  // (template_id "delta_neutral_carry", from step-extractor.ts). That decomposition
  // needs no network call and is already correct; a Vertex round-trip here could only
  // replace it with a plan of equal or greater length that still has to win the
  // `>=` comparison below — and this exact strategy has previously come back from the
  // model with the wrong asset on the borrow leg and the legs out of order. Once the
  // deterministic path has it right, a model call is pure downside: latency with a
  // chance of a wrong swap, no chance of an improvement.
  const isConfirmedCarryPlan =
    routed.kind === "plan" && routed.template_id === "delta_neutral_carry";

  /**
   * The deterministic plan already accounts for every part of the message.
   *
   * `accountCoverage` records which character ranges of the prompt some component claimed
   * and what was left over; `residueIsMaterial` says whether the leftovers mean anything.
   * That measurement was already being computed every multi-goal turn and only LOGGED —
   * it is the exact question "is there anything here the model could still add?", and the
   * answer was being thrown away while the model was called regardless.
   *
   * This is the biggest single item on the Vertex bill for this surface: the planner costs
   * ~950 prompt plus 400–1800 THINKING tokens, thinking bills at output rates, and on a
   * fully-covered prompt it can only return the plan we already have. Gated on a complete
   * decomposition of at least two legs, so anything ambiguous, partial or single-leg still
   * gets the model — this trades no understanding for the saving, which is why it is safe
   * to apply by default rather than behind a flag.
   */
  const deterministicPlanIsComplete = (() => {
    if (routed.kind !== "plan") return false;
    if (routed.steps.filter((s) => s.kind === "write").length < 2) return false;
    // Most missing amounts are exactly the gap the model is useful for. An unsized
    // add_liquidity leg is different: the user intentionally supplied only the swap
    // amount and the executor already knows to pause for the LP side after the swap.
    // Calling Vertex here only adds latency and risks replacing a correct venue-aware
    // plan with a collapsed single swap.
    if (
      routed.steps.some(
        (s) =>
          s.kind === "write" &&
          s.amount == null &&
          s.op !== "add_liquidity",
      )
    ) return false;
    try {
      const ir = extractPlanIR(message);
      if (ir.steps.length < 2) return false;
      const residue = classifyCoverage(ir.coverage);
      if (!residueIsMaterial(residue)) return true;
      // The extractor may leave the natural-language LP clause as residue because
      // its amount is intentionally deferred to the pool-ratio/input card. If the
      // deterministic plan already contains that LP leg, there is no semantic gap
      // for Vertex to resolve and another model call only adds latency.
      return (
        routed.steps.some((s) => s.kind === "write" && s.op === "add_liquidity") &&
        residue.every((r) =>
          /add\s+liquidity|provide\s+liquidity|add\s+lp|aquarius|soroswap/i.test(r.span.text),
        )
      );
    } catch {
      return false; // never let the optimisation decide a turn it failed to measure
    }
  })();
  if (deterministicPlanIsComplete) {
    logCopilotEvent("llm_planner_skipped", {
      request_id,
      reason: "deterministic_plan_complete",
      steps: routed.kind === "plan" ? routed.steps.length : 0,
    });
  }

  if (
    !isConfirmedCarryPlan &&
    !deterministicPlanIsComplete &&
    shouldLlmPlan(message) &&
    (routed.kind === "plan" || looksLikeMultiGoal(message))
  ) {
    try {
      const llmPlan = await llmPlanStrategy(message, { trader, smartAccount });
      if (llmPlan && llmPlan.kind === "plan" && llmPlan.steps.length > 0) {
        // Prefer LLM order when it has ≥2 steps or richer swap args
        if (
          routed.kind !== "plan" ||
          llmPlan.steps.length >= (routed.steps?.filter((s) => s.kind === "write").length || 0)
        ) {
          console.warn(
            `[copilot] llm-planner: using model plan (${llmPlan.steps.length} steps)`,
          );
          routed = preferExtractedPlan(llmPlan, message);
        } else if (routed.kind === "plan") {
          // Merge: keep keyword structure, fill from LLM
          routed = preferMultiGoalPlan(llmPlan, routed, message);
        }
      }
    } catch (e) {
      console.warn("[copilot] llm-planner skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Single write that LLM can still promote to multi-leg
  if (routed.kind === "write" && shouldLlmPlan(message)) {
    try {
      const llmPlan = await llmPlanStrategy(message, { trader, smartAccount });
      if (llmPlan?.kind === "plan" && llmPlan.steps.length >= 2) {
        routed = llmPlan;
      }
    } catch {
      /* keep write */
    }
  }
  return { kind: "ok", routed, modelUnreachable };
}
