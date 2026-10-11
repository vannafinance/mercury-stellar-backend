import type { ShownPlan } from "./types";

/**
 * Whether a follow-up carries the earlier messages forward.
 *
 * The model reads the latest message against the conversation and says how they relate; code only acts on its answer. A
 * `refine` carries the thread (the plan's goal, floors and reserves stay), and so does an answer to a question the
 * copilot left open. `new` and `side` do not: an earlier floor or amount must never leak into an unrelated request. A
 * missing answer does not carry either - wrongly inheriting a stale constraint into a money decision is worse than
 * asking the user to say it again.
 */
export function inheritsThread(relation: "new" | "refine" | "side" | undefined, lastQuestion: string | null): boolean {
  return relation === "refine" || (relation === undefined && lastQuestion !== null);
}

const MAX_SHOWN = 6;
const MAX_STEPS = 8;
const TITLE_LIMIT = 200;

/** The plans on screen, as short letters-titles-steps, in the order the cards show them. */
export function shownPlans(
  feasible: ReadonlyArray<{ label: string; steps?: ReadonlyArray<{ label: string }> }>,
): ShownPlan[] {
  return feasible.slice(0, MAX_SHOWN).map((candidate, index) => ({
    plan: `Plan ${String.fromCharCode(65 + index)}`,
    title: candidate.label.slice(0, TITLE_LIMIT),
    steps: (candidate.steps ?? []).slice(0, MAX_STEPS).map((step) => step.label.slice(0, TITLE_LIMIT)),
  }));
}
