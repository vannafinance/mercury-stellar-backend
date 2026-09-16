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
import { decimalWad, formatWad, mulDown, WAD } from "./fixed";
import { constantProductOut, isDangerousFill, poolReservesFrom, reservesForDirection, slippageFloor, type PoolReserves } from "./pool-quote";
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

/** What re-quoting the pool right before the write decided. */
export type StaleFloorVerdict =
  | { kind: "unchanged" }
  | { kind: "adjusted"; minOut: string; note: string }
  | { kind: "refuse"; message: string };

/**
 * A swap's floor is re-quoted against the pool one more time, moments before the write.
 *
 * ## The race this closes
 *
 * The floor is derived when the plan is built; the swap is sent when the user approves it,
 * seconds or minutes later. A pool does not stand still in between — 15 Sep, live, the same
 * 1,000 XLM → AQUSDC swap was refused by the DEX (HostError #2006) at approve time on a
 * floor that had been perfectly fine moments before.
 *
 * A moved price is not, by itself, a reason to stop: the user asked to swap 100 XLM, not to
 * receive exactly one number or nothing. So the pool is re-quoted here, and the write
 * proceeds whenever the fresh fill is still a FAIR one — only a fill that is itself
 * dangerous (the same oracle-price-impact threshold the propose-time card refuses on) stops
 * the write, and it stops BEFORE anything is sent, naming both figures:
 *
 * - Pool still pays the approved floor → send it UNCHANGED.
 * - Pool pays less, but the fresh fill is still fair (within the impact threshold) → send it
 *   with the floor LOWERED to what the pool actually offers, minus the same slippage margin
 *   the original floor used. The eventual result names the price it actually settled at —
 *   never a silent substitution the user has to discover from their balance afterward.
 * - Pool pays so much less that the fresh fill is itself a bad trade → refuse, naming both
 *   figures. This is the one case a floor must not be lowered to fit: an already-thin pool
 *   getting thinner is exactly what the price-impact guard exists to catch, whichever side
 *   of the approval it happens on.
 *
 * Fails OPEN. If the pool or price reads are unavailable, slow, or not an Aquarius pair, the
 * write proceeds unchanged — the DEX's own floor check is still the backstop, and a stats
 * endpoint being down is not a reason to block a swap the user approved.
 */
export async function staleSwapFloor(
  step: ProposalStep,
  mcp: Pick<MCPClient, "call">,
  trader: string,
  signal: AbortSignal,
  slippageAccepted = false,
): Promise<StaleFloorVerdict> {
  const unchanged: StaleFloorVerdict = { kind: "unchanged" };
  // Re-quote ANY swap venue, not just Aquarius. A price that moved between the plan and
  // the approval is the normal case, and a Soroswap leg that skipped this carried its
  // plan-time floor all the way to signing — which is how a floor sized at oracle parity
  // reached the wallet against a pool paying less than half of it (16 Sep, live).
  const swapVenue = typeof step.args.venue === "string" ? step.args.venue : "";
  if (step.op !== "swap" || (swapVenue !== "aquarius" && swapVenue !== "soroswap")) return unchanged;
  const tokenIn = typeof step.args.token_in === "string" ? step.args.token_in : "";
  const tokenOut = typeof step.args.token_out === "string" ? step.args.token_out : "";
  const amountIn = typeof step.args.amount_in === "string" ? step.args.amount_in : "";
  const minOut = typeof step.args.min_out === "string" ? step.args.min_out : "";
  if (!tokenIn || !tokenOut || !amountIn || !minOut) return unchanged;
  let reserves: PoolReserves | null = null;
  try {
    const payload = await interruptible(
      () => mcp.call(
        swapVenue === "soroswap" ? "vanna_get_soroswap_pool_stats" : "vanna_get_aquarius_pool_stats",
        { token_a: tokenIn, token_b: tokenOut },
        trader,
      ),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
    // `swap_killed` is the AMM API's description of a pool, not the chain's answer, and
    // refusing on it blocked swaps that settle — see the note in plan.ts. The re-quote
    // below is the real check: it refuses when the pool cannot actually fill the floor.
    reserves = poolReservesFrom(payload);
  } catch { return step.targetOut ? { kind: "refuse", message: "The live pool could not be re-quoted for the exact output you approved. Nothing was submitted." } : unchanged; }
  if (!reserves) return step.targetOut ? { kind: "refuse", message: "The live pool reserves are unavailable for the exact output you approved. Nothing was submitted." } : unchanged;
  let quoted: bigint | null;
  let floorWad: bigint;
  try {
    const { inWad, outWad, feeWad } = reservesForDirection(reserves, tokenIn.toUpperCase() === "XLM");
    quoted = constantProductOut(decimalWad(amountIn), inWad, outWad, feeWad);
    floorWad = decimalWad(minOut);
  } catch { return step.targetOut ? { kind: "refuse", message: "The exact-output quote could not be checked. Nothing was submitted." } : unchanged; }
  if (quoted === null) return step.targetOut ? { kind: "refuse", message: "The exact-output quote could not be checked. Nothing was submitted." } : unchanged;
  if (step.targetOut && quoted < decimalWad(step.targetOut)) {
    return { kind: "refuse", message: `The pool now offers about ${formatWad(quoted)} ${tokenOut} for ${amountIn} ${tokenIn}, below the ${step.targetOut} ${tokenOut} you approved. Nothing was submitted; ask for a fresh quote.` };
  }
  if (step.targetOut) return unchanged;
  if (quoted >= floorWad) return unchanged;

  // The pool pays less than approved. Whether that is fine or dangerous is not a question
  // the pool's own reserves can answer — it needs the oracle, the same way the propose-time
  // guard does, so both ends of the same trade are judged by the same yardstick.
  let inUsd: unknown, outUsd: unknown;
  try {
    [inUsd, outUsd] = await interruptible(
      () => Promise.all([
        mcp.call("vanna_get_price", { symbol: tokenIn }, trader),
        mcp.call("vanna_get_price", { symbol: tokenOut }, trader),
      ]),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
  } catch { return adjustedOrUnchanged(quoted, tokenIn, tokenOut, amountIn, minOut); }
  const inPriceWad = priceWadFrom(inUsd);
  const outPriceWad = priceWadFrom(outUsd);
  if (inPriceWad === null || outPriceWad === null) {
    return adjustedOrUnchanged(quoted, tokenIn, tokenOut, amountIn, minOut);
  }
  const inUsdWad = mulDown(decimalWad(amountIn), inPriceWad, WAD);
  const outUsdWad = mulDown(quoted, outPriceWad, WAD);
  // A user who accepted the loss gets the trade, re-quoted: the floor drops to what the
  // pool pays NOW, which is what "execute at whatever price" has to mean if it is to mean
  // anything safe. Sending no floor at all would leave the fill to whoever moves the pool
  // next in the same ledger, so the fresh quote — not nothing — becomes the floor.
  if (isDangerousFill(inUsdWad, outUsdWad) && !slippageAccepted) {
    return {
      kind: "refuse",
      message: `Not submitted — the pool's price moved after you approved this, and now fills at a loss: `
        + `${tokenIn} → ${tokenOut} would settle for about ${formatWad(quoted)} ${tokenOut} for ${amountIn} ${tokenIn}, `
        + `well below the ${minOut} ${tokenOut} floor you approved and below what ${tokenIn} is worth. `
        + `Ask again for a fresh quote, or say you accept the loss and it will be swapped as asked.`,
    };
  }
  return adjustedOrUnchanged(quoted, tokenIn, tokenOut, amountIn, minOut);
}

/** The pool moved but the fresh fill is still fair: adjust the floor down and say so, plainly. */
function adjustedOrUnchanged(quoted: bigint, tokenIn: string, tokenOut: string, amountIn: string, approvedMinOut: string): StaleFloorVerdict {
  const freshFloor = formatWad(slippageFloor(quoted));
  return {
    kind: "adjusted",
    minOut: freshFloor,
    note: `The pool's price moved after you approved this: ${tokenIn} → ${tokenOut} settled for about `
      + `${formatWad(quoted)} ${tokenOut} instead of the ${approvedMinOut} ${tokenOut} originally quoted for ${amountIn} ${tokenIn}.`,
  };
}

function priceWadFrom(response: unknown): bigint | null {
  if (!isRecord(response) || typeof response.price_usd !== "string") return null;
  try { return decimalWad(response.price_usd); } catch { return null; }
}

const REQUOTE_MS = 8_000;

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
  note?: string,
) {
  const stored = await journal.read(id, identity);
  const step = stored.value.steps.find((entry) => entry.status === "submitted" && entry.txHash);
  if (!step?.txHash) return stored.value;
  const outcome = await lookup(step.txHash);
  if (!outcome.found) return stored.value;
  return journal.settled(id, identity, step.id, step.txHash, outcome.ledger, outcome.success, note);
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
   * Re-quote the pool before spending the user's approval on a price that has already moved.
   * A moved price alone does not stop the write — only a fill that would itself be a bad
   * trade does (`staleSwapFloor`'s own "refuse" case). Otherwise the floor is sent as
   * approved, or lowered to what the pool actually offers with a note recording it — never
   * a silent substitution the user only discovers from their balance afterward.
   */
  const acceptedLoss = stored.value.proposal.slippageAccepted === true;
  const stale = await staleSwapFloor(step, input.mcp, scope.trader, input.signal, acceptedLoss);
  if (stale.kind === "refuse") {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: stale.message }));
  }
  const adjustedArgs = stale.kind === "adjusted" ? { ...invocation.args, min_out: stale.minOut } : invocation.args;
  // Tell the MCP a human was shown this fill and took it. Its own impact gate withholds
  // auto-sign otherwise, which for an accepted trade is the same confirmation twice.
  const invocationArgs = acceptedLoss && step.op === "swap"
    ? { ...adjustedArgs, acknowledged_price_impact: true }
    : adjustedArgs;
  const note = stale.kind === "adjusted" ? stale.note : null;

  let build: Record<string, unknown>;
  try {
    const raw = await interruptible(() => input.mcp.call(invocation.tool, invocationArgs, scope.trader!),
      AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]));
    if (!isRecord(raw)) throw new Error("invalid_write_result");
    build = raw;
  } catch (error) {
    // This catch used to be silent: a step went "uncertain" with nothing in any log
    // explaining why, so a timeout, a transport error and a malformed payload were
    // indistinguishable from the outside. `error` is never a broadcast proof either way,
    // so the outcome is unchanged — only the diagnostic trail is new.
    console.warn("[copilot] write call failed, step marked uncertain", {
      tool: invocation.tool,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
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
    record = await journal.invocationResult(input.id, identity, step.id, { kind: "submitted", txHash, note: note ?? undefined });
    record = await settleSubmitted(journal, input.id, identity, lookup, note ?? undefined);
    persistRun(record, input.subject);
    return workflowView(record);
  }

  if (result.status === "needs_wallet_sign" && result.unsigned_xdr) {
    record = await journal.invocationResult(input.id, identity, step.id, {
      kind: "unsigned", unsignedXdr: result.unsigned_xdr, note: note ?? undefined,
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
