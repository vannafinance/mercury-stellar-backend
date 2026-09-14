/**
 * Subject-keyed conversation store: every conversation a signed-in user has had with the
 * copilot on this host — its transcript, its last sealed evidence token and its last
 * research view — plus which one is open.
 *
 * Cloud SQL is the intended store (P3). Until a Postgres instance is provisioned,
 * local files match checkpoints and the workflow journal. Firestore is out.
 *
 * This is not an approval record. The sealed continuation inside a conversation may carry
 * evidence; it is never treated as a fingerprint to execute against.
 *
 * Until 14 Sep the file held ONE thread; a new prompt after "Start over" overwrote the
 * last one. A file in that shape is read as a single conversation, so nothing is lost.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThreadTurn } from "./investigation/thread";
import type { ResearchView } from "./investigation/view";

/** How many conversations a subject keeps, newest first, and how many turns each keeps. */
export const CONVERSATION_LIMIT = 30;
export const TURN_LIMIT = 16;
/** What the list shows: the first prompt, cut to a line. */
const TITLE_LIMIT = 80;

export interface CopilotConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ThreadTurn[];
  continuation: string | null;
  result: ResearchView | null;
}

export type ConversationSummary = Pick<CopilotConversation, "id" | "title" | "createdAt" | "updatedAt">;

export interface CopilotSession {
  subject: string;
  conversations: CopilotConversation[];
  activeId: string | null;
  updatedAt: number;
}

function directory(): string {
  return resolve(process.cwd(), ".local", "copilot-sessions");
}

function fileFor(subject: string): string {
  const key = subject.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
  return join(directory(), `${key}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function titleFor(firstPrompt: string): string {
  const line = firstPrompt.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : line || "New chat";
}

function conversationFrom(value: unknown): CopilotConversation | null {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.turns)) return null;
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title ? value.title : titleFor(String(value.turns.find((t) => isRecord(t) && t.role === "user")?.text ?? "")),
    createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0,
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : 0,
    turns: value.turns as ThreadTurn[],
    continuation: typeof value.continuation === "string" ? value.continuation : null,
    result: isRecord(value.result) ? value.result as unknown as ResearchView : null,
  };
}

/** A file written before conversations existed: one thread, no id. */
function migrateLegacy(parsed: Record<string, unknown>): CopilotSession | null {
  if (!Array.isArray(parsed.turns)) return null;
  const updatedAt = Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : Date.now();
  const turns = parsed.turns as ThreadTurn[];
  const first = turns.find((t) => t.role === "user")?.text ?? "";
  const conversations: CopilotConversation[] = turns.length ? [{
    id: randomUUID(), title: titleFor(first), createdAt: updatedAt, updatedAt, turns,
    continuation: typeof parsed.continuation === "string" ? parsed.continuation : null,
    result: isRecord(parsed.result) ? parsed.result as unknown as ResearchView : null,
  }] : [];
  return { subject: String(parsed.subject), conversations, activeId: conversations[0]?.id ?? null, updatedAt };
}

export async function loadSession(subject: string): Promise<CopilotSession | null> {
  if (!subject || subject === "guest") return null;
  try {
    const raw = await readFile(fileFor(subject), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.subject !== subject) return null;
    if (!Array.isArray(parsed.conversations)) return migrateLegacy(parsed);
    const conversations = parsed.conversations.map(conversationFrom).filter((c): c is CopilotConversation => c !== null);
    const activeId = typeof parsed.activeId === "string" && conversations.some((c) => c.id === parsed.activeId) ? parsed.activeId : null;
    return { subject, conversations, activeId, updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : Date.now() };
  } catch {
    return null;
  }
}

export async function saveSession(session: CopilotSession): Promise<void> {
  if (!session.subject || session.subject === "guest") return;
  try {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const conversations = [...session.conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, CONVERSATION_LIMIT)
      .map((c) => ({ ...c, turns: c.turns.slice(-TURN_LIMIT) }));
    const value: CopilotSession = {
      subject: session.subject.slice(0, 128),
      conversations,
      activeId: conversations.some((c) => c.id === session.activeId) ? session.activeId : null,
      updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now(),
    };
    await writeFile(fileFor(session.subject), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn("[copilot] session save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The open conversation, if any. */
export function activeConversation(session: CopilotSession | null): CopilotConversation | null {
  if (!session?.activeId) return null;
  return session.conversations.find((c) => c.id === session.activeId) ?? null;
}

export function summarise(conversation: CopilotConversation): ConversationSummary {
  return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt };
}

/** Newest first — the order the list shows. */
export async function listConversations(subject: string): Promise<{ conversations: ConversationSummary[]; activeId: string | null }> {
  const session = await loadSession(subject);
  if (!session) return { conversations: [], activeId: null };
  return {
    conversations: [...session.conversations].sort((a, b) => b.updatedAt - a.updatedAt).map(summarise),
    activeId: session.activeId,
  };
}

/** Opening a conversation also makes it the one a reload comes back to. */
export async function openConversation(subject: string, id: string): Promise<CopilotConversation | null> {
  const session = await loadSession(subject);
  const found = session?.conversations.find((c) => c.id === id) ?? null;
  if (!session || !found) return null;
  if (session.activeId !== id) await saveSession({ ...session, activeId: id });
  return found;
}

/** "New chat": nothing is created until the first turn; the pointer just clears. */
export async function closeActiveConversation(subject: string): Promise<void> {
  const session = await loadSession(subject);
  if (session?.activeId) await saveSession({ ...session, activeId: null });
}

export async function deleteConversation(subject: string, id: string): Promise<boolean> {
  const session = await loadSession(subject);
  if (!session || !session.conversations.some((c) => c.id === id)) return false;
  await saveSession({
    ...session,
    conversations: session.conversations.filter((c) => c.id !== id),
    activeId: session.activeId === id ? null : session.activeId,
    updatedAt: Date.now(),
  });
  return true;
}

/**
 * Record one turn. With a `conversationId` that exists, the turn joins it; otherwise a
 * conversation is started, titled by this first prompt. Returns the id the turn went to
 * so the client can carry it on the next request.
 */
export async function appendSessionTurn(input: {
  subject: string;
  conversationId?: string | null;
  user: string;
  result: ResearchView;
}): Promise<{ id: string }> {
  const now = Date.now();
  const session = (await loadSession(input.subject)) ?? { subject: input.subject, conversations: [], activeId: null, updatedAt: now };
  const existing = input.conversationId ? session.conversations.find((c) => c.id === input.conversationId) ?? null : null;
  const target: CopilotConversation = existing ?? {
    id: randomUUID(), title: titleFor(input.user), createdAt: now, updatedAt: now, turns: [], continuation: null, result: null,
  };
  target.turns = [
    ...target.turns,
    { role: "user" as const, text: input.user },
    { role: "assistant" as const, text: input.result.message, question: input.result.question ?? null },
  ].slice(-TURN_LIMIT);
  target.continuation = input.result.continuation || null;
  target.result = input.result;
  target.updatedAt = now;
  await saveSession({
    subject: input.subject,
    conversations: existing ? session.conversations : [target, ...session.conversations],
    activeId: target.id,
    updatedAt: now,
  });
  return { id: target.id };
}
