import type { PlanSizing } from "./types";
import type { QuestionnaireAnswers } from "./view";

/** The answer carries no authority to change a sizing retained by the server. */
export function answerForKnownSizing(sizing: PlanSizing | undefined): QuestionnaireAnswers["amount"] | null {
  if (!sizing) return null;
  if (sizing.kind === "literal") return { kind: "literal", amount: sizing.amount };
  if (sizing.kind === "fraction" && !sizing.allocation) return { kind: "fraction", percent: sizing.percent };
  if (sizing.kind === "all_wallet" || sizing.kind === "all_position") return { kind: "fraction", percent: "100" };
  return null;
}
