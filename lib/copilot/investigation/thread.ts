/**
 * Session rows that used to move as one switch. They move independently:
 *
 *   Transcript  — what's on screen. Never reset on a new goal.
 *   Evidence    — facts read from chain. Carry across runs, with staleness.
 *   Commitment  — the open question, the proposal, the approval fingerprint.
 *
 * "Start fresh" means only the third row. Independent-vs-continuation is a
 * heuristic and will misfire; keeping transcript and evidence makes a wrong
 * "independent" call cheap. Resetting them silently destroys the user's context.
 */

import type { ResearchView } from "./view";
import type { ExecutionReceiptSnapshot } from "../execution-receipt";

export type ThreadTurn = {
  role: "user" | "assistant";
  text: string;
  question?: string | null;
  /** Structured workflow facts, when this assistant turn has an execution receipt. */
  executionReceipt?: ExecutionReceiptSnapshot | null;
};

export type LastInvestigation = {
  question: string | null;
  status?: string;
  understanding?: { intent?: string } | null;
};

export function isRefinement(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (isIndependentGoal(text) && !/instead|make it|change (the )?(floor|budget)|also use|use \S+ too/i.test(text)) {
    return false;
  }
  return /instead|make it|change (the )?(floor|budget|hf|health)|use \S+ too|also use|don'?t borrow|no (new )?borrow|you can borrow|may borrow|switch|higher floor|lower floor|\b1\.\d\b/i.test(text);
}

/** Health / price / "am I safe" — a new objective that must not inherit the last plan. */
export function isFactualIndependent(message: string): boolean {
  return /^(what'?s|whats|wats|how much is|price of|am i|is my)\b/i.test(message.trim());
}

/** Health / repay / price questions that must not inherit a prior strategy objective. */
export function isIndependentGoal(message: string): boolean {
  return isFactualIndependent(message)
    || /^(repay|lend|deposit|withdraw|borrow)\s+\d/i.test(message.trim());
}

/**
 * Inherit the sealed objective (messages + lastQuestion). Only an answer to an
 * open question, or a refinement of the current plan. Independent goals start a
 * new objective; they still carry transcript and evidence on other channels.
 */
export function shouldContinueInvestigation(
  message: string,
  last: LastInvestigation | null,
): boolean {
  if (!last) return false;
  if (isIndependentGoal(message)) return false;
  if (last.question) return true;
  if (last.understanding?.intent === "strategy" || last.status === "researched") {
    return isRefinement(message);
  }
  return false;
}

/**
 * Kill the awaiting proposal / approval fingerprint. Factual side-questions keep
 * a plan that is already on screen; a new write, a new strategy, or a floor
 * refinement replaces it because the fingerprint is bound to one specific plan.
 */
export function shouldReplacePlan(message: string, last: LastInvestigation | null): boolean {
  if (shouldContinueInvestigation(message, last)) {
    return Boolean(last && !last.question && isRefinement(message));
  }
  if (isFactualIndependent(message)) return false;
  return true;
}

const STORAGE_PREFIX = "vanna.copilot.thread.";
const LIST_PREFIX = "vanna.copilot.conversations.";
/** On-screen chat that the server has not recorded yet — never sent as conversationId. */
export const LIVE_CONVERSATION_ID = "local:current";
const TITLE_LIMIT = 80;

export type StoredThread = {
  turns: ThreadTurn[];
  continuation: string | null;
  wallet: string;
  result: ResearchView | null;
  /** The server-side conversation this thread belongs to; null for a chat that has not had a turn yet. */
  conversationId?: string | null;
};

/** What the conversation list shows for each conversation. */
export type ConversationSummary = { id: string; title: string; createdAt: number; updatedAt: number };

export function threadStorageKey(wallet: string): string {
  return `${STORAGE_PREFIX}${wallet}`;
}

export function conversationsStorageKey(wallet: string): string {
  return `${LIST_PREFIX}${wallet}`;
}

/** First user prompt, cut to a line — same rule the server uses to title a conversation. */
export function titleForConversation(firstPrompt: string): string {
  const line = firstPrompt.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : line || "New chat";
}

export function titleFromTurns(turns: readonly ThreadTurn[]): string {
  const first = turns.find((turn) => turn.role === "user")?.text ?? "";
  return titleForConversation(first);
}

export function isLocalConversationId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("local:");
}

export function readStoredConversations(wallet: string | null): ConversationSummary[] {
  if (!wallet || typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(conversationsStorageKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ConversationSummary =>
      !!entry && typeof entry === "object"
      && typeof (entry as ConversationSummary).id === "string"
      && typeof (entry as ConversationSummary).title === "string"
      && typeof (entry as ConversationSummary).createdAt === "number"
      && typeof (entry as ConversationSummary).updatedAt === "number");
  } catch {
    return [];
  }
}

export function writeStoredConversations(wallet: string | null, items: readonly ConversationSummary[]): void {
  if (!wallet || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(conversationsStorageKey(wallet), JSON.stringify(items.slice(0, 30)));
  } catch { /* quota — the live thread still works */ }
}

/** Newest first. Replaces an existing row with the same id rather than duplicating it. */
export function upsertConversation(
  items: readonly ConversationSummary[],
  entry: ConversationSummary,
): ConversationSummary[] {
  return [entry, ...items.filter((item) => item.id !== entry.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readStoredThread(wallet: string | null): StoredThread | null {
  if (!wallet || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(threadStorageKey(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredThread;
    if (!parsed || parsed.wallet !== wallet || !Array.isArray(parsed.turns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredThread(wallet: string | null, value: StoredThread): void {
  if (!wallet || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(threadStorageKey(wallet), JSON.stringify({
      turns: value.turns.slice(-16),
      continuation: value.continuation,
      wallet,
      result: value.result,
      conversationId: value.conversationId ?? null,
    }));
  } catch { /* quota — the live thread still works until reload */ }
}

export function clearStoredThread(wallet: string | null): void {
  if (!wallet || typeof sessionStorage === "undefined") return;
  try { sessionStorage.removeItem(threadStorageKey(wallet)); } catch { /* ignore */ }
}

export function localThreadStorageKey(wallet: string, localId: string): string {
  return `${STORAGE_PREFIX}${wallet}.${localId}`;
}

export function readStoredLocalThread(wallet: string | null, localId: string): StoredThread | null {
  if (!wallet || !localId || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(localThreadStorageKey(wallet, localId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredThread;
    if (!parsed || parsed.wallet !== wallet || !Array.isArray(parsed.turns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredLocalThread(wallet: string | null, localId: string, value: StoredThread): void {
  if (!wallet || !localId || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      localThreadStorageKey(wallet, localId),
      JSON.stringify({
        turns: value.turns.slice(-16),
        continuation: value.continuation,
        wallet,
        result: value.result,
        conversationId: localId,
      }),
    );
  } catch {
    /* quota — the live thread still works */
  }
}

export function clearStoredLocalThread(wallet: string | null, localId: string): void {
  if (!wallet || !localId || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(localThreadStorageKey(wallet, localId));
  } catch {
    /* ignore */
  }
}

/**
 * A finished run that belongs to an EARLIER reply than the newest one.
 *
 * The receipt is attached to the assistant turn that ran it (session-store keeps that
 * invariant). While that turn is the newest reply, the live card draws the run and the thread
 * leaves the receipt out, so one run is one card. Once a newer reply exists, the run is
 * history: the thread must draw it on its own turn, and the live card must let it go. Before
 * this, a new question in the same chat kept the old run on the live card, the thread kept
 * hiding its receipt, and the execution card vanished from the conversation (owner, 25 Sep).
 * A run still in progress is never treated as past.
 */
export function runIsOnEarlierTurn(
  turns: readonly Pick<ThreadTurn, "role" | "executionReceipt">[],
  run: { id: string; finished: boolean } | null,
): boolean {
  if (!run || !run.finished) return false;
  const owner = turns.findIndex((turn) => turn.role === "assistant" && turn.executionReceipt?.workflowId === run.id);
  if (owner === -1) return false;
  const newest = turns.map((turn) => turn.role).lastIndexOf("assistant");
  return owner < newest;
}
