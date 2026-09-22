/**
 * In-memory ring of the last few in-app events the Assistant can cite.
 * Not persisted — hashes and error text should not survive a reload.
 */

import createNewStore from "@/zustand/index";
import type { AssistantSessionEvent } from "@/lib/copilot/types";
import { MAX_SESSION_EVENTS, classifyToastMessage, extractTxHash } from "@/lib/assistant/packet";

export interface AssistantEventState {
  events: AssistantSessionEvent[];
}

const initial: AssistantEventState = { events: [] };

export const useAssistantEventsStore = createNewStore(initial, {
  name: "assistant-events",
  devTools: true,
});

export function recordAssistantEvent(
  input: Omit<AssistantSessionEvent, "at"> & { at?: number },
): AssistantSessionEvent {
  const event: AssistantSessionEvent = {
    kind: input.kind,
    message: String(input.message || "").trim().slice(0, 400),
    at: input.at ?? Date.now(),
    tx_hash: input.tx_hash ?? extractTxHash(input.message),
    code: input.code ?? null,
    path: typeof window !== "undefined" ? window.location.pathname : input.path ?? null,
  };
  if (!event.message) return event;
  const prev = useAssistantEventsStore.getState().events;
  const next = [...prev, event].slice(-MAX_SESSION_EVENTS);
  useAssistantEventsStore.getState().set({ events: next });
  return event;
}

export function recordToastError(message: string): void {
  const text = String(message || "").trim();
  if (!text) return;
  recordAssistantEvent({ kind: classifyToastMessage(text), message: text });
}

export function getRecentAssistantEvents(limit = MAX_SESSION_EVENTS): AssistantSessionEvent[] {
  return useAssistantEventsStore.getState().events.slice(-limit);
}
