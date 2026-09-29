import { lpPairs } from "../registry/assets";
import { deploysIntoPosition, OP_FLOW, WORKFLOW_OPS } from "../workflow/types";
import { CANDIDATE_KINDS } from "./candidate-id";
import type { CandidateSet } from "./candidates";
import { legTitle } from "./plan";
import { assetsAccepted } from "./questionnaire";
import type { PlanLeg, ProposedPlan } from "./types";

/**
 * Every place an idle asset can be put to work, not only the two the fixed generator knows.
 *
 * The fixed shapes are Earn (`lend_idle`) and Blend (`supply_idle`). A strategy request such as
 * "put my idle usdc to work" therefore never saw the DEX pools, although the registry says
 * AQUSDC pairs with XLM on Aquarius and SOUSDC on Soroswap (owner, 25 Sep). This fills in the
 * remaining venues for exactly the assets the fixed generator already offers — the ones the
 * user named and holds idle — so it answers the same question on the same assets, never a new
 * one. Venues come from OP_FLOW and the registry (`assetsAccepted`, `lpPairs`), so a pool added
 * to the registry shows up here with no change.
 *
 * Each plan is ONE leg sized `all_idle` and goes through the same sizer as every other plan:
 * the deposit a margin-account op needs is expanded there, the pool pair is sized from the live
 * reserves, and anything that does not fit is refused with its reason, not shown.
 */
export function venueCoveragePlans(fixed: CandidateSet | null, existing: readonly ProposedPlan[], objective: string): ProposedPlan[] {
  if (!fixed) return [];
  const idle = fixed.feasible.filter((candidate) => candidate.kind !== "composed" && CANDIDATE_KINDS[candidate.kind].funding === "wallet");
  const covered = new Set(idle.map((candidate) => `${candidate.asset}:${CANDIDATE_KINDS[candidate.kind as keyof typeof CANDIDATE_KINDS].venue}`));
  const already = new Set(existing.flatMap((plan) => plan.legs.map((leg) => `${leg.op}:${leg.asset}:${leg.venue ?? ""}`)));
  const plans: ProposedPlan[] = [];
  for (const asset of [...new Set(idle.map((candidate) => candidate.asset))]) {
    for (const op of WORKFLOW_OPS.filter((each) => deploysIntoPosition(each) && assetsAccepted(each).includes(asset as never))) {
      const flow = OP_FLOW[op];
      if (covered.has(`${asset}:${flow.to}`)) continue;
      const legs: PlanLeg[] = flow.to === "lp"
        ? lpPairs().filter((pair) => pair.tokens.includes(asset as never)).map((pair) => ({
            op, asset, assetOut: pair.tokens.find((token) => token !== asset), venue: pair.venue, sizing: { kind: "all_idle" as const },
          }))
        : [{ op, asset, sizing: { kind: "all_idle" as const } }];
      for (const leg of legs) {
        if (already.has(`${leg.op}:${leg.asset}:${leg.venue ?? ""}`)) continue;
        plans.push({ title: legTitle(leg), rationale: objective, evidenceIds: [], legs: [leg] });
      }
    }
  }
  return plans;
}
