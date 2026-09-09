import type { InvestigationScope } from "../investigation/types";

export type WorkflowOp = "lend" | "deposit_collateral" | "borrow" | "repay" | "supply_blend";
/**
 * Where a step's amount came from, which decides whether it may be re-derived later.
 *
 * `stated` — the amount WAS the instruction ("borrow 500 USDC"). If it no longer fits, the
 * honest response is to stop: shrinking 500 to 430 answers a different question.
 *
 * `derived_max_at_floor` — the amount came from a constraint ("borrow the max that keeps HF
 * at or above 1.3"). The figure was never the user's number, so executing a stale one is
 * LESS faithful than re-deriving it at broadcast time. Re-derivation is bounded by
 * `minAmountUsd`: without a floor on it the user's health-factor constraint would quietly
 * stop being a stop condition and become a slider, since some amount always fits.
 */
export type StepSizing =
  | { basis: "stated" }
  | { basis: "derived_max_at_floor"; minAmountUsd: string };

export interface ProposalStep {
  id: string;
  op: WorkflowOp;
  asset: string;
  amount: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** Absent means `stated`: never re-derive an amount whose origin was not recorded. */
  sizing?: StepSizing;
}
export interface WorkflowProposal {
  id: string;
  revision: number;
  digest: string;
  scope: InvestigationScope;
  server: string;
  createdAt: number;
  expiresAt: number;
  objective: string;
  messages: string[];
  assumptions: string[];
  constraints: string[];
  floor: string | null;
  steps: ProposalStep[];
}
export type StepStatus = "pending" | "invoking" | "awaiting_signature" | "submitting" | "submitted" | "settled" | "failed" | "uncertain";
export interface WorkflowStepState {
  id: string;
  status: StepStatus;
  /**
   * What was actually sent, when re-derivation changed it. The proposal itself stays frozen
   * — its digest is what the user approved — so a deviation is recorded here beside it
   * rather than by editing the approved artifact.
   */
  executedAmountUsd?: string;
  txHash?: string;
  unsignedXdr?: string;
  signedXdr?: string;
  message?: string;
  settledLedger?: number;
}
export interface WorkflowRecord {
  proposal: WorkflowProposal;
  status: "proposed" | "validating" | "approved" | "running" | "awaiting_signature" | "completed" | "blocked" | "cancelled" | "uncertain";
  approvedAt?: number;
  updatedAt: number;
  message: string;
  steps: WorkflowStepState[];
}
/** No tool arguments or signing authority may be supplied back by the browser. */
export interface WorkflowView {
  id: string;
  revision: number;
  digest: string;
  status: WorkflowRecord["status"];
  objective: string;
  expiresAt: number;
  assumptions: string[];
  constraints: string[];
  message: string;
  steps: Array<Pick<ProposalStep, "id" | "op" | "asset" | "amount" | "label" | "sizing"> & WorkflowStepState>;
}
export function workflowView(record: WorkflowRecord): WorkflowView {
  const p = record.proposal;
  return { id: p.id, revision: p.revision, digest: p.digest, status: record.status, objective: p.objective,
    expiresAt: p.expiresAt, assumptions: p.assumptions, constraints: p.constraints, message: record.message,
    steps: p.steps.map((step, index) => {
      const state = record.steps[index];
      return { id: step.id, op: step.op, asset: step.asset, amount: step.amount, label: step.label,
        sizing: step.sizing,
        status: state.status, txHash: state.txHash, unsignedXdr: state.unsignedXdr,
        message: state.message, settledLedger: state.settledLedger,
        executedAmountUsd: state.executedAmountUsd };
    }),
  };
}
