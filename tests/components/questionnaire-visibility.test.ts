import { describe, expect, it } from "vitest";
import { liveQuestionnaire } from "@/components/copilot/questionnaire-visibility";
import type { Questionnaire } from "@/lib/copilot/investigation/view";

const questionnaire = { id: "same-asset-form" } as Questionnaire;
const current = {
  loading: false, resultOrigin: "live", latestRole: "assistant",
  questionnaire, conversationId: "chat-a", turnIndex: 1,
  closed: { id: questionnaire.id, conversationId: "chat-a", turnIndex: 1 },
};

describe("questionnaire dismissal belongs to the reply that issued it", () => {
  it("keeps a dismissed form hidden on the same reply", () => {
    expect(liveQuestionnaire(current)).toBeNull();
  });
  it("shows the identical asset form when a new chat asks again", () => {
    expect(liveQuestionnaire({ ...current, conversationId: "chat-b" })).toBe(questionnaire);
  });
  it("shows the identical form when a later reply asks again in the same chat", () => {
    expect(liveQuestionnaire({ ...current, turnIndex: 3 })).toBe(questionnaire);
  });
  it("does not reopen historical forms from restored conversations", () => {
    expect(liveQuestionnaire({ ...current, resultOrigin: "restored", closed: null })).toBeNull();
  });
  it("does not show a form while its replacement is loading", () => {
    expect(liveQuestionnaire({ ...current, loading: true, closed: null })).toBeNull();
  });
  it("does not show a previous reply's form after a user turn", () => {
    expect(liveQuestionnaire({ ...current, latestRole: "user", closed: null })).toBeNull();
  });
});
