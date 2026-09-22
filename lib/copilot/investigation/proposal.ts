/**
 * Rebuild a candidate from investigation evidence and hold it as a journal proposal.
 *
 * The browser may name a candidate by id. It may not supply amounts, tools or args —
 * those are compiled here from sealed investigation evidence when that bundle is still
 * fresh, otherwise from a new world-read, then the same generator that produced the card.
 * A compiled step list that `create()` would refuse never reaches the user.
 */

import type { MCPClient } from "../mcp-client";
import { capacityFromBasis, computeSizingBasis, type SizingBasis } from "./capacity";
import { computeMarginSnapshot } from "@/lib/account-snapshot";
import { interruptible } from "./runtime";
import {
  generateCandidates, idleWalletByAssetUsdFrom, idleWalletByAssetTokensFrom, idleWalletUsdFrom, requestedBorrowFrom,
} from "./candidates";
import { collectStrategyReads, readsForPlans, STRATEGY_READS } from "./strategy-reads";
import { parseCandidateId, requiresMarginAccount, REQUESTED_ACTIONS_ID } from "./candidate-id";
import { statedFloorFrom } from "./floor";
import { planCandidateId, resolvePlans } from "./plan";
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
  /**
   * `allowedCandidateIds` above is the authority; parsing only recovers the kind so the
   * account check and the generator gate can be decided before any read is paid for.
   */
  const parsed = parseCandidateId(input.candidateId);
  if (!parsed) throw new ResearchError("candidate_unavailable", "This option was not proposed by the completed investigation. Start a fresh investigation.");
  if (parsed.kind === REQUESTED_ACTIONS_ID) {
    const steps = prior.evidence?.requestedSteps;
    if (!steps?.length) throw new ResearchError("candidate_unavailable", "The requested actions are unavailable. Investigate again.");
    for (const step of steps) allowedInvocation(step, scope);
    const floor = prior.evidence?.capacity?.floor ?? null;
    /**
     * The acceptance travels with the steps. A stated swap is proposed through THIS branch,
     * not the composed one below — so leaving it off here dropped the user's own words at
     * the last hop: the plan gate lifted and the card appeared, then the pre-write re-quote
     * and the MCP's impact gate both still saw an unaccepted fill and withheld the swap the
     * user had already agreed to. The same field the composed path seals, sealed here.
     */
    const draft = { scope, server: input.server, objective: prior.messages[0], messages: prior.messages,
      assumptions: ["Amounts are the literal token amounts in your request. No automatic resizing is allowed."],
      constraints: floor ? [`Health factor at or above ${floor}`] : [], floor, steps,
      slippageAccepted: prior.evidence?.slippageAccepted === true };
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
  /**
   * A composed plan is re-sized from the sealed shape the model proposed, never from a
   * second model turn: the option the user clicked must be the option that compiles.
   */
  const sealedPlan = parsed.kind === "composed"
    ? prior.evidence?.plans?.find((plan) => planCandidateId(plan) === input.candidateId) ?? null
    : null;
  if (parsed.kind === "composed" && !sealedPlan) {
    throw new ResearchError("candidate_unavailable", "This option was not proposed by the completed investigation. Start a fresh investigation.");
  }
  const marginNeeded = sealedPlan ? sealedPlan.legs.some((leg) => leg.op !== "lend") : requiresMarginAccount(parsed.traits);
  if (!scope.trader || (marginNeeded && !scope.smartAccount)) {
    throw new ResearchError("account_unavailable", marginNeeded
      ? "A verified wallet and margin account are required to prepare this plan."
      : "A verified wallet is required to prepare this Earn plan.");
  }

  const reused = researchEvidenceReusable(prior.evidence, wallNow);
  /**
   * Compile against the capture clock when reusing. Investigation can already consume
   * most of the 60s price window; treating the sealed bundle as of `capturedAt` keeps
   * auto-propose from failing `stale_price` on evidence that just produced the card.
   * The bundle itself still expires 60s after capture (researchEvidenceReusable).
   */
  const now = wallNow;
  /**
   * A stale bundle is re-read. The market set alone is not enough for a composed plan: a
   * repay needs the debt, a withdraw the posted collateral, a redeem the Earn position —
   * without them the plan re-resolves as "no XLM debt was read" and the card says the
   * option "is no longer available" (13 Sep, one minute after it was offered).
   */
  /**
   * The world-read and the app snapshot are independent MCP round trips — neither's result
   * feeds the other — so a stale propose ran them one after another for no reason: up to
   * 15s for the reads, THEN up to another 15s for the snapshot, on top of whatever the
   * scope re-resolution above already cost. On a cold cache (five minutes of reading the
   * card is all it takes — the scope cache and the evidence freshness window both lapse
   * together) that sequential stack was most of what pushed a propose past the browser's
   * 90s budget (15 Sep, D4). Running them together does not change what either reads.
   */
  const observationsTask = reused
    ? Promise.resolve(prior.evidence!.observations)
    : collectStrategyReads(scope, input.mcp, input.signal, now,
        sealedPlan ? [...STRATEGY_READS, ...readsForPlans([sealedPlan], [], now).filter((r) => !STRATEGY_READS.some((s) => s.capability === r.capability && JSON.stringify(s.args) === JSON.stringify(r.args)))] : STRATEGY_READS);
  /**
   * On a stale bundle the floor is the one sealed at investigation (model-anchored to the
   * user's words), not a fresh regex pass over the messages — the regex missed "stays
   * above 1.14" and a 409 followed (13 Sep).
   */
  /**
   * Stale path: the app snapshot is attempted ONCE, bounded — it is the slow, uncancellable
   * read — and the basis is computed from that single attempt. Headroom for the fixed
   * shapes and the position for a composed plan both derive from it; nothing is read twice.
   * Reading it twice, unbounded, took a propose past the browser's 90s (13 Sep).
   */
  const appTask = !reused && scope.smartAccount
    ? interruptible(() => computeMarginSnapshot(scope.smartAccount!), AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]))
      .catch((error) => {
        console.warn("[copilot] propose app snapshot unavailable", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        return null;
      })
    : Promise.resolve(null);
  const [observations, app] = await Promise.all([observationsTask, appTask]);
  let liveBasis: SizingBasis | null = null;
  if (!reused && scope.smartAccount) {
    try {
      // Bounded like the two reads above it: an unbounded contract read here rode on
      // whatever the client's 90s had left, with nothing local to degrade to on a stall.
      liveBasis = await computeSizingBasis(scope.smartAccount, null, { mcp: input.mcp, trader: scope.trader, app },
        AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]));
    } catch (error) {
      console.warn("[copilot] propose sizing basis failed", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }
  const liveFloor = prior.evidence?.floor ?? statedFloorFrom(prior.messages);
  const capacity = reused
    ? prior.evidence!.capacity
    : liveBasis && liveFloor ? capacityFromBasis(liveBasis, liveFloor) : null;
  const requestedBorrow = requestedBorrowFrom(prior.messages, observations, now);
  const comparisons = compareObservedRates(observations, now);
  const idleWalletUsd = idleWalletUsdFrom(observations, now);
  const idleWalletByAssetUsd = idleWalletByAssetUsdFrom(observations, now);
  const idleWalletByAssetTokens = idleWalletByAssetTokensFrom(observations, now);
  const idleOnly = sealedPlan ? !sealedPlan.legs.some((leg) => leg.op === "borrow") : !parsed.traits.borrows;
  /**
   * Same gates as `researchTurn`: an unvalued stated amount must not fall through to
   * sizing-to-the-floor, and a borrow shape still needs the user's floor. Idle supply
   * does not, but it still needs a comparison row — that is how the generator keys assets.
   */
  const candidates = idleOnly
    ? generateCandidates({
        grossCollateralUsd: capacity?.grossCollateralUsd ?? "0",
        debtUsd: capacity?.debtUsd ?? "0",
        floor: capacity?.floor ?? null,
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
  // The basis the plan is sized against: sealed while fresh; the single live basis when stale.
  const planPosition = reused
    ? prior.evidence!.position ?? null
    : liveBasis
      ? { grossCollateralUsd: liveBasis.grossCollateralUsd, debtUsd: liveBasis.debtUsd, floor: liveFloor, issue: liveBasis.issue ? { reason: liveBasis.issue, app: liveBasis.app, contract: liveBasis.contract } : null }
      : null;
  const resolved = sealedPlan
    ? resolvePlans([sealedPlan], {
        scope, observations, now, messages: prior.messages,
        capacity: planPosition,
        // Only shapes that sized under the user's real permission were sealed as proposable.
        borrowing: "allowed", comparisons,
        /**
         * The re-propose here has no fresh model turn — the acceptance was already
         * anchored to the user's own words when the investigation sealed it (service.ts),
         * and compacted onto `evidence.slippageAccepted`. Omitting it here (as before) left
         * `ctx.goal` undefined on every composed-plan approval, so `resolvePlans` refused
         * the exact-output AQUSDC swap a second time even after the user said "I accept
         * the loss" — the sizer and the card never saw the word.
         */
        goal: prior.evidence?.slippageAccepted ? { slippageAccepted: { accepted: true, sourceQuote: "" } } : undefined,
      })
    : null;
  const candidate = resolved
    ? resolved.candidates.find((entry) => entry.id === input.candidateId)
    : candidates?.feasible.find((entry) => entry.id === input.candidateId);
  if (!candidate) {
    // The reason the plan no longer sizes is the fact the user needs; never swallow it.
    const why = resolved?.rejected.map((r) => `${r.leg}: ${r.reason}`).join("; ");
    console.warn("[copilot] proposal candidate no longer resolves", { candidateId: input.candidateId, reused, why: why ?? null });
    throw new ResearchError("candidate_unavailable", why
      ? `That option no longer sizes on the current reads — ${why}. Start a new investigation.`
      : "That option is no longer available at the current rates and position. Start a new investigation.");
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
      slippageAccepted: prior.evidence?.slippageAccepted === true,
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
