/**
 * Subject-keyed conversation store: every conversation a signed-in user has had with the
 * copilot — its transcript, its last sealed evidence token and its last research view —
 * plus which one is open.
 *
 * ## Durable where it runs
 *
 * This rides the journal's store (`workflow/store.ts`): Firestore when the deployment
 * names a project, encrypted local files in development, and a hard failure in production
 * rather than a silent fall back to a container filesystem that a redeploy wipes and
 * sibling instances cannot see. It reuses `COPILOT_WORKFLOW_FIRESTORE_PROJECT`, so making
 * history durable is not a second deployment decision. Until 14 Sep this file wrote JSON
 * under `.local/`, which was honest when history was one invisible restore-on-reload and
 * wrong the moment the UI promised a list.
 *
 * ## Two collections, on purpose
 *
 * A conversation carries its turns AND the last `ResearchView`, which holds every fact and
 * candidate the card showed — tens of kilobytes. Thirty of those in one document would
 * pass Firestore's 1 MiB limit, so each conversation is its own document and a small index
 * per subject holds the summaries and the pointer to the open one.
 *
 * This is not an approval record. The sealed continuation inside a conversation may carry
 * evidence; it is never treated as a fingerprint to execute against.
 */

import { createHash, randomUUID } from "node:crypto";
import { copilotConfig } from "./config";
import { durableStore, HASH_ID, type RecordStore } from "./workflow/store";
import type { ThreadTurn } from "./investigation/thread";
import type { ResearchView } from "./investigation/view";
import type { ExecutionReceiptSnapshot } from "./execution-receipt";

/** How many conversations a subject keeps, newest first, and how many turns each keeps. */
export const CONVERSATION_LIMIT = 30;
export const TURN_LIMIT = 16;
/** What the list shows: the first prompt, cut to a line. */
const TITLE_LIMIT = 80;
/** A read-modify-write of the index loses to a concurrent turn; it retries rather than dropping one. */
const CAS_ATTEMPTS = 4;

export interface CopilotConversation {
  id: string;
  /** Whose it is. Read back and checked, so an id alone never opens someone else's conversation. */
  subject: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ThreadTurn[];
  continuation: string | null;
  result: ResearchView | null;
  /** Set when the conversation was deleted: the payload is overwritten, so the content is gone. */
  deleted?: true;
}

export type ConversationSummary = Pick<CopilotConversation, "id" | "title" | "createdAt" | "updatedAt">;

interface SubjectIndex {
  subject: string;
  conversations: ConversationSummary[];
  activeId: string | null;
  updatedAt: number;
}

function secret(): string {
  return process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
}

/** A subject is not a document id: it carries colons, and a file name cannot. */
function indexId(subject: string): string {
  return createHash("sha256").update(`copilot-conversations:${subject}`).digest("hex");
}

let indexStore: RecordStore<SubjectIndex> | null = null;
let conversationStore: RecordStore<CopilotConversation> | null = null;
function stores() {
  indexStore ??= durableStore<SubjectIndex>("copilot_conversation_index", ".local/copilot-conversation-index", secret(), HASH_ID);
  conversationStore ??= durableStore<CopilotConversation>("copilot_conversations", ".local/copilot-conversations", secret());
  return { index: indexStore, conversation: conversationStore };
}

/** Test seam: the stores cache their configuration, and a test changes it between cases. */
export function resetConversationStores(): void {
  indexStore = null;
  conversationStore = null;
}

function usable(subject: string): boolean {
  return Boolean(subject) && subject !== "guest";
}

export function titleFor(firstPrompt: string): string {
  const line = firstPrompt.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : line || "New chat";
}

function summarise(conversation: CopilotConversation): ConversationSummary {
  return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt };
}

/** Newest first — the order the list shows. */
function ordered(conversations: readonly ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readIndex(subject: string) {
  const stored = await stores().index.read(indexId(subject));
  // A record whose subject does not match is not this user's, whatever the id hashed to.
  if (!stored || stored.value.subject !== subject) return { version: null as string | null, value: null };
  return { version: stored.version, value: stored.value };
}

/**
 * Read the index, change it, write it back under the version it was read at. A concurrent
 * turn wins the write and this retries against what it wrote, so neither turn is lost.
 */
async function updateIndex(subject: string, change: (current: SubjectIndex | null) => SubjectIndex | null): Promise<boolean> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const { version, value } = await readIndex(subject);
    const next = change(value);
    if (!next) return false;
    if (await stores().index.write(indexId(subject), version, {
      ...next,
      conversations: ordered(next.conversations).slice(0, CONVERSATION_LIMIT),
    })) return true;
  }
  return false;
}

export async function listConversations(subject: string): Promise<{ conversations: ConversationSummary[]; activeId: string | null }> {
  if (!usable(subject)) return { conversations: [], activeId: null };
  const { value } = await readIndex(subject);
  if (!value) return { conversations: [], activeId: null };
  return { conversations: ordered(value.conversations), activeId: value.activeId };
}

/** One conversation, only for the subject that owns it. */
export async function readConversation(subject: string, id: string): Promise<CopilotConversation | null> {
  if (!usable(subject)) return null;
  let stored;
  try {
    stored = await stores().conversation.read(id);
  } catch {
    return null; // a malformed id is a miss, not a crash
  }
  if (!stored || stored.value.subject !== subject || stored.value.deleted) return null;
  return stored.value;
}

/** Opening a conversation also makes it the one a reload comes back to. */
export async function openConversation(subject: string, id: string): Promise<CopilotConversation | null> {
  const conversation = await readConversation(subject, id);
  if (!conversation) return null;
  await updateIndex(subject, (current) => {
    if (!current || !current.conversations.some((entry) => entry.id === id)) return null;
    return current.activeId === id ? null : { ...current, activeId: id, updatedAt: Date.now() };
  });
  return conversation;
}

/** "New chat": nothing is created until the first turn; the pointer just clears. */
export async function closeActiveConversation(subject: string): Promise<void> {
  if (!usable(subject)) return;
  await updateIndex(subject, (current) => (current?.activeId ? { ...current, activeId: null, updatedAt: Date.now() } : null));
}

/**
 * Delete a conversation: drop it from the index, then overwrite its document with a
 * tombstone so the encrypted payload no longer holds the transcript. The record store has
 * no delete verb — an overwrite is how content goes away, and Firestore keeps no prior
 * version of it.
 */
export async function deleteConversation(subject: string, id: string): Promise<boolean> {
  if (!usable(subject)) return false;
  const conversation = await readConversation(subject, id);
  let listed = false;
  await updateIndex(subject, (current) => {
    if (!current || !current.conversations.some((entry) => entry.id === id)) return null;
    listed = true;
    return {
      ...current,
      conversations: current.conversations.filter((entry) => entry.id !== id),
      activeId: current.activeId === id ? null : current.activeId,
      updatedAt: Date.now(),
    };
  });
  if (!listed && !conversation) return false;
  if (conversation) {
    const stored = await stores().conversation.read(id);
    if (stored) {
      await stores().conversation.write(id, stored.version, {
        id, subject, title: "", createdAt: conversation.createdAt, updatedAt: Date.now(),
        turns: [], continuation: null, result: null, deleted: true,
      });
    }
  }
  return true;
}

/**
 * Record one turn. With a `conversationId` the caller owns, the turn joins it; otherwise a
 * conversation is started, titled by this first prompt. Returns the id the turn went to so
 * the client can carry it on the next request.
 */
export async function appendSessionTurn(input: {
  subject: string;
  conversationId?: string | null;
  user: string;
  result: ResearchView;
  executionReceipt?: ExecutionReceiptSnapshot | null;
}): Promise<{ id: string }> {
  const now = Date.now();
  const fresh: CopilotConversation = {
    id: randomUUID(), subject: input.subject, title: titleFor(input.user),
    createdAt: now, updatedAt: now, turns: [], continuation: null, result: null,
  };
  if (!usable(input.subject)) return { id: fresh.id };

  const existing = input.conversationId ? await readConversation(input.subject, input.conversationId) : null;
  const target = existing ?? fresh;
  const version = existing ? (await stores().conversation.read(target.id))?.version ?? null : null;
  const updated: CopilotConversation = {
    ...target,
    turns: [
      ...target.turns,
      { role: "user" as const, text: input.user },
      {
        role: "assistant" as const,
        text: input.result.message,
        question: input.result.question ?? null,
        ...(input.executionReceipt !== undefined ? { executionReceipt: input.executionReceipt } : {}),
      },
    ].slice(-TURN_LIMIT),
    continuation: input.result.continuation || null,
    result: input.result,
    updatedAt: now,
  };
  await stores().conversation.write(target.id, version, updated);
  await updateIndex(input.subject, (current) => {
    const others = (current?.conversations ?? []).filter((entry) => entry.id !== updated.id);
    return {
      subject: input.subject,
      conversations: [summarise(updated), ...others],
      activeId: updated.id,
      updatedAt: now,
    };
  });
  return { id: updated.id };
}

function sameReceipt(a: ExecutionReceiptSnapshot, b: ExecutionReceiptSnapshot): boolean {
  if (a.workflowId !== b.workflowId || a.status !== b.status || a.network !== b.network || a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => {
    const other = b.steps[index];
    return step.operation === other.operation && step.asset === other.asset && step.amount === other.amount
      && step.status === other.status && (step.txHash ?? null) === (other.txHash ?? null)
      && (step.settledLedger ?? null) === (other.settledLedger ?? null);
  });
}

/**
 * Idempotently update the current assistant turn with a journal receipt.
 *
 * This is a compare-and-set update of the conversation document.  It is intentionally
 * independent of `text`, so a poll can move a step from submitted to settled without
 * parsing or appending a generated paragraph.  Only the latest assistant turn is eligible;
 * a late poll for an older workflow cannot overwrite a newer turn's receipt.
 */
export async function updateSessionExecutionReceipt(input: {
  subject: string;
  conversationId: string;
  receipt: ExecutionReceiptSnapshot;
}): Promise<boolean> {
  if (!usable(input.subject) || !input.conversationId || !input.receipt.workflowId) return false;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const stored = await stores().conversation.read(input.conversationId);
    if (!stored || stored.value.subject !== input.subject || stored.value.deleted) return false;
    const reversed = [...stored.value.turns].map((turn, i) => ({ turn, i })).reverse();
    // Once a workflow is attached, every later poll updates THAT turn even if a newer
    // conversation turn exists. This is the invariant that keeps a late ledger close from
    // putting an old receipt under the user's newest question.
    const matching = reversed.find(({ turn }) =>
      turn.role === "assistant" && turn.executionReceipt?.workflowId === input.receipt.workflowId);
    const index = matching?.i ?? reversed.find(({ turn }) =>
      turn.role === "assistant" && !turn.executionReceipt)?.i;
    if (index == null) return false;
    const current = stored.value.turns[index].executionReceipt;
    if (current && sameReceipt(current, input.receipt)) return true;
    const turns = [...stored.value.turns];
    turns[index] = { ...turns[index], executionReceipt: input.receipt };
    const updated: CopilotConversation = { ...stored.value, turns, updatedAt: Date.now() };
    if (!await stores().conversation.write(input.conversationId, stored.version, updated)) continue;
    await updateIndex(input.subject, (currentIndex) => {
      if (!currentIndex || !currentIndex.conversations.some((entry) => entry.id === input.conversationId)) return null;
      return {
        ...currentIndex,
        conversations: currentIndex.conversations.map((entry) => entry.id === input.conversationId
          ? { ...entry, updatedAt: updated.updatedAt }
          : entry),
        updatedAt: updated.updatedAt,
      };
    });
    return true;
  }
  return false;
}

/** Short alias for callers that think of this operation as an upsert. */
export const upsertSessionExecutionReceipt = updateSessionExecutionReceipt;
