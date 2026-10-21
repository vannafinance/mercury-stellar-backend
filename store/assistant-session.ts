/**
 * Assistant session state — chat history and the tab position survive route navigations
 * and reloads.
 */

import createNewStore from "@/zustand/index";
import type { GuideAnswer } from "@/lib/copilot/guide-schema";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";

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
  /** Optional one-click handoff prompt to open in Vanna Copilot. */
  copilotHandoffPrompt?: string | null;
  /** Structured workflow facts; kept separate from the flattened assistant text. */
  executionReceipt?: ExecutionReceiptSnapshot | null;
};

export type AssistantCoords = { x: number; y: number };

/** An earlier chat, kept so the history menu can bring it back. */
export type ArchivedChat = { id: string; title: string; turns: AssistantTurn[]; updatedAt: number };

/** Earlier chats kept, and how long each is kept after it was last used. */
export const HISTORY_LIMIT = 5;
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const TITLE_LIMIT = 60;

/** A chat is named after its first question, the way the chat list names it. */
export function assistantChatTitle(turns: readonly AssistantTurn[]): string {
  const first = turns.find((t) => t.role === "user")?.text.replace(/\s+/g, " ").trim();
  if (!first) return "New chat";
  return first.length > TITLE_LIMIT ? `${first.slice(0, TITLE_LIMIT - 1).trimEnd()}\u2026` : first;
}

export interface AssistantSession {
  turns: AssistantTurn[];
  /** Earlier chats, newest activity last. The chat on screen is `turns`, not part of this list. */
  history: ArchivedChat[];
  open: boolean;
  launcherPos: AssistantCoords | null;
}

const initial: AssistantSession = {
  turns: [],
  history: [],
  open: false,
  launcherPos: null,
};

export const useAssistantSessionStore = createNewStore(initial, {
  name: "assistant-session",
  devTools: true,
  persist: {
    name: "assistant-session",
    version: 2,
    // v1 saved only turns and open; keep them and give the v2 fields their defaults.
    migrate: (persisted: unknown) => ({ ...initial, ...((persisted as Partial<AssistantSession> | null) ?? {}) }),
  },
});

export function appendAssistantTurn(turn: AssistantTurn) {
  const prev = useAssistantSessionStore.getState().turns;
  const next = [...prev, turn].slice(-40);
  useAssistantSessionStore.getState().set({ turns: next });
}

/**
 * Attach the latest journal snapshot to the current assistant turn.
 *
 * Replaying a ledger poll is safe: the same workflow replaces the snapshot on the same
 * turn instead of appending another prose turn. A different workflow is not allowed to
 * overwrite the latest receipt, which prevents a late poll from corrupting newer history.
 */
export function updateAssistantExecutionReceipt(receipt: ExecutionReceiptSnapshot): boolean {
  const previous = useAssistantSessionStore.getState().turns;
  const reversed = [...previous].map((turn, i) => ({ turn, i })).reverse();
  const matching = reversed.find(({ turn }) =>
    turn.role === "assistant" && turn.executionReceipt?.workflowId === receipt.workflowId);
  const index = matching?.i ?? reversed.find(({ turn }) =>
    turn.role === "assistant" && !turn.executionReceipt)?.i;
  if (index == null) return false;
  const current = previous[index].executionReceipt;
  if (current && JSON.stringify(current) === JSON.stringify(receipt)) return true;
  const turns = [...previous];
  turns[index] = { ...turns[index], executionReceipt: receipt };
  useAssistantSessionStore.getState().set({ turns });
  return true;
}

export function setAssistantOpen(open: boolean) {
  useAssistantSessionStore.getState().set({ open });
}

export function setAssistantLauncherPos(launcherPos: AssistantCoords | null) {
  useAssistantSessionStore.getState().set({ launcherPos });
}

/**
 * The earlier chats still worth showing: used within the last day, newest first, at most five. The saved list is
 * oldest first, so two chats archived in the same instant are told apart by their place in it.
 */
export function recentAssistantHistory(history: readonly ArchivedChat[] | undefined, now: number = Date.now()): ArchivedChat[] {
  return (history ?? [])
    .map((chat, order) => ({ chat, order }))
    .filter(({ chat }) => now - chat.updatedAt < HISTORY_TTL_MS)
    .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt || b.order - a.order)
    .slice(0, HISTORY_LIMIT)
    .map(({ chat }) => chat);
}

/** Drop expired and surplus chats from the saved list. */
export function pruneAssistantHistory() {
  const { history } = useAssistantSessionStore.getState();
  const kept = recentAssistantHistory(history).reverse();
  if (kept.length !== (history ?? []).length) useAssistantSessionStore.getState().set({ history: kept });
}

function archiveCurrent(): ArchivedChat[] {
  const { turns, history } = useAssistantSessionStore.getState();
  if (!turns.length) return recentAssistantHistory(history).reverse();
  const entry: ArchivedChat = { id: `chat-${Date.now()}-${(history ?? []).length}`, title: assistantChatTitle(turns), turns, updatedAt: Date.now() };
  return recentAssistantHistory([...(history ?? []), entry]).reverse();
}

/**
 * Start a new chat. The chat that was on screen is kept in the history menu instead of being thrown away,
 * and the tab position is preserved.
 */
export function clearAssistantTurns() {
  useAssistantSessionStore.getState().set({ history: archiveCurrent(), turns: [] });
}

/** Bring an earlier chat back; the one on screen takes its place in the history. */
export function openAssistantChat(id: string) {
  const { history } = useAssistantSessionStore.getState();
  const chosen = recentAssistantHistory(history).find((chat) => chat.id === id);
  if (!chosen) return;
  const rest = (history ?? []).filter((chat) => chat.id !== id);
  useAssistantSessionStore.setState({ history: rest });
  const kept = archiveCurrent();
  useAssistantSessionStore.setState({ history: kept, turns: chosen.turns });
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
