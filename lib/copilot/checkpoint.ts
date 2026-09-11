import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Durable checkpoint for a money-moving run. Plain serializable state behind
 * this interface — never whatever investigation/runtime.ts holds in memory.
 *
 * Cloud SQL is the intended store (P3). Firestore is out. Until a Postgres
 * instance is provisioned, local encrypted files match the workflow journal.
 */

export interface ExecutionCheckpoint {
  workflowId: string;
  subject: string;
  status: string;
  digest: string;
  settledStepIds: string[];
  currentStepId: string | null;
  lastTxHash: string | null;
  updatedAt: number;
}

export interface CheckpointStore {
  load(workflowId: string): Promise<ExecutionCheckpoint | null>;
  save(checkpoint: ExecutionCheckpoint): Promise<void>;
}

export function checkpointFromJournal(input: {
  workflowId: string;
  subject: string;
  status: string;
  digest: string;
  steps: ReadonlyArray<{ id: string; status: string; txHash?: string }>;
  now?: number;
}): ExecutionCheckpoint {
  const settled = input.steps.filter((step) => step.status === "settled").map((step) => step.id);
  const current = input.steps.find((step) => !["settled", "failed"].includes(step.status)) ?? null;
  const lastHash = [...input.steps].reverse().find((step) => step.txHash)?.txHash ?? null;
  return {
    workflowId: input.workflowId,
    subject: input.subject,
    status: input.status,
    digest: input.digest,
    settledStepIds: settled,
    currentStepId: current?.id ?? null,
    lastTxHash: lastHash,
    updatedAt: input.now ?? Date.now(),
  };
}

export async function saveCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void> {
  try {
    const directory = resolve(process.cwd(), ".local", "copilot-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, `${checkpoint.workflowId}.json`),
      `${JSON.stringify(checkpoint)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    console.warn("[copilot] checkpoint save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

