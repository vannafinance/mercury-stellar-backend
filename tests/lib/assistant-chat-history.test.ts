// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendAssistantTurn, assistantChatTitle, clearAssistantTurns, openAssistantChat, pruneAssistantHistory, recentAssistantHistory, useAssistantSessionStore,
} from "@/store/assistant-session";

const state = () => useAssistantSessionStore.getState();
const say = (q: string, a = "ok") => { appendAssistantTurn({ role: "user", text: q }); appendAssistantTurn({ role: "assistant", text: a }); };

beforeEach(() => { useAssistantSessionStore.setState({ turns: [], history: [] }); });

describe("Assist chat history", () => {
  it("names a chat after its first question, and an empty one New chat", () => {
    expect(assistantChatTitle([])).toBe("New chat");
    expect(assistantChatTitle([{ role: "user", text: "  what   is a health factor? " }])).toBe("what is a health factor?");
    expect(assistantChatTitle([{ role: "user", text: "x".repeat(200) }]).length).toBeLessThanOrEqual(60);
  });

  it("keeps the chat on screen in the history when a new one starts", () => {
    say("What is a health factor?");
    clearAssistantTurns();
    expect(state().turns).toEqual([]);
    expect(state().history).toHaveLength(1);
    expect(state().history[0]).toMatchObject({ title: "What is a health factor?" });
    expect(state().history[0].turns).toHaveLength(2);
  });

  it("does not store an empty chat", () => {
    clearAssistantTurns();
    clearAssistantTurns();
    expect(state().history).toEqual([]);
  });

  it("opens an earlier chat and parks the current one in its place", () => {
    say("first question");
    clearAssistantTurns();
    say("second question");
    const firstId = state().history[0].id;
    openAssistantChat(firstId);
    expect(state().turns[0].text).toBe("first question");
    expect(state().history.map((c) => c.title)).toEqual(["second question"]);
  });

  it("opening an empty current chat leaves no empty entry behind", () => {
    say("only chat");
    clearAssistantTurns();
    const id = state().history[0].id;
    openAssistantChat(id);
    expect(state().turns[0].text).toBe("only chat");
    expect(state().history).toEqual([]);
  });

  it("ignores an id that is not in the history", () => {
    say("kept");
    openAssistantChat("missing");
    expect(state().turns[0].text).toBe("kept");
  });

  it("keeps only the 5 most recent earlier chats", () => {
    for (let i = 0; i < 9; i += 1) { say(`question ${i}`); clearAssistantTurns(); }
    expect(state().history).toHaveLength(5);
    expect(state().history.map((c) => c.title)).toContain("question 8");
    expect(state().history.map((c) => c.title)).not.toContain("question 0");
  });

  it("forgets an earlier chat a day after it was last used", () => {
    const hour = 60 * 60 * 1000;
    useAssistantSessionStore.setState({ history: [
      { id: "old", title: "yesterday", turns: [{ role: "user", text: "yesterday" }], updatedAt: Date.now() - 25 * hour },
      { id: "new", title: "this morning", turns: [{ role: "user", text: "this morning" }], updatedAt: Date.now() - 2 * hour },
    ] });
    expect(recentAssistantHistory(state().history).map((c) => c.id)).toEqual(["new"]);
    pruneAssistantHistory();
    expect(state().history.map((c) => c.id)).toEqual(["new"]);
    openAssistantChat("old");
    expect(state().turns).toEqual([]);
  });
});
