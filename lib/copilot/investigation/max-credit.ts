import { drawsNewDebt } from "../leg-direction";
import { assetsNamedIn } from "../registry/assets";
import type { GoalUnderstanding, ProposedPlan } from "./types";

/** An explicit maximum credit instruction can be represented in either leg channel. */
export function requestsMaximumCredit(goal: GoalUnderstanding, plans: readonly ProposedPlan[], messages: readonly string[] = []): boolean {
  const maximum = (leg: ProposedPlan["legs"][number]) => drawsNewDebt(leg.op) && leg.sizing.kind === "to_floor";
  return goal.actions?.some(maximum) === true || directMaximumCreditPlan(goal, plans, messages) >= 0;
}

/** Preserve a single requested loan after an asset-only continuation. Never choose among plans or assets. */
export function directMaximumCreditPlan(goal: GoalUnderstanding, plans: readonly ProposedPlan[], messages: readonly string[]): number {
  if (goal.actions?.length || goal.borrowing !== "required" || plans.length !== 1 || plans[0].legs.length !== 1) return -1;
  const leg = plans[0].legs[0];
  if (!drawsNewDebt(leg.op) || leg.sizing.kind !== "to_floor") return -1;
  // A borrowing permission alone does not make a strategy a direct instruction.
  if (!goal.namedOps?.some(named => named.op === leg.op && messages.some(message => message.includes(named.sourceQuote)))) return -1;
  const named = [...new Set(messages.flatMap((message) => assetsNamedIn(message).map((asset) => asset.id)))];
  return named.length === 1 && named[0] === leg.asset ? 0 : -1;
}
