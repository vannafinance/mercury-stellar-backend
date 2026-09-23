import { matchHealthFactorCeiling, matchMinHealthFactor } from "../router";
import type { GoalUnderstanding } from "./types";

/**
 * The floor the model reported, accepted only when its quote is really in the user's
 * messages and really contains the number. The model locates the sentence; the user's
 * own text vouches for the value. Formatted like `statedFloorFrom` so the two agree.
 */
/**
 * Whether the user accepted a bad fill, verified against their own words.
 *
 * Consent is the one thing a model must never supply on a user's behalf, so the quote it
 * cites has to appear verbatim in a message the user actually sent — the same anchoring
 * `anchoredGoalFloor` applies to a stated health-factor floor. A model that paraphrases,
 * infers agreement from impatience, or quotes its own earlier sentence fails this and the
 * protective refusal stays in place.
 */
export function anchoredSlippageAccepted(
  goal: Pick<GoalUnderstanding, "slippageAccepted"> | null | undefined,
  messages: readonly string[],
): boolean {
  const accepted = goal?.slippageAccepted;
  if (!accepted?.accepted) return false;
  return messages.some((message) => message.includes(accepted.sourceQuote));
}

/**
 * The wallet reserves the user stated, kept only when the quote really is in a message they
 * sent and contains the amount. The same anchoring as the floor: the model locates the
 * sentence, the user's own text vouches for the number. When one token is named twice the
 * larger amount stands, since keeping more back is never the unsafe reading.
 */
export function anchoredWalletReserves(
  goal: Pick<GoalUnderstanding, "walletReserves"> | null | undefined,
  messages: readonly string[],
): { asset: string; amount: string }[] {
  const kept = new Map<string, string>();
  for (const row of goal?.walletReserves ?? []) {
    if (!row.sourceQuote.includes(row.amount) || !messages.some((message) => message.includes(row.sourceQuote))) continue;
    const prior = kept.get(row.asset);
    if (prior === undefined || Number(row.amount) > Number(prior)) kept.set(row.asset, row.amount);
  }
  return [...kept].map(([asset, amount]) => ({ asset, amount }));
}

/** True only when the model said its plans are PARTS of one request, quoting words the user really sent. */
export function anchoredPlanParts(
  goal: Pick<GoalUnderstanding, "planRelation"> | null | undefined,
  messages: readonly string[],
): boolean {
  const relation = goal?.planRelation;
  return relation?.kind === "parts" && messages.some((message) => message.includes(relation.sourceQuote));
}

export function anchoredGoalFloor(goal: Pick<GoalUnderstanding, "healthFactorFloor"> | null | undefined, messages: readonly string[]): string | null {
  const floor = goal?.healthFactorFloor;
  if (!floor) return null;
  if (!messages.some((message) => message.includes(floor.sourceQuote)) || !floor.sourceQuote.includes(floor.value)) return null;
  const n = Number(floor.value);
  return Number.isFinite(n) && n > 0 && n < 50 ? n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : null;
}

/**
 * The health-factor floor the user stated, as a decimal string, or null when they stated
 * none. The latest explicit floor wins, the same precedence the research prompt states
 * for any later user instruction superseding an earlier one. Returned even when it is at
 * or below the liquidation line — callers say so; nothing here substitutes a default.
 *
 * Six decimals, NOT eighteen. `parseMinHealthFactor` returns a JS float, and
 * `(1.3).toFixed(18)` is "1.300000000000000044" — binary representation noise. At 18
 * places that noise reaches the WAD value, and a stated floor of exactly 1.1 became
 * 1.100000000000000089, which is GREATER than the liquidation threshold and so slipped
 * past the guard. Truncating first discards the tail: a health-factor floor is never
 * meaningfully specified beyond six places.
 */
export function statedFloorFrom(messages: readonly string[]): string | null {
  let floor: number | null = null;
  for (const message of messages) {
    const parsed = matchMinHealthFactor(message);
    // "avoid liquidation" names no number; a floor must be the user's own figure.
    if (parsed !== null && !parsed.soft) floor = parsed.value;
  }
  return floor === null ? null : floor.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A health-factor ceiling the user stated while stating no floor.
 *
 * Returned so the caller can SAY that the limit was read as the opposite of a floor,
 * instead of proceeding as though nothing had been asked for. A message that parses
 * as a floor is never a ceiling, so the floor is resolved first and wins.
 */
export function statedCeilingFrom(messages: readonly string[]): string | null {
  if (statedFloorFrom(messages) !== null) return null;
  let ceiling: number | null = null;
  for (const message of messages) {
    const parsed = matchHealthFactorCeiling(message);
    if (parsed !== null) ceiling = parsed;
  }
  return ceiling === null ? null : ceiling.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
