import { assetsNamedIn, venueUsdc } from "../registry/assets";
import { OP_FLOW } from "../workflow/types";
import type { GoalUnderstanding, ProposedPlan } from "./types";

/** A single named position exit remains a direct instruction in either leg channel. */
export function directPositionPlan(goal: GoalUnderstanding, plans: readonly ProposedPlan[], messages: readonly string[]): number {
  if (goal.intent !== "strategy" || goal.portfolioExit || plans.length !== 1 || plans[0].legs.length !== 1) return -1;
  const leg = plans[0].legs[0];
  if (leg.sizing.kind !== "all_position" || !OP_FLOW[leg.op].positionRead) return -1;
  if (goal.actions?.length) {
    const action = goal.actions[0];
    // A duplicate is the same instruction, not permission to drop other steps.
    if (goal.actions.length !== 1 || action.op !== leg.op || action.asset !== leg.asset
      || action.assetOut !== leg.assetOut || action.venue !== leg.venue || action.sizing.kind !== leg.sizing.kind
      || !action.sourceQuote.trim() || !messages.some(message => message.includes(action.sourceQuote))) return -1;
  }
  const named = goal.namedOps?.filter(row => row.op === leg.op && row.sourceQuote.trim()
    && messages.some(message => message.includes(row.sourceQuote))) ?? [];
  for (const row of named) {
    const assets = assetsNamedIn(row.sourceQuote);
    if (assets.length === 1 && assets[0].id === leg.asset) return 0;
    // A venue that accepts one USDC variant has no second token choice.
    if (!assets.length && venueUsdc().some(venue => venue.venue === OP_FLOW[leg.op].venue && venue.usdc === leg.asset)) return 0;
  }
  return -1;
}
