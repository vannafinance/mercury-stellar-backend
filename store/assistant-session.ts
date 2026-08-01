/**
 * Assistant session state — chat history survives route navigations
 * (plan Section 1.3 / Step 4).
 */

import createNewStore from "@/zustand/index";

export type AssistantTurn = {
  role: "user" | "assistant";
  text: string;
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

export function clearAssistantTurns() {
  useAssistantSessionStore.getState().set({ turns: [] });
}

export function getAssistantHistory(
  limit = 8,
): Array<{ role: "user" | "assistant"; text: string }> {
  return useAssistantSessionStore.getState().turns.slice(-limit);
}
