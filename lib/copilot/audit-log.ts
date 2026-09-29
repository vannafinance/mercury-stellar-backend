/**
 * Append-only audit of agent actions against a verified identity.
 *
 * Answers "your agent can move money — show me what it did": proposed, approved,
 * executed, under which mandate and cap, with the evidence IDs behind the numbers.
 * Never logs tokens, XDR, or secrets.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

/**
 * Where the audit rows go. `COPILOT_AUDIT_DIR` wins when set. Under vitest (which sets
 * `VITEST` itself) the default is a temp folder, so test runs stop appending rows to the
 * real `.local/copilot-audit` a developer reads (23 Sep: 8 test "proposed" rows landed in
 * the day's log beside real runs). Normal runs are unchanged.
 */
function directory(): string {
  if (process.env.COPILOT_AUDIT_DIR) return resolve(process.env.COPILOT_AUDIT_DIR);
  if (process.env.VITEST) return join(tmpdir(), "vanna-copilot-audit-test");
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
