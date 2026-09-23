/**
 * Build the durable execution receipt for a run.
 *
 * This lived inline inside `copilot-workspace.tsx`, which is why the bug below shipped
 * untested: a 6000-line component gives a receipt builder nowhere to be exercised from.
 * It is a pure function here so the two-leg case has a test.
 *
 * The defect it fixes: the steps were built from `action` — the single write that had just
 * been signed — so on a multi-leg run every settled leg overwrote the previous one with a
 * fresh one-element array. Live, 22 Sep, "deposit 100 XLM, borrow 20 BLUSDC and supply it
 * to blend": all three legs settled on-chain and the finished card showed only the deposit.
 *
 * The receipt was also keyed by `request_id`, which is per REQUEST while a multi-leg run is
 * many requests. Each leg therefore wrote under a new key, failed to find the turn the
 * previous leg had written, and fell through to "first assistant turn with no receipt" — so
 * the run's receipt could land on an earlier turn than the run it described. `runId` is the
 * caller's one id for the whole run, which is what stops that.
 */
import type { ExecutionReceiptSnapshot, ExecutionReceiptStep } from "@/lib/copilot/execution-receipt";
import type { StepStatus } from "@/lib/copilot/workflow/types";
import { toRunLegStatus } from "./run-execution-card";

/** The shape the workspace already holds a leg in. Structural, so the caller's type fits. */
export type RunReceiptLeg = {
  op?: string;
  asset?: string | null;
  amount?: number | null;
  status?: string;
  tx_hash?: string | null;
  token_b?: string | null;
};

/**
 * Restate one internal status vocabulary in the other.
 *
 * Not a reading of server wording — `toRunLegStatus` already owns that, and is reused here
 * so a status this file has never seen is still interpreted the one way the run card
 * interprets it. Keeping a second opinion here is what would let the card and the receipt
 * disagree about the same leg.
 */
export function receiptStepStatus(leg: RunReceiptLeg): StepStatus {
  switch (toRunLegStatus(leg.status)) {
    case "ok":
      return "settled";
    case "failed":
    case "stopped":
      return "failed";
    case "needs_sign":
      return "awaiting_signature";
    case "running":
      return "submitting";
    default:
      return "pending";
  }
}

export function buildRunReceipt(input: {
  /** Every leg of the run. Empty or not-a-run falls back to the single write. */
  legs: readonly RunReceiptLeg[];
  /** Whether this is genuinely a multi-leg run — the caller passes the same predicate the run card is gated on. */
  isRun: boolean;
  /** One id for the whole run. Null for a single write, which then keys on the request. */
  runId: string | null;
  requestId?: string | null;
  network: string;
  /** The single write just signed — the fallback when this is not a run. */
  single: { op?: string | null; asset?: string | null; amount?: unknown; token_b?: string | null } | null;
  txHash: string;
}): ExecutionReceiptSnapshot {
  const { legs, isRun, runId, requestId, network, single, txHash } = input;
  const steps: ExecutionReceiptStep[] =
    isRun && legs.length
      ? legs.map((leg) => ({
          operation: (leg.op as ExecutionReceiptStep["operation"]) ?? "submit",
          asset: String(leg.asset ?? leg.token_b ?? ""),
          amount: String(leg.amount ?? ""),
          status: receiptStepStatus(leg),
          txHash: leg.tx_hash ?? null,
        }))
      : [
          {
            operation: (single?.op as ExecutionReceiptStep["operation"]) ?? "submit",
            asset: String(single?.asset ?? single?.token_b ?? ""),
            amount: String(single?.amount ?? ""),
            status: "settled",
            txHash,
          },
        ];
  return {
    workflowId: (isRun ? runId : null) || requestId || `tx-${txHash.slice(0, 8)}`,
    status: "completed",
    network,
    steps,
  };
}
