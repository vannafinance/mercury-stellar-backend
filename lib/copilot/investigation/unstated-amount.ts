import type { QuestionnaireMissing } from "./questionnaire";
import type { CarriedGoal, GoalUnderstanding, PlanLeg, ResearchDecision, StatedAction } from "./types";
import { verbOf } from "./plan";

type Decided = ResearchDecision & { kind: "clarify" | "blocked" | "research_complete" };

/**
 * A whole-wallet amount is never a size the copilot may choose for a bare instruction.
 *
 * The model sizes a stated action with no amount ("deposit xlm", "lend 20 blusdc and deposit
 * xlm") as `all_wallet`, which is the whole idle balance: live, "deposit xlm" became a deposit of
 * 7,648 XLM, and under auto-approve a direct action runs as soon as it is prepared. A stated
 * unquoted `all_wallet` therefore becomes a missing amount: the questionnaire asks how much, with
 * the balance and Max one click away. Decided from the sizing kind alone, never from the user's
 * words. An anchored sizing quote distinguishes a user-selected whole balance from a model-selected
 * one. Plans the model composes are untouched: they
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

/** Preserve user-selected wallet sizing only when its provenance is anchored in the conversation. */
function userSizedWallet(sizing: PlanLeg["sizing"], messages: readonly string[]): boolean {
  return sizing.kind === "all_wallet" && Boolean(sizing.sourceQuote?.trim())
    && messages.some((message) => message.includes(sizing.sourceQuote!));
}

/**
 * The same rule for a request the model answered with composed plans instead of stated actions.
 *
 * "deposit XLM" was answered with a plan that deposits the whole balance, because the model called a plain instruction a strategy
 * and the guard above only looks at stated actions (7 Oct, live, Gemini 3.8: the questionnaire stopped appearing). What the
 * model is asked for instead is an extraction - which operations did the user name - and the quote it gives is checked against
 * their messages. A named operation whose amount the copilot would choose (the whole balance, or a split it made) is a missing
 * amount, whatever label the request was given. Plans for a goal with no named operation are untouched.
 */
export function askForUnstatedPlanAmounts<T extends { kind: string }>(input: T, messages: readonly string[]): T {
  if (input.kind !== "research_complete") return input;
  const outcome = input as unknown as Extract<ResearchDecision, { kind: "research_complete" }>;
  const allocationQuote = outcome.goal.allocationRequest?.sourceQuote;
  if (outcome.goal.intent === "strategy" && allocationQuote?.trim()
    && messages.some(message => message.includes(allocationQuote))) return input;
  const named = (outcome.goal.namedOps ?? []).filter((row) => messages.some((message) => message.includes(row.sourceQuote)));
  if (!named.length || !outcome.plans?.length) return input;
  const chosenByCopilot = (leg: PlanLeg) => named.some((row) => row.op === leg.op)
    && ((leg.sizing.kind === "all_wallet" && !userSizedWallet(leg.sizing, messages)) || (leg.sizing.kind === "fraction" && Boolean(leg.sizing.allocation)));
  // Alternatives: it takes every plan to be affected before the request counts as having no amount.
  if (!outcome.plans.every((plan) => plan.legs.some(chosenByCopilot))) return input;
  const missing: QuestionnaireMissing[] = [];
  for (const leg of outcome.plans[0].legs.filter(chosenByCopilot)) {
    if (missing.some((entry) => entry.op === leg.op && entry.asset === leg.asset)) continue;
    missing.push({ op: leg.op, asset: leg.asset, slots: ["amount"], sourceQuote: named.find((row) => row.op === leg.op)!.sourceQuote });
  }
  return {
    kind: "clarify",
    question: `How much for ${missing.map((entry) => `${verbOf(entry.op!).toLowerCase()} ${entry.asset}`).join(" and ")}?`,
    actions: [],
    missing,
    ...(outcome.goal.trigger ? { trigger: outcome.goal.trigger } : {}),
    ...(carriedOf(outcome.goal) ? { carried: carriedOf(outcome.goal) } : {}),
  } as unknown as T;
}

export function askForUnstatedAmounts<T extends { kind: string }>(input: T, messages: readonly string[] = []): T {
  if (input.kind !== "clarify" && input.kind !== "research_complete") return input;
  const outcome = input as unknown as Decided;
  const split = (actions: readonly StatedAction[] | undefined) => {
    const kept: StatedAction[] = [];
    const missing: QuestionnaireMissing[] = [];
    for (const action of actions ?? []) {
      if (action.sizing.kind === "all_wallet" && !userSizedWallet(action.sizing, messages)) {
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
