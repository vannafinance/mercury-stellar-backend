/**
 * One predicate for whether the user still has to answer something.
 *
 * Rank when alternatives are comparable from evidence already read (which venue,
 * which pool, which variant). A read can resolve those; asking is a cop-out.
 * Ask when the missing input is a preference no market or account read can
 * supply: holding horizon, risk appetite, borrow permission, a health floor
 * when none was given.
 *
 * The model should emit `questionKind` on the clarify call. Code reads that
 * field. `isPreferenceGap` is only a fallback for continuations that predate it.
 */
export type QuestionKind = "preference" | "resolvable";

/** @deprecated Do not substitute this for the model's question. Kept for older tests. */
export const BORROW_AUTHORITY =
  "May I borrow against your margin account, or should this use idle funds only?";

export function isPreferenceGap(question: string): boolean {
  // Fallback only — older sealed continuations have no questionKind.
  return (
    /how long|holding period|horizon|\b\d+\s*(days?|weeks?|months?)\b/i.test(question)
    || /health (factor )?floor|risk appetite|how conservative|how aggressive/i.test(question)
    || /may i borrow|borrow against|permission to borrow|new (debt|borrow)|should (i|we) borrow/i.test(question)
  );
}

export function simplifyQuestion(
  question: string | null,
  ctx: {
    hasRankedOptions: boolean;
    borrowing: string;
    questionKind?: QuestionKind | null;
  },
): string | null {
  if (!question) return null;
  const kind: QuestionKind = ctx.questionKind
    ?? (isPreferenceGap(question) ? "preference" : "resolvable");
  if (kind === "resolvable" && ctx.hasRankedOptions) return null;
  return question;
}
