/**
 * Append-only audit of agent actions against a verified identity.
 *
 * Answers "your agent can move money — show me what it did": proposed, approved,
 * executed, under which mandate and cap, with the evidence IDs behind the numbers.
 * Never logs tokens, XDR, or secrets.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type AuditAction = "proposed" | "approved" | "executed" | "blocked" | "cancelled";

export interface AuditEvent {
  at: number;
  subject: string;
  action: AuditAction;
  workflowId: string;
  digest?: string;
  stepId?: string;
  txHash?: string;
  evidenceIds?: string[];
  floor?: string | null;
  capUsd?: { perTx?: string; perDay?: string };
  reason?: string;
}

function directory(): string {
  return resolve(process.cwd(), ".local", "copilot-audit");
}

export async function appendAudit(event: AuditEvent): Promise<void> {
  const row = {
    ...event,
    at: Number.isFinite(event.at) ? event.at : Date.now(),
    subject: event.subject.slice(0, 128),
    workflowId: event.workflowId.slice(0, 64),
    ...(event.txHash ? { txHash: event.txHash.toLowerCase().slice(0, 64) } : {}),
    ...(event.reason ? { reason: event.reason.slice(0, 400) } : {}),
  };
  try {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const day = new Date(row.at).toISOString().slice(0, 10);
    await appendFile(join(directory(), `${day}.jsonl`), `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn("[copilot] audit append failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
