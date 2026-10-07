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
): { op: WorkflowOp; sourceQuote: string; whyNotUsed?: string; asked?: boolean }[] {
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

/** The reason the model gave for leaving an allowed operation out, per operation. */
export function venueReasons(rows: ReadonlyArray<{ op: WorkflowOp; whyNotUsed?: string }>): Map<WorkflowOp, string> {
  return new Map(rows.flatMap((row) => row.whyNotUsed ? [[row.op, row.whyNotUsed] as const] : []));
}

/**
 * What was allowed and not used. Empty when every allowed operation is in some plan. An operation the model gave a
 * reason for says it; the rest are named together.
 */
export function venueSentence(unused: readonly WorkflowOp[], reasons: ReadonlyMap<WorkflowOp, string> = new Map()): string {
  if (!unused.length) return "";
  const stated = unused.filter((op) => reasons.has(op));
  const bare = unused.filter((op) => !reasons.has(op));
  const named = bare.map(opWords);
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0];
  return [
    ...stated.map((op) => ` You said I could use ${opWords(op)}; I left it out: ${reasons.get(op)!.replace(/\.$/, "")}.`),
    ...(bare.length ? [` You said I could use ${list}; no plan that sizes on the current reads uses ${named.length > 1 ? "them" : "it"}.`] : []),
  ].join("");
}

export const VENUE_OP_ENUM: readonly WorkflowOp[] = WORKFLOW_OPS;
