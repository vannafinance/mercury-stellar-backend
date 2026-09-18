/**
 * Instant closing receipt for a finished (or HF-paused) multi-leg run.
 *
 * The Response card used to wait on `vertexSummarizeExecution` after the last
 * hop already settled — often several seconds of "STRATEGY" + "Approved plan"
 * with the money already on chain. Facts here are counted from the legs, so the
 * card can paint the moment the ledger answers; Vertex may later replace the
 * headline, never the counts.
 */

import type { FactTone, StructuredAnswer } from "./answer-schema";
import { farmReceiptLine } from "./execution-copy";
import type { StepStatus, WorkflowOp, WorkflowRecord, WorkflowView } from "./workflow/types";

export type ReceiptLeg = {
  label?: string | null;
  action?: string | null;
  status?: string | null;
  tx_hash?: string | null;
};

const SETTLED = new Set(["ok", "done", "signed_and_submitted"]);
const FAILED = new Set(["error", "blocked", "stopped", "stopped_hf", "preflight_blocked"]);

export function localExecutionAnswer(opts: {
  intent?: string | null;
  legs: ReadonlyArray<ReceiptLeg>;
  hf?: number | null;
  floor?: number | null;
  pausedHf?: boolean;
}): StructuredAnswer {
  const legs = opts.legs;
  const n = legs.length;
  const settled = legs.filter((l) => SETTLED.has(String(l.status ?? ""))).length;
  const onChain = legs.filter((l) => l.tx_hash && String(l.tx_hash).length > 0).length;
  const failed = legs.filter((l) => FAILED.has(String(l.status ?? ""))).length;
  const labels = legs
    .map((l) => String(l.label || l.action || "").trim())
    .filter(Boolean);

  const farmLine = farmReceiptLine(opts.intent, labels.join(" | "));
  const headline = opts.pausedHf
    ? `Paused — health factor below your floor${opts.floor != null ? ` of ${Number(opts.floor).toFixed(2)}` : ""}.`
    : farmLine ||
      (settled === n && n > 0
        ? `All ${n} step${n === 1 ? "" : "s"} completed on-chain.`
        : settled > 0
          ? `${settled} of ${n} steps settled on-chain.`
          : "No steps completed.");

  const facts: StructuredAnswer["facts"] = [
    {
      label: "steps settled",
      value: `${settled} of ${n || 0}`,
      tone: (settled === n && n > 0 ? "good" : failed > 0 ? "bad" : "warn") as FactTone,
    },
  ];
  if (onChain > 0) {
    facts.push({ label: "transactions", value: String(onChain), tone: "neutral" });
  }
  const hf = Number(opts.hf);
  if (Number.isFinite(hf) && hf > 0) {
    const floor = Number(opts.floor);
    facts.push({
      label: "health factor",
      value: hf >= 999 ? "∞" : hf.toFixed(2),
      tone: hf < 1.1 ? "bad" : Number.isFinite(floor) && hf < floor ? "warn" : "good",
    });
  }

  return {
    headline,
    facts,
    note: opts.pausedHf
      ? "Earlier legs are already on-chain. Continue the remaining collateral/debt steps, or stop here."
      : undefined,
    venue: "none",
  };
}

/** A durable, machine-readable workflow receipt; never reconstructed from prose. */
export type ExecutionReceiptStep = {
  operation: WorkflowOp;
  asset: string;
  amount: string;
  status: StepStatus;
  txHash?: string | null;
  settledLedger?: number | null;
};

export type ExecutionReceiptSnapshot = {
  workflowId: string;
  status: WorkflowRecord["status"];
  network: string;
  steps: ExecutionReceiptStep[];
};

/** Convert a browser-safe workflow view to the durable receipt shape. */
export function executionReceiptFromWorkflowView(
  view: WorkflowView,
  network: string,
): ExecutionReceiptSnapshot {
  return {
    workflowId: view.id,
    status: view.status,
    network,
    steps: view.steps.map((step) => ({
      operation: step.op,
      asset: step.asset,
      amount: step.amount,
      status: step.status,
      ...(step.txHash ? { txHash: step.txHash } : {}),
      ...(step.settledLedger != null ? { settledLedger: step.settledLedger } : {}),
    })),
  };
}
