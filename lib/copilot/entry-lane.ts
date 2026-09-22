import { parseMinHealthFactor, routeMessage } from "./router";

/**
 * Decide which brain owns a fresh Copilot prompt.
 *
 * Explicit product reads and single actions use the deterministic capability path.
 * Open-ended allocation/optimisation requests use investigation. Swap deliberately
 * remains on its existing investigation path until its separate flow is migrated.
 */
export type CopilotEntryLane = "direct" | "strategy";

const LIFECYCLE_WRITE =
  /\b(?:open|create|set up|setup)\b[\s\S]{0,32}\b(?:margin|smart|c[- ]?)\s*account\b/i;

const SWAP_ACTION = /\b(swap|trade|exchange|convert)\b/i;

/** Annotated `boolean`, not a literal, so the keyword lane below still narrows and type-checks. */
const INVESTIGATE_FIRST: boolean = true;

/**
 * Classify a copilot prompt into "direct" or "strategy".
 *
 * Derived from resolvability rather than phrasing lists:
 * - A prompt is "direct" if routeMessage fully resolves it into an executable
 *   action with every required slot satisfied, or into a read, client action, or fully sized plan.
 * - Anything routeMessage cannot resolve — an open-ended goal (prefer_max_yield),
 *   an unsized write (missing required amount/fraction), a comparison, or a clarify response —
 *   belongs to "strategy" (the investigation loop).
 * - Swap and lifecycle account creation retain their dedicated review flows on "strategy".
 */
export function classifyCopilotEntry(message: string): CopilotEntryLane {
  const text = message.trim();
  if (!text) return "direct";

  /**
   * EXPERIMENT (branch try/investigate-first): restore "investigate first, then act".
   *
   * Everything below this line is the keyword lane introduced by 9c197cd on 20 Sep, which
   * replaced "EVERY prompt is investigated first, then acted on". Every defect in
   * docs/copilot/FIX-LIST-copilot-upgrade.md is the failure mode that change predicted: a
   * concrete instruction skips investigation and executes against whatever the keyword
   * path inferred.
   *
   * Reads cost nothing here - investigation/fast-path.ts already answers them without the
   * loop (measured 22 Sep: health 16ms, price 0.55s). Writes pay the research (~8s) and
   * gain a plan card, which is the product decision this experiment exists to test.
   *
   * Remove this return to go back to the keyword lane.
   */
  if (INVESTIGATE_FIRST) return "strategy";

  // Dedicated review flows that remain on the strategy/investigation loop
  if (SWAP_ACTION.test(text) || LIFECYCLE_WRITE.test(text)) {
    return "strategy";
  }

  const routed = routeMessage(text);

  /**
   * A stated health-factor floor makes any action a sizing problem.
   *
   * A floor is not a property of one leg; it is a property of the account AFTER the legs
   * run. Honouring it means sizing against live collateral, debt and prices — which is
   * what investigation does and what the deterministic path has no step for. The
   * deterministic path does not merely size it badly, it loses the clause: routed
   * "deploy my idle funds into blend keeping HF above 1.4" comes back as
   * { op: "deploy_to_blend", fraction: 1, requires_amount: false } with NO min_hf field
   * at all. Every sizing gate below is satisfied, so it goes direct and commits the whole
   * idle balance while the floor the user wrote is simply gone.
   *
   * Observed live on 22 Sep from two accounts. The one with auto-approve ON executed:
   * it deposited the entire idle XLM balance, borrowed against it, and reported a
   * resulting health factor of 1.30 — against a prompt that said 1.4.
   *
   * So this is tested before the resolvability gates rather than inside them. Those gates
   * ask "is every slot filled?", and the answer here is yes — the intent is fully formed,
   * it is just not the request. This asks the prior question: is there a constraint whose
   * satisfaction nothing downstream is going to check?
   *
   * Over-routing is the safe direction, and it is the direction `residue.ts` already
   * argues for: "The failure mode becomes asking a question the user did not need,
   * instead of executing a plan the user did not ask for."
   */
  if (parseMinHealthFactor(text) != null && routed.kind !== "read" && routed.kind !== "restricted") {
    return "strategy";
  }

  /**
   * A refusal is an answer, not an unanswered question.
   *
   * `restricted` is the router having DECIDED: this is outside what Copilot does, and
   * it already carries the sentence that says so. Falling through to the strategy
   * default at the bottom sent it to investigation instead, which cannot do it either
   * and says so in vaguer words — live, 22 Sep, "send my funds to G…" answered "I
   * couldn't complete this investigation with the available capabilities and
   * information" while the router's own plain refusal sat unused one branch away.
   *
   * This is the opposite case to `clarify`, which belongs on strategy: a clarify is the
   * router saying it does not know, and investigation may yet resolve it. A restriction
   * is settled, so the only thing left to do is deliver it.
   */
  if (routed.kind === "restricted") {
    return "direct";
  }

  if (routed.kind === "read") {
    return "direct";
  }

  if (routed.kind === "client") {
    return "direct";
  }

  if (routed.kind === "plan") {
    return "direct";
  }

  if (routed.kind === "write") {
    if (routed.op === "swap") {
      return "strategy";
    }
    // Optimization / yield-chasing goals belong to strategy
    if (routed.prefer_max_yield) {
      return "strategy";
    }
    // Check if required amount / sizing slot is missing
    if (routed.requires_amount) {
      const hasAmount = routed.amount != null && Number.isFinite(routed.amount);
      const hasFraction = routed.fraction != null && Number.isFinite(routed.fraction);
      const hasLpAmount = routed.amount_a != null && Number.isFinite(routed.amount_a);
      if (!hasAmount && !hasFraction && !hasLpAmount) {
        return "strategy";
      }
    }
    return "direct";
  }

  return "strategy";
}

