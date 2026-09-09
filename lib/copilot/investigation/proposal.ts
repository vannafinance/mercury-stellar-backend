/**
 * Rebuild a candidate from investigation evidence and hold it as a journal proposal.
 *
 * The browser may name a candidate by id. It may not supply amounts, tools or args —
 * those are compiled here from sealed investigation evidence when that bundle is still
 * fresh, otherwise from a new world-read, then the same generator that produced the card.
 * A compiled step list that `create()` would refuse never reaches the user.
 */

import type { MCPClient } from "../mcp-client";
import { resolveRead } from "./capabilities";
import { interruptible } from "./runtime";
import { isRecord } from "./decision";
import type { InvestigationScope, Observation } from "./types";
import { computeBorrowCapacity } from "./capacity";
import {
  generateCandidates, idleWalletByAssetUsdFrom, idleWalletUsdFrom, requestedBorrowFrom,
} from "./candidates";
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

const READS = [
  { capability: "wallet_balances", args: {} },
  { capability: "asset_price", args: { asset: "XLM" } },
  { capability: "asset_price", args: { asset: "BLUSDC" } },
  { capability: "earn_market", args: { asset: "XLM" } },
  { capability: "earn_market", args: { asset: "BLUSDC" } },
  { capability: "blend_markets", args: {} },
] as const;

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
    const floor = prior.evidence?.capacity?.floor ?? null;
    const draft = { scope, server: input.server, objective: prior.messages[0], messages: prior.messages,
      assumptions: ["Amounts are the literal token amounts in your request. No automatic resizing is allowed."],
      constraints: floor ? [`Health factor at or above ${floor}`] : [], floor, steps };
    const reason = await validateWorkflowRisk({ ...draft, id: "", revision: 1, digest: "", createdAt: wallNow, expiresAt: wallNow + 300_000 },
      input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(25_000)]));
    if (reason) throw new ResearchError("risk_validation_failed", reason);
    return workflowView(await workflowJournal(input.secret).create(draft));
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
    : await collectObservations(scope, input.mcp, input.signal, now);
  const capacity = reused
    ? prior.evidence!.capacity
    : await computeBorrowCapacity(scope.smartAccount, prior.messages, input.signal);
  const requestedBorrow = requestedBorrowFrom(prior.messages, observations, now);
  const comparisons = compareObservedRates(observations, now);
  const idleWalletUsd = idleWalletUsdFrom(observations, now);
  const idleWalletByAssetUsd = idleWalletByAssetUsdFrom(observations, now);
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
        idleWalletUsd, idleWalletByAssetUsd, borrowingAllowed: false, comparisons,
      })
    : capacity && comparisons.length && requestedBorrow?.usd !== null
      ? generateCandidates({
          grossCollateralUsd: capacity.grossCollateralUsd,
          debtUsd: capacity.debtUsd,
          floor: capacity.floor,
          idleWalletUsd, idleWalletByAssetUsd,
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
  const riskReason = await validateWorkflowRisk({ id: "", revision: 1, digest: "", createdAt: now, expiresAt: now + 300_000,
    scope, server: input.server, objective: candidate.label, messages: prior.messages, assumptions,
    constraints: capacity ? [`Health factor at or above ${capacity.floor}`] : [], floor: capacity?.floor ?? null, steps: compiled.steps,
  }, input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(25_000)]));
  if (riskReason) throw new ResearchError("risk_validation_failed", riskReason);
  try {
    const record = await journal.create({
      scope, server: input.server, objective: candidate.label, messages: prior.messages,
      assumptions, constraints: capacity ? [`Health factor at or above ${capacity.floor}`] : [],
      floor: capacity?.floor ?? null, steps: compiled.steps,
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
  return validateWorkflowRisk(proposal, getMcpClient(), AbortSignal.timeout(25_000));
}

/**
 * Live reads used only when sealed investigation evidence is missing or older
 * than the 60s freshness window. Auto-propose should hit the sealed path.
 */
async function collectObservations(
  scope: InvestigationScope,
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
  now: number,
): Promise<Observation[]> {
  const prepared: Array<{ capability: string; args: Record<string, unknown>; read: ReturnType<typeof resolveRead> }> = [];
  for (const request of READS) {
    try {
      prepared.push({
        capability: request.capability, args: { ...request.args },
        read: resolveRead(request.capability, request.args, scope),
      });
    } catch { /* capability unavailable for this scope; skip rather than invent */ }
  }
  const observations: Observation[] = prepared.map((entry, offset) => ({
    id: `p${offset + 1}`, capability: entry.capability, args: entry.args, observedAt: now, status: "error",
  }));
  await Promise.all(prepared.map(async (entry, offset) => {
    const observation = observations[offset];
    try {
      const response = await interruptible(
        () => mcp.call(entry.read.tool, entry.read.args, scope.trader ?? undefined),
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      if (!isRecord(response) || response.error || response.isError === true || response.ok === false) {
        observation.error = "MCP returned unavailable or failed data; do not use it as a financial fact.";
        return;
      }
      observation.data = response;
      observation.status = "ok";
    } catch {
      observation.error = "MCP read failed. No value was inferred.";
    }
  }));
  return observations;
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
