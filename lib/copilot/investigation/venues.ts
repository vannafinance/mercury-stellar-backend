import { WORKFLOW_OPS, type ProposalStep, type WorkflowOp } from "../workflow/types";
import type { GoalUnderstanding } from "./types";

/**
 * Operations the user said the copilot may use ("you can use spots and farm markets yourself").
 *
 * Permission is not an instruction, so nothing is forced into a plan. What it changes is what the user is owed: when
 * no sized plan uses an operation they allowed, the model is asked once to compose one where the reads show it is
 * worth it, and if none results the reply says so instead of staying silent (7 Oct: "you can use means its an
 * option, i dont know whether it is checking that"). The operations are the registry's own list, so a new venue
 * needs no entry here; the model picks them from the user's words and quotes the sentence.
 */
export function anchoredVenueRows(
  goal: Pick<GoalUnderstanding, "venuesAllowed"> | null | undefined,
  messages: readonly string[],
): { op: WorkflowOp; sourceQuote: string }[] {
  return (goal?.venuesAllowed ?? []).filter((row) => messages.some((message) => message.includes(row.sourceQuote)));
}

export function anchoredVenueOps(
  goal: Pick<GoalUnderstanding, "venuesAllowed"> | null | undefined,
  messages: readonly string[],
): WorkflowOp[] {
  return [...new Set(anchoredVenueRows(goal, messages).map((row) => row.op))];
}

/** The permitted operations that no plan's steps use. */
export function unusedVenueOps(
  allowed: readonly WorkflowOp[],
  plans: ReadonlyArray<{ steps?: ReadonlyArray<Pick<ProposalStep, "op">> }>,
): WorkflowOp[] {
  return allowed.filter((op) => !plans.some((plan) => plan.steps?.some((step) => step.op === op)));
}

export const opWords = (op: WorkflowOp): string => op.replaceAll("_", " ");

/** One sentence naming what was allowed and not used. Empty when every allowed operation is in some plan. */
export function venueSentence(unused: readonly WorkflowOp[]): string {
  if (!unused.length) return "";
  const names = unused.map(opWords);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return ` You said I could use ${list}; no plan that sizes on the current reads uses ${names.length > 1 ? "them" : "it"}.`;
}

export const VENUE_OP_ENUM: readonly WorkflowOp[] = WORKFLOW_OPS;
