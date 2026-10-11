import type { Questionnaire } from "@/lib/copilot/investigation/view";

export type QuestionnaireDismissal = {
  id: string;
  conversationId: string | null;
  turnIndex: number;
};

export function liveQuestionnaire(opts: {
  loading: boolean;
  resultOrigin: string | null;
  latestRole: string | undefined;
  questionnaire: Questionnaire | null | undefined;
  conversationId: string | null;
  turnIndex: number;
  closed: QuestionnaireDismissal | null;
}): Questionnaire | null {
  if (opts.loading || opts.resultOrigin !== "live" || opts.latestRole !== "assistant") return null;
  if (!opts.questionnaire) return null;
  if (opts.questionnaire.id === opts.closed?.id &&
      opts.conversationId === opts.closed.conversationId &&
      opts.turnIndex === opts.closed.turnIndex) return null;
  return opts.questionnaire;
}
