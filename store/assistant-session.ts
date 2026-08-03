/**
 * Assistant session state — chat history survives route navigations
 * (plan Section 1.3 / Step 4).
 */

import createNewStore from "@/zustand/index";
import type { GuideAnswer } from "@/lib/copilot/guide-schema";

export type AssistantTurn = {
  role: "user" | "assistant";
  text: string;
  /**
   * Structured Guide answer for this turn, when the brain returned one. `text` always
   * carries the same content flattened, so a turn without it still reads correctly —
   * it just loses the sections, formula and glossary.
   */
  guide?: GuideAnswer | null;
  /** Whether a page was readable when this turn was sent, for the "general answer" note. */
  hasPageContext?: boolean;
};

export interface AssistantSession {
  turns: AssistantTurn[];
  open: boolean;
}

const initial: AssistantSession = {
  turns: [],
  open: false,
};

export const useAssistantSessionStore = createNewStore(initial, {
  name: "assistant-session",
  devTools: true,
  persist: { name: "assistant-session", version: 1 },
});

export function appendAssistantTurn(turn: AssistantTurn) {
  const prev = useAssistantSessionStore.getState().turns;
  const next = [...prev, turn].slice(-40);
  useAssistantSessionStore.getState().set({ turns: next });
}

export function setAssistantOpen(open: boolean) {
  useAssistantSessionStore.getState().set({ open });
}

/**
 * Gemini-style “new chat”: wipe in-memory turns and the persisted session
 * (survives route changes and page reloads via zustand persist).
 */
export function clearAssistantTurns() {
  useAssistantSessionStore.getState().set({ turns: [] });
  // Ensure localStorage key is cleared even if middleware lag leaves a stale blob.
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem("assistant-session");
    } catch {
      /* ignore */
    }
  }
}

/** Alias for UI “New chat / refresh” actions. */
export function newAssistantChat() {
  clearAssistantTurns();
}

/** Role + text only — the structured answer stays client-side, out of the prompt. */
export function getAssistantHistory(
  limit = 8,
): Array<{ role: "user" | "assistant"; text: string }> {
  return useAssistantSessionStore
    .getState()
    .turns.slice(-limit)
    .map(({ role, text }) => ({ role, text }));
}
