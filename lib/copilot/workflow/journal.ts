import { createHash, randomUUID } from "node:crypto";
import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { RecordStore, Stored } from "./store";
import type { ProposalStep, WorkflowProposal, WorkflowRecord } from "./types";

/**
 * What a pre-broadcast check may conclude.
 *
 * `resize` exists because blocking between legs is NOT neutral: if leg one borrowed and
 * leg two supplies the proceeds, stopping leaves the user holding borrowed money that pays
 * interest and earns nothing — worse than completing at a smaller size. It is accepted only
 * for a step whose amount was DERIVED from a constraint, only downward, and only within the
 * bound recorded in the proposal the user approved.
 */
export type StepReadiness =
  | { kind: "ready" }
  | { kind: "resize"; amountUsd: string }
  | { kind: "stop"; reason: string };

import type { InvestigationScope } from "../investigation/types";
import { isRetryableRiskReason } from "./risk";
import { logUnexpected } from "../log";

export class WorkflowConflict extends Error {}
type Identity = { scope: InvestigationScope; server: string };
function bound(record: WorkflowRecord, identity: Identity) {
  const a = record.proposal.scope, b = identity.scope;
  if (a.subject !== b.subject || a.trader !== b.trader || a.smartAccount !== b.smartAccount ||
      a.network !== b.network || record.proposal.server !== identity.server) throw new Error("workflow_not_found");
}

/** Every write is conditional; neither a repeated POST nor another replica can claim a leg twice. */
export class WorkflowJournal {
  constructor(private readonly store: RecordStore<WorkflowRecord>, private readonly now = Date.now) {}
  async create(input: Omit<WorkflowProposal, "id" | "revision" | "digest" | "createdAt" | "expiresAt">) {
    if (!input.steps.length || input.steps.length > 8 || new Set(input.steps.map(s => s.id)).size !== input.steps.length)
      throw new Error("invalid_proposal_steps");
    /**
     * A proposal shown for approval must already be sized. `sizing.ts` resolves "max"
     * against the floor BEFORE anything reaches here, so a sentinel or a zero arriving at
     * this point means the resolution was skipped — and asking someone to approve a step
     * whose real amount is decided later is not informed consent.
     *
     * Bounded downstream sizing (leg two spending leg one's actual output) is the one case
     * the plan permits, and it needs a declared dependency and bound that `ProposalStep`
     * does not yet carry. Refused here rather than waved through as an unbounded "max".
     */
    if (input.steps.some(s => !/^\d+(\.\d+)?$/.test(s.amount) || Number(s.amount) <= 0))
      throw new Error("unsized_proposal_step");
    const proposal = { ...structuredClone(input), id: randomUUID(), revision: 1, createdAt: this.now(), expiresAt: this.now() + 300_000, digest: "" };
    proposal.digest = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
    const value: WorkflowRecord = { proposal, status: "proposed", updatedAt: this.now(), message: "Review the amounts and steps before approving.",
      steps: proposal.steps.map(s => ({ id: s.id, status: "pending" })) };
    if (!await this.store.write(proposal.id, null, value)) throw new WorkflowConflict("proposal_conflict");
    return value;
  }
  async read(id: string, identity: Identity): Promise<Stored<WorkflowRecord>> {
    const record = await this.store.read(id);
    if (!record) throw new Error("workflow_not_found");
    bound(record.value, identity);
    return record;
  }
  /**
   * Locate a record by the authenticated subject before scope is re-resolved.
   * The browser may not send a wallet on `/approve`; identity is recovered from the
   * stored proposal and then re-checked against a fresh scope resolution.
   */
  async lookup(id: string, subject: string): Promise<Stored<WorkflowRecord>> {
    const record = await this.store.read(id);
    if (!record || record.value.proposal.scope.subject !== subject) throw new Error("workflow_not_found");
    return record;
  }
  private async save(record: Stored<WorkflowRecord>) {
    record.value.updatedAt = this.now();
    if (!await this.store.write(record.value.proposal.id, record.version, record.value)) throw new WorkflowConflict("workflow_changed");
    return record.value;
  }
  async approve(id: string, identity: Identity, revision: number, digest: string,
    validate: (proposal: WorkflowProposal) => Promise<string | null>) {
    const record = await this.read(id, identity);
    const p = record.value.proposal;
    if (p.revision !== revision || p.digest !== digest) throw new WorkflowConflict("proposal_changed");
    if (record.value.status !== "proposed") throw new WorkflowConflict("approval_already_consumed");
    if (p.expiresAt <= this.now()) throw new WorkflowConflict("proposal_expired");
    record.value.status = "validating";
    await this.save(record);
    // Claim before external reads. A crash here requires a new proposal, never an implicit approval.
    let reason: string | null;
    try { reason = await validate(structuredClone(p)); }
    catch (error) {
      logUnexpected("workflow approval validation failed", { workflowId: id, error });
      reason = "Fresh validation was unavailable. Prepare a new proposal before approving.";
    }
    const current = await this.read(id, identity);
    if (current.value.status !== "validating") throw new WorkflowConflict("workflow_changed");
    if (p.expiresAt <= this.now()) reason = "The proposal expired during validation. Prepare a fresh proposal.";
    /**
     * A timeout or RPC miss is not a consumed approval. Returning to `proposed`
     * keeps Approve enabled so a flaky testnet read is not a dead card. Policy
     * refusals (funds, floor) still block — those will not pass on a retry of
     * the same amounts.
     */
    const retry = Boolean(reason && isRetryableRiskReason(reason));
    current.value.status = reason ? (retry ? "proposed" : "blocked") : "approved";
    current.value.message = reason ?? "Approved. Preparing the first step.";
    if (!reason) current.value.approvedAt = this.now();
    return this.save(current);
  }
  /**
   * Claim the next step, re-checking readiness immediately before it can be broadcast.
   *
   * Approval is not a standing licence: between approving a two-step plan and broadcasting
   * its second step, a price can move the health factor through the floor the user set. So
   * `ready` is consulted per step, not once at approval, and any reason it returns BLOCKS
   * the run instead of adjusting the amount to make it fit — silently re-sizing to squeeze
   * a transaction through is the failure mode this exists to prevent.
   *
   * Order matters. The step is claimed BEFORE the external read, so a crash mid-check
   * leaves it `invoking` and unclaimable rather than eligible for a second broadcast. When
   * the check refuses, the step returns to `pending` while the RUN goes `blocked`: nothing
   * was submitted, so calling it `failed` would misreport an on-chain failure, and the
   * blocked run still cannot be claimed again. Recovery is a fresh proposal.
   *
   * Deliberately NOT time-limited. `expiresAt` gates approval; reusing it here would
   * abandon a half-executed plan mid-flight because a wallet popup sat unanswered for six
   * minutes, and stranding an approved plan between legs is its own risk. Staleness is the
   * readiness check's job, where it can be judged against fresh evidence.
   */
  async claimNext(id: string, identity: Identity,
    ready?: (proposal: WorkflowProposal, step: ProposalStep) => Promise<StepReadiness>) {
    const record = await this.read(id, identity);
    if (!["approved", "running"].includes(record.value.status)) throw new WorkflowConflict("workflow_not_runnable");
    if (record.value.steps.some(s => !["pending", "settled"].includes(s.status))) throw new WorkflowConflict("step_already_claimed");
    const index = record.value.steps.findIndex(s => s.status === "pending");
    if (index < 0) throw new WorkflowConflict("no_pending_step");
    record.value.steps[index].status = "invoking";
    record.value.status = "running";
    record.value.message = `Preparing step ${index + 1}.`;
    await this.save(record);
    const step = structuredClone(record.value.proposal.steps[index]);
    if (!ready) return step;

    let verdict: StepReadiness;
    try { verdict = await ready(structuredClone(record.value.proposal), step); }
    catch { verdict = { kind: "stop", reason: "Your position could not be re-checked before this step. Nothing was submitted." }; }
    if (verdict.kind === "ready") return step;

    /**
     * A re-size is checked against the proposal, not trusted from the caller. Every refusal
     * here means the new amount is no longer the thing the user approved.
     */
    const reason = verdict.kind === "stop" ? verdict.reason
      : "The amount changed. Re-sizing would carry out a different instruction; prepare and approve a new proposal. Nothing was submitted.";

    const current = await this.read(id, identity);
    const claimed = current.value.steps.find(s => s.id === step.id);
    // Something else moved the step while the check ran; that owner reports its own state.
    if (!claimed || claimed.status !== "invoking") throw new WorkflowConflict("step_changed");
    claimed.status = "pending";
    current.value.status = "blocked";
    current.value.message = reason ?? "This step could not be prepared. Nothing was submitted.";
    await this.save(current);
    throw new WorkflowConflict("step_not_ready");
  }
  async invocationResult(id: string, identity: Identity, stepId: string,
    result: { kind: "submitted"; txHash: string } | { kind: "unsigned"; unsignedXdr: string }
      | { kind: "uncertain"; txHash?: string } | { kind: "failed"; message: string }) {
    const record = await this.read(id, identity);
    const step = record.value.steps.find(s => s.id === stepId);
    if (!step || step.status !== "invoking") throw new WorkflowConflict("step_changed");
    if (result.kind === "submitted") {
      if (!/^[a-f0-9]{64}$/i.test(result.txHash)) throw new Error("invalid_transaction_hash");
      step.status = "submitted"; step.txHash = result.txHash.toLowerCase();
      record.value.message = "Transaction submitted; waiting for ledger confirmation.";
    } else if (result.kind === "unsigned") {
      if (!result.unsignedXdr || result.unsignedXdr.length > 100_000) throw new Error("invalid_transaction_envelope");
      step.status = "awaiting_signature"; step.unsignedXdr = result.unsignedXdr;
      record.value.status = "awaiting_signature";
      record.value.message = "Approve the transaction in your wallet to continue.";
    } else if (result.kind === "failed") {
      // Simulation/policy failure: nothing reached the ledger, so this is not `uncertain`.
      step.status = "failed";
      step.message = result.message.slice(0, 500);
      record.value.status = "blocked";
      record.value.message = result.message.slice(0, 500);
    } else {
      // A malformed response can still carry the hash it was submitting. Keeping it is what
      // makes reconciliation possible later; without a reference the only honest options
      // are to leave the step stuck or to risk a duplicate transaction.
      if (result.txHash !== undefined) {
        if (!/^[a-f0-9]{64}$/i.test(result.txHash)) throw new Error("invalid_transaction_hash");
        step.txHash = result.txHash.toLowerCase();
      }
      step.status = "uncertain"; record.value.status = "uncertain";
      record.value.message = "The tool response could not be confirmed. This step will not be repeated automatically.";
    }
    return this.save(record);
  }
  /**
   * The wallet signed and submitted the envelope this step was waiting on.
   * The hash is recorded here; settlement still has to observe the ledger.
   */
  async acceptSubmittedHash(id: string, identity: Identity, stepId: string, txHash: string) {
    const record = await this.read(id, identity);
    const step = record.value.steps.find(s => s.id === stepId);
    if (!step || step.status !== "awaiting_signature") throw new WorkflowConflict("step_changed");
    if (!/^[a-f0-9]{64}$/i.test(txHash)) throw new Error("invalid_transaction_hash");
    if (!step.unsignedXdr || record.value.proposal.scope.network !== "testnet") throw new WorkflowConflict("transaction_mismatch");
    const expectedHash = TransactionBuilder.fromXDR(step.unsignedXdr, Networks.TESTNET).hash().toString("hex");
    if (expectedHash !== txHash.toLowerCase()) throw new WorkflowConflict("transaction_mismatch");
    step.status = "submitted";
    step.txHash = txHash.toLowerCase();
    delete step.unsignedXdr;
    record.value.status = "running";
    record.value.message = "Transaction submitted; waiting for ledger confirmation.";
    return this.save(record);
  }
  /** Persist the exact signed envelope and hash BEFORE network submission. */
  async acceptSignedEnvelope(id: string, identity: Identity, stepId: string, signedXdr: string) {
    const record = await this.read(id, identity);
    const step = record.value.steps.find(s => s.id === stepId);
    if (!step || step.status !== "awaiting_signature" || !step.unsignedXdr || signedXdr.length > 100_000)
      throw new WorkflowConflict("step_changed");
    if (identity.scope.network !== "testnet") throw new WorkflowConflict("transaction_mismatch");
    const unsigned = TransactionBuilder.fromXDR(step.unsignedXdr, Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    if (unsigned.hash().toString("hex") !== signed.hash().toString("hex") || !signed.signatures.length)
      throw new WorkflowConflict("transaction_mismatch");
    step.signedXdr = signedXdr; step.txHash = signed.hash().toString("hex");
    step.status = "submitted"; delete step.unsignedXdr;
    record.value.status = "running";
    record.value.message = "Submission recorded. Checking the transaction on chain.";
    return this.save(record);
  }
  async settled(id: string, identity: Identity, stepId: string, hash: string, ledger: number, success: boolean) {
    const record = await this.read(id, identity);
    const step = record.value.steps.find(s => s.id === stepId);
    if (!step || step.status !== "submitted" || step.txHash !== hash || !Number.isSafeInteger(ledger) || ledger <= 0)
      throw new WorkflowConflict("settlement_mismatch");
    step.status = success ? "settled" : "failed";
    step.settledLedger = ledger;
    record.value.status = !success ? "blocked" : record.value.steps.every(s => s.status === "settled") ? "completed" : "running";
    record.value.message = !success ? "The transaction failed on chain. Remaining steps were stopped."
      : record.value.status === "completed" ? "All approved transactions were confirmed on chain." : "Step confirmed. Remaining steps still require fresh validation.";
    return this.save(record);
  }
  /**
   * Resolve an uncertain step by looking up what actually happened on chain.
   *
   * The rule this enforces is "reconcile before retrying". An uncertain step is one whose
   * transaction MAY be in flight, so re-issuing it risks paying twice; the only safe way
   * out is to ask the ledger about the reference that was being submitted.
   *
   * Requires a recorded reference. With no hash there is nothing to look up, and inventing
   * a search over recent account activity would guess which transaction was ours —
   * `unreconcilable_without_reference` says so instead of guessing.
   *
   * `found: false` means the ledger has no such transaction, so nothing was spent and the
   * step returns to `pending` for the run to continue. Anything the lookup cannot answer
   * leaves the step uncertain: unchanged is the correct outcome of a failed reconciliation.
   */
  async reconcile(id: string, identity: Identity, stepId: string,
    lookup: (hash: string) => Promise<{ found: true; success: boolean; ledger: number } | { found: false }>) {
    const record = await this.read(id, identity);
    const step = record.value.steps.find(s => s.id === stepId);
    if (!step || step.status !== "uncertain") throw new WorkflowConflict("step_changed");
    if (!step.txHash) throw new WorkflowConflict("unreconcilable_without_reference");
    const outcome = await lookup(step.txHash);
    // NOT_FOUND also means propagation delay, RPC retention expiry, or an unavailable
    // index. It does not establish that a new transaction is safe to issue.
    if (!outcome.found) return record.value;
    if (outcome.found && (!Number.isSafeInteger(outcome.ledger) || outcome.ledger <= 0)) throw new Error("invalid_ledger");
    if (outcome.found) {
      step.status = outcome.success ? "settled" : "failed";
      step.settledLedger = outcome.ledger;
    } else {
      step.status = "pending";
      delete step.txHash;
    }
    const failed = record.value.steps.some(s => s.status === "failed");
    record.value.status = failed ? "blocked"
      : record.value.steps.every(s => s.status === "settled") ? "completed"
        : step.status === "pending" ? "approved" : "running";
    record.value.message = failed ? "The transaction failed on chain. Remaining steps were stopped."
      : record.value.status === "completed" ? "All approved transactions were confirmed on chain."
        : step.status === "pending" ? "No matching transaction reached the ledger, so this step can be attempted again."
          : "Step confirmed. Remaining steps still require fresh validation.";
    return this.save(record);
  }
  async cancel(id: string, identity: Identity) {
    const record = await this.read(id, identity);
    if (record.value.steps.some(s => ["invoking", "submitting", "submitted", "uncertain"].includes(s.status)))
      throw new WorkflowConflict("reconcile_inflight_step_first");
    if (["completed", "cancelled"].includes(record.value.status)) return record.value;
    record.value.status = "cancelled";
    record.value.message = "Remaining steps cancelled. Previously confirmed transactions remain in place.";
    return this.save(record);
  }
}
