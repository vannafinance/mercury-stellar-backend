import type { QuestionnaireMissing } from "./questionnaire";
import type { CarriedGoal, GoalUnderstanding, ResearchDecision, StatedAction } from "./types";
import { verbOf } from "./plan";

type Decided = ResearchDecision & { kind: "clarify" | "blocked" | "research_complete" };

/**
 * "All idle" is never an amount the copilot may choose for you (owner, 25 Sep).
 *
 * The model sizes a stated action with no amount ("deposit xlm", "lend 20 blusdc and deposit
 * xlm") as `all_idle`, which is the whole idle balance: live, "deposit xlm" became a deposit of
 * 7,648 XLM, and under auto-approve a direct action runs as soon as it is prepared. A stated
 * action's `all_idle` therefore becomes a missing amount: the questionnaire asks how much, with
 * the balance and Max one click away. Decided from the sizing kind alone, never from the user's
 * words, so every phrasing is covered the same way. Plans the model composes are untouched: they
 * always wait for Approve.
 */
function carriedOf(goal: GoalUnderstanding): CarriedGoal | null {
  const carried: CarriedGoal = {
    ...(goal.walletReserves?.length ? { walletReserves: goal.walletReserves } : {}),
    ...(goal.healthFactorFloor ? { healthFactorFloor: goal.healthFactorFloor } : {}),
    ...(goal.slippageAccepted ? { slippageAccepted: goal.slippageAccepted } : {}),
  };
  return Object.keys(carried).length ? carried : null;
}

export function askForUnstatedAmounts<T extends { kind: string }>(input: T): T {
  if (input.kind !== "clarify" && input.kind !== "research_complete") return input;
  const outcome = input as unknown as Decided;
  const split = (actions: readonly StatedAction[] | undefined) => {
    const kept: StatedAction[] = [];
    const missing: QuestionnaireMissing[] = [];
    for (const action of actions ?? []) {
      if (action.sizing.kind === "all_idle") {
        missing.push({ op: action.op, asset: action.asset, slots: ["amount"], sourceQuote: action.sourceQuote });
      } else kept.push(action);
    }
    return { kept, missing };
  };
  if (outcome.kind === "clarify") {
    const { kept, missing } = split(outcome.actions);
    if (!missing.length) return input;
    return { ...outcome, actions: kept, missing: [...(outcome.missing ?? []), ...missing] } as unknown as T;
  }
  if (outcome.kind === "research_complete" && !outcome.plans?.length && outcome.goal.actions?.length) {
    const { kept, missing } = split(outcome.goal.actions);
    if (!missing.length) return input;
    return {
      kind: "clarify",
      // Named from the actions themselves: which steps need an amount.
      question: `How much for ${missing.map((entry) => `${verbOf(entry.op!).toLowerCase()} ${entry.asset}`).join(" and ")}?`,
      actions: kept,
      missing,
      ...(outcome.goal.trigger ? { trigger: outcome.goal.trigger } : {}),
      // The user's own limits still bind the answer: a reserve, a floor, an accepted loss.
      ...(carriedOf(outcome.goal) ? { carried: carriedOf(outcome.goal) } : {}),
    } as unknown as T;
  }
  return input;
}
