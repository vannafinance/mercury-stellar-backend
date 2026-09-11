/**
 * Rebuild a candidate from investigation evidence and hold it as a journal proposal.
 *
 * The browser may name a candidate by id. It may not supply amounts, tools or args —
 * those are compiled here from sealed investigation evidence when that bundle is still
 * fresh, otherwise from a new world-read, then the same generator that produced the card.
 * A compiled step list that `create()` would refuse never reaches the user.
 */

import type { MCPClient } from "../mcp-client";
import { computeBorrowCapacity } from "./capacity";
import {
  generateCandidates, idleWalletByAssetUsdFrom, idleWalletByAssetTokensFrom, idleWalletUsdFrom, requestedBorrowFrom,
} from "./candidates";
import { collectStrategyReads } from "./strategy-reads";
import { compareObservedRates } from "./rate-comparison";
import { compileProposal } from "./compile";
import { researchCodec } from "./continuation";
import { researchEvidenceReusable } from "./evidence";
import { resolveInvestigationScope, ResearchError } from "./scope";
import { WorkflowJournal, WorkflowConflict } from "../workflow/journal";
import { workflowStore } from "../workflow/store";
import { workflowView, type WorkflowProposal, type WorkflowRecord, type WorkflowView } from "../workflow/types";
import { getMcpClient } from "../mcp-client";
import { validateWorkflowRisk } from "../workflow/risk";
import { allowedInvocation } from "../workflow/allowlist";
import { appendAudit } from "../audit-log";

export function workflowJournal(secret: string): WorkflowJournal {
  return new WorkflowJournal(workflowStore<WorkflowRecord>(secret));
}

export async function proposeWorkflow(input: {
  continuation: string;
  candidateId: string;
  subject: string;
  secret: string;
  server: string;
  network: string;
  mcp: Pick<MCPClient, "call">;
  signal: AbortSignal;
  now?: number;
}): Promise<WorkflowView> {
  const wallNow = input.now ?? Date.now();
  const codec = researchCodec(input.secret, input.server, () => wallNow);
  const prior = codec.read(input.continuation);
  if (!prior.evidence?.allowedCandidateIds?.includes(input.candidateId))
    throw new ResearchError("candidate_unavailable", "This option was not proposed by the completed investigation. Start a fresh investigation.");
  if (prior.scope.subject !== input.subject) {
    throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
  }
  const scope = await resolveInvestigationScope({
    subject: input.subject, wallet: prior.scope.trader, network: input.network,
  }, input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  if (scope.subject !== prior.scope.subject || scope.trader !== prior.scope.trader ||
    scope.smartAccount !== prior.scope.smartAccount || scope.network !== prior.scope.network) {
    throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
  }
  if (input.candidateId === "requested_actions") {
    const steps = prior.evidence?.requestedSteps;
    if (!steps?.length) throw new ResearchError("candidate_unavailable", "The requested actions are unavailable. Investigate again.");
    for (const step of steps) allowedInvocation(step, scope);
    const floor = prior.evidence?.capacity?.floor ?? null;
    const draft = { scope, server: input.server, objective: prior.messages[0], messages: prior.messages,
      assumptions: ["Amounts are the literal token amounts in your request. No automatic resizing is allowed."],
      constraints: floor ? [`Health factor at or above ${floor}`] : [], floor, steps };
    /**
     * Propose holds the compiled plan for the card. Live prices and balances are
     * re-checked on approve and again immediately before the first leg (P6).
     * Awaiting MCP here is what left "repay 1 XLM" with no Approve button for 90s.
     */
    const record = await workflowJournal(input.secret).create(draft);
    void appendAudit({
      at: wallNow, subject: input.subject, action: "proposed",
      workflowId: record.proposal.id, digest: record.proposal.digest, floor,
    });
    return workflowView(record);
  }
  const earnIdle = input.candidateId.startsWith("lend_idle_");
  if (!scope.trader || (!earnIdle && !scope.smartAccount)) {
    throw new ResearchError("account_unavailable", earnIdle
      ? "A verified wallet is required to prepare this Earn plan."
      : "A verified wallet and margin account are required to prepare this plan.");
  }

  const reused = researchEvidenceReusable(prior.evidence, wallNow);
  /**
   * Compile against the capture clock when reusing. Investigation can already consume
   * most of the 60s price window; treating the sealed bundle as of `capturedAt` keeps
   * auto-propose from failing `stale_price` on evidence that just produced the card.
   * The bundle itself still expires 60s after capture (researchEvidenceReusable).
   */
  const now = wallNow;
  const observations = reused
    ? prior.evidence!.observations
    : await collectStrategyReads(scope, input.mcp, input.signal, now);
  const capacity = reused
    ? prior.evidence!.capacity
    : await computeBorrowCapacity(scope.smartAccount, prior.messages, input.signal, null, {
      mcp: input.mcp, trader: scope.trader,
    });
  const requestedBorrow = requestedBorrowFrom(prior.messages, observations, now);
  const comparisons = compareObservedRates(observations, now);
  const idleWalletUsd = idleWalletUsdFrom(observations, now);
  const idleWalletByAssetUsd = idleWalletByAssetUsdFrom(observations, now);
  const idleWalletByAssetTokens = idleWalletByAssetTokensFrom(observations, now);
  const idleOnly = input.candidateId.startsWith("supply_idle_") || earnIdle;
  /**
   * Same gates as `researchTurn`: an unvalued stated amount must not fall through to
   * sizing-to-the-floor, and a borrow shape still needs the user's floor. Idle supply
   * does not, but it still needs a comparison row — that is how the generator keys assets.
   */
  const candidates = idleOnly
    ? generateCandidates({
        grossCollateralUsd: capacity?.grossCollateralUsd ?? "0",
        debtUsd: capacity?.debtUsd ?? "0",
        floor: capacity?.floor ?? "1.30",
          idleWalletUsd, idleWalletByAssetUsd, idleWalletByAssetTokens, borrowingAllowed: false, comparisons,
      })
    : capacity && comparisons.length && requestedBorrow?.usd !== null
      ? generateCandidates({
          grossCollateralUsd: capacity.grossCollateralUsd,
          debtUsd: capacity.debtUsd,
          floor: capacity.floor,
          idleWalletUsd, idleWalletByAssetUsd, idleWalletByAssetTokens,
          borrowingAllowed: true,
          requestedBorrowUsd: requestedBorrow?.usd ?? null,
          comparisons,
        })
      : null;
  const candidate = candidates?.feasible.find((entry) => entry.id === input.candidateId);
  if (!candidate) {
    throw new ResearchError("candidate_unavailable", "That option is no longer available at the current rates and position. Start a new investigation.");
  }

  const compiled = compileProposal({
    candidate, scope, observations, floor: capacity?.floor ?? null, now,
  });
  if (!compiled.ok) {
    throw new ResearchError("compile_failed", compileMessage(compiled.reason));
  }

  const derived = compiled.steps.find((step) => step.sizing?.basis === "derived_max_at_floor");
  const assumptions = [
    "Token amounts use the oracle price read for this proposal, not a ticker peg.",
    ...(derived && derived.sizing?.basis === "derived_max_at_floor"
      ? [`Floor-derived amounts may be re-sized down to ${derived.sizing.minAmountUsd} USD if conditions move, never below.`]
      : []),
  ];
  const journal = workflowJournal(input.secret);
  /**
   * Same as requested_actions: the card is compiled here; live prices and
   * balances are re-checked on Approve and again immediately before the first
   * leg. Awaiting MCP risk on propose is what left the user staring at
   * “Preparing the plan timed out” with no Approve button.
   */
  try {
    const record = await journal.create({
      scope, server: input.server, objective: candidate.label, messages: prior.messages,
      assumptions, constraints: capacity ? [`Health factor at or above ${capacity.floor}`] : [],
      floor: capacity?.floor ?? null, steps: compiled.steps,
    });
    void appendAudit({
      at: now, subject: input.subject, action: "proposed",
      workflowId: record.proposal.id, digest: record.proposal.digest,
      floor: capacity?.floor ?? null,
    });
    return workflowView(record);
  } catch (error) {
    if (error instanceof WorkflowConflict) {
      throw new ResearchError("proposal_conflict", "A proposal could not be stored. Please try again.", 409);
    }
    throw error;
  }
}

export async function validateProposal(proposal: WorkflowProposal): Promise<string | null> {
  return validateWorkflowRisk(proposal, getMcpClient(), AbortSignal.timeout(60_000));
}

function compileMessage(reason: string): string {
  switch (reason) {
    case "missing_price": return "No oracle price was read for this asset, so a plan could not be sized.";
    case "stale_price": return "The oracle price for this asset is too old to size a plan. Start a new investigation.";
    case "unpriceable_amount": return "The amount could not be converted to tokens from the read price.";
    case "zero_amount": return "The converted token amount was zero, so no plan was built.";
    case "unsupported_venue": return "This venue cannot be turned into an executable plan yet.";
    case "unsupported_op": return "This option includes a step that cannot be proposed yet.";
    default: return "A plan could not be built from the current evidence.";
  }
}
