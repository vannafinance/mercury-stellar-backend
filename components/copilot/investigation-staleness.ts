/**
 * Whether the investigation card is showing the answer to an earlier question.
 *
 * Such a card is hidden so the thread does not present an old answer under a new prompt. An
 * error from the newest turn is never hidden with it: a follow-up that fails after a good answer
 * would otherwise disappear without a word, and the user is left staring at their own question.
 */
export function isInvestigationStale(input: {
  hasResult: boolean;
  loading: boolean;
  hasError: boolean;
  hasWorkflow: boolean;
  workflowLoading: boolean;
  signing: boolean;
  lastUserTurn: string | null | undefined;
  prompt: string | null | undefined;
}): boolean {
  return Boolean(
    input.hasResult &&
    !input.hasError &&
    !input.loading &&
    !input.hasWorkflow &&
    !input.workflowLoading &&
    !input.signing &&
    input.lastUserTurn &&
    input.prompt &&
    input.lastUserTurn !== input.prompt,
  );
}
