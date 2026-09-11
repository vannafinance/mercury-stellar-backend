/**
 * Subject-keyed conversation session: transcript + last sealed evidence token.
 *
 * Cloud SQL is the intended store (P3). Until a Postgres instance is provisioned,
 * local files match checkpoints and the workflow journal. Firestore is out.
 *
 * This is not an approval record. The sealed continuation inside `continuation`
 * may carry evidence; it is never treated as a fingerprint to execute against.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThreadTurn } from "./investigation/thread";
import type { ResearchView } from "./investigation/view";

export interface CopilotSession {
  subject: string;
  turns: ThreadTurn[];
  continuation: string | null;
  result: ResearchView | null;
  updatedAt: number;
}

export interface SessionStore {
  load(subject: string): Promise<CopilotSession | null>;
  save(session: CopilotSession): Promise<void>;
  clear(subject: string): Promise<void>;
}

function directory(): string {
  return resolve(process.cwd(), ".local", "copilot-sessions");
}

function fileFor(subject: string): string {
  const key = subject.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
  return join(directory(), `${key}.json`);
}

export async function loadSession(subject: string): Promise<CopilotSession | null> {
  if (!subject || subject === "guest") return null;
  try {
    const raw = await readFile(fileFor(subject), "utf8");
    const parsed = JSON.parse(raw) as CopilotSession;
    if (!parsed || parsed.subject !== subject || !Array.isArray(parsed.turns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(session: CopilotSession): Promise<void> {
  if (!session.subject || session.subject === "guest") return;
  try {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const value: CopilotSession = {
      subject: session.subject.slice(0, 128),
      turns: session.turns.slice(-16),
      continuation: session.continuation,
      result: session.result,
      updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now(),
    };
    await writeFile(fileFor(session.subject), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn("[copilot] session save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function appendSessionTurn(input: {
  subject: string;
  user: string;
  result: ResearchView;
}): Promise<void> {
  const existing = await loadSession(input.subject);
  const turns: ThreadTurn[] = [
    ...(existing?.turns ?? []),
    { role: "user" as const, text: input.user },
    { role: "assistant" as const, text: input.result.message, question: input.result.question ?? null },
  ].slice(-16);
  await saveSession({
    subject: input.subject,
    turns,
    continuation: input.result.continuation || null,
    result: input.result,
    updatedAt: Date.now(),
  });
}
