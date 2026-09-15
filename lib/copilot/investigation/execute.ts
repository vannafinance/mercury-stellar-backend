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
import { decimalWad, formatWad } from "./fixed";
import { constantProductOut, poolReservesFrom, reservesForDirection, type PoolReserves } from "./pool-quote";
import { WorkflowConflict, type StepReadiness } from "../workflow/journal";
import { workflowView, type WorkflowProposal, type WorkflowView, type ProposalStep } from "../workflow/types";
import { getMcpClient } from "../mcp-client";
import { validateWorkflowRisk } from "../workflow/risk";
import { appendAudit } from "../audit-log";
import { checkpointFromJournal, saveCheckpoint } from "../checkpoint";
import { ResearchError, resolveInvestigationScope } from "./scope";
import { workflowJournal } from "./proposal";
import { TOOLS } from "../workflow/allowlist";
import { WALLET_OPS } from "../workflow/types";

/** Every tool the vocabulary maps to. Derived, so a new op cannot be allowlisted yet unexecutable. */
const WRITE_TOOLS = new Set(Object.values(TOOLS));
const WALLET_TOOLS = new Set(WALLET_OPS.map((op) => TOOLS[op]));

export type LedgerLookup = (hash: string) => Promise<
  { found: true; success: boolean; ledger: number } | { found: false }
>;

function persistRun(record: { proposal: WorkflowProposal; status: string; steps: Array<{ id: string; status: string; txHash?: string }> }, subject: string) {
  const checkpoint = checkpointFromJournal({
    workflowId: record.proposal.id, subject, status: record.status,
    digest: record.proposal.digest, steps: record.steps,
  });
  void saveCheckpoint(checkpoint);
  const hash = checkpoint.lastTxHash;
  if (hash) {
    void appendAudit({
      at: Date.now(), subject, action: "executed",
      workflowId: record.proposal.id, digest: record.proposal.digest,
      txHash: hash, floor: record.proposal.floor,
    });
  }
}

function identityOf(proposal: WorkflowProposal) {
  return { scope: proposal.scope, server: proposal.server };
}

/**
 * A swap's floor is checked against the pool one more time, moments before the write.
 *
 * ## The race this closes
 *
 * The floor is derived when the plan is built; the swap is sent when the user approves it,
 * seconds or minutes later. A pool does not stand still in between — 15 Sep, live, the same
 * 1,000 XLM → AQUSDC swap was refused by the DEX (HostError #2006) at approve time and
 * filled at the identical floor minutes later. The user saw a raw contract code for what
 * was really "the price moved".
 *
 * So the pool is re-quoted here, and the answer decides between two honest outcomes:
 *
 * - The pool still pays the approved floor → send it UNCHANGED. The floor the user approved
 *   is the floor that gets signed; re-quoting never quietly raises or lowers it.
 * - The pool no longer pays it → refuse, naming both figures. It must not be lowered to fit:
 *   a floor that follows the price down is not a floor, it is a slider, and the user
 *   approved a trade at the number they were shown, not "whatever it settles at".
 *
 * Fails OPEN. If the pool read is unavailable, slow, or not an Aquarius pair, the write
 * proceeds exactly as before — the DEX's own floor check is still the backstop, and a
 * stats endpoint being down is not a reason to block a swap the user approved.
 */
export async function staleSwapFloor(
  step: ProposalStep,
  mcp: Pick<MCPClient, "call">,
  trader: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (step.op !== "swap" || step.args.venue !== "aquarius") return null;
  const tokenIn = typeof step.args.token_in === "string" ? step.args.token_in : "";
  const tokenOut = typeof step.args.token_out === "string" ? step.args.token_out : "";
  const amountIn = typeof step.args.amount_in === "string" ? step.args.amount_in : "";
  const minOut = typeof step.args.min_out === "string" ? step.args.min_out : "";
  if (!tokenIn || !tokenOut || !amountIn || !minOut) return null;
  let reserves: PoolReserves | null = null;
  try {
    const payload = await interruptible(
      () => mcp.call("vanna_get_aquarius_pool_stats", { token_a: tokenIn, token_b: tokenOut }, trader),
      AbortSignal.any([signal, AbortSignal.timeout(POOL_REQUOTE_MS)]),
    );
    reserves = poolReservesFrom(payload);
  } catch { return null; }
  if (!reserves) return null;
  let quoted: bigint | null;
  try {
    const { inWad, outWad, feeWad } = reservesForDirection(reserves, tokenIn.toUpperCase() === "XLM");
    quoted = constantProductOut(decimalWad(amountIn), inWad, outWad, feeWad);
  } catch { return null; }
  if (quoted === null) return null;
  let floorWad: bigint;
  try { floorWad = decimalWad(minOut); } catch { return null; }
  if (quoted >= floorWad) return null;
  return `Not submitted — the pool's price moved after you approved this. ${tokenIn} → ${tokenOut} now fills at about `
    + `${formatWad(quoted)} ${tokenOut} for ${amountIn} ${tokenIn}, below the ${minOut} ${tokenOut} floor you approved. `
    + `The floor was not lowered to fit. Ask again for a fresh quote.`;
}

const POOL_REQUOTE_MS = 8_000;

function hashOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

export async function readyForStep(proposal: WorkflowProposal, step: ProposalStep): Promise<StepReadiness> {
  const reason = await validateWorkflowRisk({ ...proposal, steps: [step] }, getMcpClient(), AbortSignal.timeout(45_000));
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

  if (!WRITE_TOOLS.has(step.tool) || !scope.trader || (!WALLET_TOOLS.has(step.tool) && !scope.smartAccount)) {
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
  /**
   * Re-quote the pool before spending the user's approval on a floor the price has already
   * left behind. Nothing is resized: this either proceeds with the approved arguments or
   * stops with the reason, so the swap that gets signed is the one that was approved.
   */
  const stale = await staleSwapFloor(step, input.mcp, scope.trader, input.signal);
  if (stale) {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: stale }));
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

  /**
   * The MCP's error envelope (`mcp_server/error_handling.py`) attaches `reason`, `code`
   * or `contract_diagnostic` only to failures it classified INSIDE the tool — simulation
   * and validation, before anything was submitted — and a submitted transaction always
   * carries its hash. Such an envelope is a rejection with a reason, and the reason is
   * the one line the user needs; filing it as "uncertain" hid it (13 Sep deposit).
   */
  const rejection = preBroadcastRejection(build, hash, step);
  if (rejection) {
    console.warn("[copilot] write rejected before broadcast", { tool: invocation.tool, error: build.error, code: build.code, reason: build.reason, message: rejection.slice(0, 300) });
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: rejection }));
  }

  if (result.status === "signed_and_submitted") {
    const txHash = hash;
    if (!txHash) {
      record = await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" });
      return workflowView(record);
    }
    record = await journal.invocationResult(input.id, identity, step.id, { kind: "submitted", txHash });
    record = await settleSubmitted(journal, input.id, identity, lookup);
    persistRun(record, input.subject);
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

/** The MCP's own message when its envelope proves nothing was broadcast; null otherwise. */
export function preBroadcastRejection(
  build: Record<string, unknown>,
  hash: string | null,
  step?: { op?: string; args?: Record<string, unknown> },
): string | null {
  if (hash || typeof build.error !== "string" || !build.error) return null;
  const classified = typeof build.contract_diagnostic === "string" || typeof build.reason === "string" || typeof build.code === "string" || build.simulation_success === false;
  if (!classified) return null;
  const message = typeof build.message === "string" && build.message.trim() ? build.message.trim() : `${build.error}${build.reason ? ` (${String(build.reason).replaceAll("_", " ")})` : ""}`;
  const note = swapFloorNote(step, message);
  return `Not submitted — the protocol rejected this step before broadcast: ${message}${note ? ` ${note}` : ""}`;
}

/**
 * A swap carries a floor (`min_out`) the DEX must meet or the call reverts, and the raw
 * revert is a bare contract code — "HostError #2006" told the user nothing (15 Sep, live).
 * The floor is the one thing about that failure we can state as fact, so it is named, and
 * the likeliest reading of it is offered AS a reading, not as a diagnosis: the error codes
 * belong to the DEX's own contract, not to Vanna's, so their meanings are not ours to
 * assert.
 *
 * This is now the SECOND line of defence, not the first: `staleSwapFloor` re-quotes the
 * pool before the write and states "the price moved" in plain words with both figures.
 * A rejection that still reaches here is one that re-quote could not foresee — the pool
 * read was unavailable, the pair is not Aquarius, or the pool moved inside the last moment.
 */
function swapFloorNote(step: { op?: string; args?: Record<string, unknown> } | undefined, message: string): string | null {
  if (step?.op !== "swap") return null;
  const floor = typeof step.args?.min_out === "string" ? step.args.min_out : null;
  const bought = typeof step.args?.token_out === "string" ? step.args.token_out : null;
  if (!floor || !bought || !/contract|hosterror|simulation/i.test(message)) return null;
  return `This swap would only settle for at least ${floor} ${bought}; a DEX refuses the call outright when its pool cannot meet that, which is the most likely reading here — the code itself belongs to the DEX's contract, so it is not proof.`;
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
  if (WALLET_TOOLS.has(step.tool)) {
    return { symbol: step.args.symbol, amount: step.amount, lender: scope.trader };
  }
  return { ...step.args, amount: step.amount, smart_account: scope.smartAccount, trader: scope.trader };
}
