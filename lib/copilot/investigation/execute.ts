/**
 * Drive an approved journal proposal through MCP writes, one claimed step at a time.
 *
 * The browser never supplies tools, amounts or envelopes. It may send a transaction
 * hash after it signed the unsigned XDR this module already recorded.
 */

import type { MCPClient } from "../mcp-client";
import { allowedInvocation } from "../workflow/allowlist";
import { isRecord } from "./decision";
import { interruptible } from "./runtime";
import { WorkflowConflict, type StepReadiness } from "../workflow/journal";
import { workflowView, type WorkflowProposal, type WorkflowView, type ProposalStep } from "../workflow/types";
import { getMcpClient } from "../mcp-client";
import { validateWorkflowRisk } from "../workflow/risk";
import { ResearchError, resolveInvestigationScope } from "./scope";
import { workflowJournal } from "./proposal";

const WRITE_TOOLS = new Set([
  "vanna_deposit_collateral", "vanna_borrow", "vanna_repay", "vanna_blend_supply", "vanna_lend",
]);

export type LedgerLookup = (hash: string) => Promise<
  { found: true; success: boolean; ledger: number } | { found: false }
>;

function identityOf(proposal: WorkflowProposal) {
  return { scope: proposal.scope, server: proposal.server };
}

function hashOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

export async function readyForStep(proposal: WorkflowProposal, step: ProposalStep): Promise<StepReadiness> {
  const reason = await validateWorkflowRisk({ ...proposal, steps: [step] }, getMcpClient(), AbortSignal.timeout(25_000));
  return reason ? { kind: "stop", reason } : { kind: "ready" };
}

export async function lookupTransaction(hash: string): Promise<{ found: true; success: boolean; ledger: number } | { found: false }> {
  try {
    const [StellarSdk, { SOROBAN_RPC_URL }] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("@/lib/stellar-utils"),
    ]);
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const tx = await interruptible(() => server.getTransaction(hash), AbortSignal.timeout(10_000));
    if (tx.status !== "SUCCESS" && tx.status !== "FAILED") return { found: false };
    const ledger = Number(tx.ledger);
    if (!Number.isSafeInteger(ledger) || ledger <= 0) return { found: false };
    return { found: true, success: tx.status === "SUCCESS", ledger };
  } catch { /* RPC unavailable — leave the step submitted */ }
  return { found: false };
}

async function settleSubmitted(
  journal: ReturnType<typeof workflowJournal>,
  id: string,
  identity: { scope: WorkflowProposal["scope"]; server: string },
  lookup: LedgerLookup,
) {
  const stored = await journal.read(id, identity);
  const step = stored.value.steps.find((entry) => entry.status === "submitted" && entry.txHash);
  if (!step?.txHash) return stored.value;
  const outcome = await lookup(step.txHash);
  if (!outcome.found) return stored.value;
  return journal.settled(id, identity, step.id, step.txHash, outcome.ledger, outcome.success);
}

export async function advanceWorkflow(input: {
  id: string;
  subject: string;
  secret: string;
  server: string;
  network: string;
  mcp: Pick<MCPClient, "call">;
  signal: AbortSignal;
  ready?: typeof readyForStep;
  lookupTx?: LedgerLookup;
}): Promise<WorkflowView> {
  const journal = workflowJournal(input.secret);
  const stored = await journal.lookup(input.id, input.subject);
  const expected = stored.value.proposal.scope;
  if (stored.value.proposal.server !== input.server || expected.network !== input.network)
    throw new ResearchError("context_expired", "The execution environment changed. Prepare a new proposal.");
  const scope = await resolveInvestigationScope({
    subject: input.subject, wallet: expected.trader, network: input.network,
  }, input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  if (scope.subject !== expected.subject || scope.trader !== expected.trader ||
    scope.smartAccount !== expected.smartAccount || scope.network !== expected.network) {
    throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
  }
  const identity = identityOf(stored.value.proposal);
  const lookup = input.lookupTx ?? lookupTransaction;
  let record = await settleSubmitted(journal, input.id, identity, lookup);
  if (record.steps.some(s => ["submitted", "invoking", "submitting"].includes(s.status))) return workflowView(record);
  if (["completed", "blocked", "cancelled", "uncertain", "awaiting_signature"].includes(record.status)) {
    return workflowView(record);
  }
  if (!["approved", "running"].includes(record.status)) {
    return workflowView(record);
  }

  let step: ProposalStep;
  try {
    step = await journal.claimNext(input.id, identity, input.ready ?? readyForStep);
  } catch (error) {
    if (error instanceof WorkflowConflict && error.message === "no_pending_step") {
      return workflowView((await journal.read(input.id, identity)).value);
    }
    if (error instanceof WorkflowConflict) {
      throw new ResearchError(error.message, journalMessage(error.message), 409);
    }
    throw error;
  }

  if (!WRITE_TOOLS.has(step.tool) || !scope.trader || (step.tool !== "vanna_lend" && !scope.smartAccount)) {
    record = await journal.invocationResult(input.id, identity, step.id, {
      kind: "failed", message: "This step is not an allowed write for the connected account. Nothing was submitted.",
    });
    return workflowView(record);
  }

  let invocation: ReturnType<typeof allowedInvocation>;
  try { invocation = allowedInvocation(step, scope); }
  catch {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, {
      kind: "failed", message: "The protocol operation did not match the approved arguments. Nothing was submitted.",
    }));
  }
  let build: Record<string, unknown>;
  try {
    const raw = await interruptible(() => input.mcp.call(invocation.tool, invocation.args, scope.trader!),
      AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]));
    if (!isRecord(raw)) throw new Error("invalid_write_result");
    build = raw;
  } catch {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" }));
  }
  const hash = hashOf(build.tx_hash);
  const unsigned = typeof build.unsigned_xdr === "string" ? build.unsigned_xdr : null;
  const result = { status: hash ? "signed_and_submitted" : unsigned && !build.error ? "needs_wallet_sign" : "error", build,
    submitted: null, unsigned_xdr: unsigned };

  if (result.status === "signed_and_submitted") {
    const txHash = hash;
    if (!txHash) {
      record = await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" });
      return workflowView(record);
    }
    record = await journal.invocationResult(input.id, identity, step.id, { kind: "submitted", txHash });
    record = await settleSubmitted(journal, input.id, identity, lookup);
    return workflowView(record);
  }

  if (result.status === "needs_wallet_sign" && result.unsigned_xdr) {
    record = await journal.invocationResult(input.id, identity, step.id, {
      kind: "unsigned", unsignedXdr: result.unsigned_xdr,
    });
    return workflowView(record);
  }

  // A returned error can occur after broadcasting. Without a transaction reference
  // or a proven pre-broadcast rejection, don't claim that nothing was submitted.
  record = await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" });
  return workflowView(record);
}

export async function confirmWorkflow(input: {
  id: string;
  txHash: string;
  subject: string;
  secret: string;
  server: string;
  network: string;
  mcp: Pick<MCPClient, "call">;
  signal: AbortSignal;
  lookupTx?: LedgerLookup;
}): Promise<WorkflowView> {
  const txHash = hashOf(input.txHash);
  if (!txHash) throw new ResearchError("invalid_request", "Send the submitted transaction hash only.", 400);
  const journal = workflowJournal(input.secret);
  const stored = await journal.lookup(input.id, input.subject);
  const expected = stored.value.proposal.scope;
  if (stored.value.proposal.server !== input.server || expected.network !== input.network)
    throw new ResearchError("context_expired", "The execution environment changed. Prepare a new proposal.");
  const scope = await resolveInvestigationScope({
    subject: input.subject, wallet: expected.trader, network: input.network,
  }, input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  if (scope.subject !== expected.subject || scope.trader !== expected.trader ||
    scope.smartAccount !== expected.smartAccount || scope.network !== expected.network) {
    throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
  }
  const identity = identityOf(stored.value.proposal);
  const waiting = stored.value.steps.find((step) => step.status === "awaiting_signature");
  if (!waiting) {
    throw new ResearchError("step_changed", "This plan is not waiting for a wallet signature.", 409);
  }
  let record = await journal.acceptSubmittedHash(input.id, identity, waiting.id, txHash);
  record = await settleSubmitted(journal, input.id, identity, input.lookupTx ?? lookupTransaction);
  return workflowView(record);
}

export async function submitWorkflow(input: {
  id: string; signedXdr: string; subject: string; secret: string; server: string; network: string;
  mcp: Pick<MCPClient, "call">; signal: AbortSignal;
}): Promise<WorkflowView> {
  const journal = workflowJournal(input.secret);
  const stored = await journal.lookup(input.id, input.subject);
  const expected = stored.value.proposal;
  if (expected.server !== input.server || expected.scope.network !== input.network) throw new ResearchError("context_expired", "The execution environment changed.");
  const scope = await resolveInvestigationScope({ subject: input.subject, wallet: expected.scope.trader, network: input.network }, input.mcp,
    AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  const identity = { scope, server: input.server };
  const checked = await journal.read(input.id, identity);
  const waiting = checked.value.steps.find(s => s.status === "awaiting_signature");
  const step = expected.steps.find(s => s.id === waiting?.id);
  if (!waiting || !step) throw new ResearchError("step_changed", "This plan is not waiting for a signature.");
  const reason = await validateWorkflowRisk({ ...expected, steps: [step] }, input.mcp,
    AbortSignal.any([input.signal, AbortSignal.timeout(25_000)]));
  if (reason) throw new ResearchError("risk_validation_failed", reason);
  const record = await journal.acceptSignedEnvelope(input.id, identity, step.id, input.signedXdr);
  try {
    const [sdk, config] = await Promise.all([import("@stellar/stellar-sdk"), import("@/lib/stellar-utils")]);
    await interruptible(() => new sdk.rpc.Server(config.SOROBAN_RPC_URL).sendTransaction(
      sdk.TransactionBuilder.fromXDR(input.signedXdr, sdk.Networks.TESTNET)), AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]));
  } catch { return workflowView(record); }
  return workflowView(await settleSubmitted(journal, input.id, identity, lookupTransaction));
}

function journalMessage(code: string): string {
  switch (code) {
    case "workflow_not_runnable": return "This plan cannot run yet. Approve it first, or prepare a new one.";
    case "step_already_claimed": return "This step is already in progress.";
    case "step_not_ready": return "Conditions moved. This step was not submitted. Prepare a new plan.";
    case "no_pending_step": return "There is no remaining step to run.";
    default: return "This plan could not advance. Prepare a new one if it is stuck.";
  }
}

/**
 * Identity args come from the re-resolved scope, not the browser. Earn wants `lender`
 * on the G-wallet and rejects the margin overlay Blend writes need.
 */
export function invocationArgs(step: ProposalStep, scope: { trader: string | null; smartAccount: string | null }): Record<string, unknown> {
  if (step.tool === "vanna_lend") {
    return { symbol: step.args.symbol, amount: step.amount, lender: scope.trader };
  }
  return { ...step.args, amount: step.amount, smart_account: scope.smartAccount, trader: scope.trader };
}
