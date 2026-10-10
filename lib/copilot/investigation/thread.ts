/**
 * Session rows that used to move as one switch. They move independently:
 *
 *   Transcript  - what's on screen. Never reset on a new goal.
 *   Evidence    - facts read from chain. Carry across runs, with staleness.
 *   Commitment  - the open question, the proposal, the approval fingerprint.
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
  /**
   * The reply was a form (a questionnaire) and nothing else: the form is the answer, so the thread draws no sentence above it.
   * The text stays for history and for the model's context.
   */
  quiet?: boolean;
  /** Structured workflow facts, when this assistant turn has an execution receipt. */
  executionReceipt?: ExecutionReceiptSnapshot | null;
  /** The composed reply (compose.ts); `text` stays its plain form for history and older views. */
  blocks?: import("./view").ReplyBlock[];
  /** Server-owned completion presentation, bound to this exact workflow receipt. */
  completion?: import("../workflow-completion").WorkflowCompletion;
};

export type LastInvestigation = {
  question: string | null;
  status?: string;
  understanding?: { intent?: string } | null;
};

/**
 * Whether a reply brings plans or a write of its own, and so replaces the plan that was on screen.
 *
 * Whether a message continues the earlier thread is the model's reading (`relation` on the goal), made on the server with the
 * plans on screen in front of it; the client no longer guesses from the wording before sending. What the client still has to
 * decide is what to draw: a reply that carries its own plans, a staged write or a form takes the place of the old plan, and
 * an answer or a question leaves it where it is.
 */
/**
 * A finished run that belongs to an EARLIER reply and so stands in the way of preparing this reply's plan.
 *
 * The run this reply's own plan started is finished too once it settles, and clearing it then would throw away the run whose summary is
 * about to be written (7 Oct, live: the run was cleared the moment it completed and no summary was ever composed). What tells the two
 * apart is which reply the run was prepared for, so that is what is compared.
 */
export function isStaleFinishedRun(run: { status: string } | null | undefined, preparedFor: string | null, continuation: string | null): boolean {
  return !!run && (run.status === "completed" || run.status === "cancelled" || run.status === "blocked") && preparedFor !== continuation;
}

export function bringsItsOwnPlan(result: Pick<ResearchView, "candidates" | "pendingWrite" | "questionnaire" | "directAction" | "proposalCandidateId"> | null | undefined): boolean {
  // A stated action ("deposit 5 XLM and supply 5 XLM to Blend") carries no candidate list: its plan is named by `proposalCandidateId`.
  return Boolean(result?.candidates?.feasible.length || result?.proposalCandidateId || result?.pendingWrite || result?.questionnaire || result?.directAction);
}

const STORAGE_PREFIX = "vanna.copilot.thread.";
const LIST_PREFIX = "vanna.copilot.conversations.";
/** On-screen chat that the server has not recorded yet - never sent as conversationId. */
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

/** First user prompt, cut to a line - same rule the server uses to title a conversation. */
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
  } catch { /* quota - the live thread still works */ }
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
  } catch { /* quota - the live thread still works until reload */ }
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
    /* quota - the live thread still works */
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
