import type { MCPClient } from "../mcp-client";
import type { ResearchModel, InvestigationProgress } from "./types";
import type { ResearchView } from "./view";
import { resolveInvestigationScope, ResearchError } from "./scope";
import { researchCodec } from "./continuation";
import { runInvestigation, interruptible } from "./runtime";
import { strategyReply } from "./answer";
import { normalizeResearchFacts } from "./normalize";
import { compareObservedRates } from "./rate-comparison";
import { computeBorrowCapacity, computeAccountPosition } from "./capacity";
import { generateCandidates, idleWalletUsdFrom, idleWalletByAssetUsdFrom, requestedBorrowFrom } from "./candidates";
import { immediateReply } from "./immediate";
import { compactResearchEvidence } from "./evidence";
import { compileRequestedActions } from "./requested-actions";

/**
 * The three budgets that run OUTSIDE the investigation loop's own deadline, named so
 * `investigation-timeout-budget.test.ts` can assert the whole chain rather than the two
 * timers that happened to be greppable. Scope resolution and the position read both block
 * the loop, so their time is the route's time.
 */
export const SCOPE_BUDGET_MS = 20_000;
/**
 * The position read is a live RPC snapshot, measured at 5-7s and occasionally far worse
 * (the app's own analytics endpoint was seen taking 100s+ against the same node). It was
 * awaited with NO bound, so one slow snapshot spent the route's whole 75s and the user got
 * "the connection closed before the investigation finished". On timeout the turn proceeds
 * without the seed: the model then reads the figures from MCP, which is slower and can come
 * back without a scalar health factor, but it is a working turn rather than a dead one.
 */
export const POSITION_BUDGET_MS = 8_000;
export const CAPACITY_BUDGET_MS = 15_000;

export interface ResearchInput { message: string; wallet: string | null; continuation: string | null }

export async function researchTurn(input: ResearchInput, dependencies: {
  subject: string;
  server: string;
  network: string;
  secret: string;
  mcp: Pick<MCPClient, "call">;
  model: ResearchModel;
  signal: AbortSignal;
  onProgress?: (event: InvestigationProgress) => void;
}): Promise<ResearchView> {
  const codec = researchCodec(dependencies.secret, dependencies.server);
  /**
   * Answer before spending anything, when there is nothing to investigate. This runs ahead
   * of scope resolution as well as the model: "hi" was costing two MCP reads for the wallet
   * lookup, several model turns and five more reads before printing what it had checked.
   *
   * A continuation is deliberately empty. There is no investigation to resume, and sealing
   * one would need the scope resolution this exists to skip; the client treats an empty
   * continuation as "no thread", which is correct here.
   */
  const immediate = immediateReply(input.message);
  if (immediate) {
    return {
      status: "replied", message: immediate.message,
      originalRequest: input.message, refinements: [], understanding: null, question: null,
      facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
      warnings: [], scope: { wallet: input.wallet, smartAccount: null, network: dependencies.network },
      continuation: "", executionAllowed: false,
    };
  }
  dependencies.onProgress?.({ kind: "scope", label: "Verifying your connected wallet and account" });
  /**
   * Scope resolution runs BEFORE the investigation loop and so is outside its 55s
   * deadline. Two slow MCP reads here could therefore consume the whole route budget and
   * leave the client to time out with no message at all. Bounded explicitly so the loop
   * always gets its own budget, and a stall here reports itself.
   */
  const scope = await resolveInvestigationScope({
    subject: dependencies.subject, wallet: input.wallet, network: dependencies.network,
  }, dependencies.mcp, AbortSignal.any([dependencies.signal, AbortSignal.timeout(SCOPE_BUDGET_MS)]));
  const prior = input.continuation ? codec.open(input.continuation, scope) : null;
  let messages = [...prior?.messages ?? [], input.message];
  // Validate capacity before paying for any model call. Never truncate an older constraint.
  codec.seal(scope, messages, prior?.lastQuestion ?? null);
  const scopedMcp: Pick<MCPClient, "call"> = { call: async (tool, args, userId) => {
    const data = await dependencies.mcp.call(tool, args, userId);
    if ((typeof data.smart_account === "string" && data.smart_account !== scope.smartAccount) ||
      [data.wallet_address, data.g_address].some((address) => typeof address === "string" && address !== scope.trader)) {
      throw new ResearchError("response_scope_mismatch", "An account read returned a different identity.");
    }
    return data;
  } };
  /**
   * The authoritative position, read BEFORE the loop and handed to the model as evidence.
   *
   * Two problems this solves at once. Measured live on "what's my health factor?": MCP's
   * `account_health` returned debt positions but no scalar ratio, so the card said "account
   * health: data was unavailable" beside a rail showing 2.43 — computed from this very
   * snapshot. And the model spent five reads and several turns fetching collateral, debt and
   * health that the app already had, which is most of why one health question took half a
   * minute. Refusing to invent the number was right; not reaching for the one the product
   * computes was not.
   *
   * Same source as the Margin page (owner decision: dev is authoritative), so the copilot
   * and the rest of the product cannot show different numbers.
   */
  let position: Awaited<ReturnType<typeof computeAccountPosition>> = null;
  try {
    position = await interruptible(() => computeAccountPosition(scope.smartAccount, dependencies.signal),
      AbortSignal.any([dependencies.signal, AbortSignal.timeout(POSITION_BUDGET_MS)]));
  } catch {
    // Left null. `capacity` below reports a genuine snapshot failure once, not twice.
  }
  /**
   * Headroom reuses the snapshot the position read already paid for. Both need the same
   * figures, and `computeMarginSnapshot` is a 5-7s live RPC call — buying it twice per turn
   * was on its own enough to push past the route deadline. With the snapshot shared this is
   * pure arithmetic; without it (position timed out) it still overlaps the loop under its
   * own bound rather than adding latency after it.
   */
  const capacityTask = interruptible(
    () => computeBorrowCapacity(scope.smartAccount, messages, dependencies.signal, position?.snapshot ?? null),
    AbortSignal.any([dependencies.signal, AbortSignal.timeout(CAPACITY_BUDGET_MS)]))
    .then(value => ({ value, failed: false }), () => ({ value: null, failed: true }));
  const seed = position ? [{
    id: "e0", capability: "account_position", args: {}, observedAt: Date.now(), status: "ok" as const,
    data: {
      collateral_usd: position.grossCollateralUsd,
      debt_usd: position.debtUsd,
      ...(position.healthFactor ? { health_factor: position.healthFactor } : {}),
      source: "vanna_app_margin_snapshot",
    },
  }] : [];
  const result = await runInvestigation({
    message: input.message, scope, seed,
    task: { messages, lastQuestion: prior?.lastQuestion ?? null },
  }, { model: dependencies.model, mcp: scopedMcp, signal: dependencies.signal, onProgress: dependencies.onProgress });
  const { facts, warnings } = normalizeResearchFacts(result.observations);
  const outcome = result.outcome;
  /**
   * Deterministic headroom, from the app's authoritative snapshot rather than the MCP
   * `account_health` figure — the two disagree (measured 4,219.36 vs 3,164.34) and only
   * the app's gross-assets base is the one dev computes and the owner confirmed.
   */
  const capacityResult = await capacityTask;
  let capacity = capacityResult.value;
  if (prior && outcome.kind === "research_complete" && outcome.goal.relation === "new") {
    messages = [input.message];
    // Never carry the previous task's floor or amount into an unrelated new goal.
    capacity = position?.snapshot ? await computeBorrowCapacity(scope.smartAccount, messages, dependencies.signal, position.snapshot) : null;
  }
  if (capacityResult.failed) {
    // Only a genuine FAILURE is worth saying. "No floor was stated" is not a failure, and
    // warning about it read as "your position could not be read", which is a false claim.
    warnings.push("Borrowing headroom could not be computed from your current position.");
  }
  const rateComparisons = compareObservedRates(result.observations, Date.now());
  /**
   * Options, generated from the evidence rather than proposed by the model. Only offered
   * when the user actually stated a floor: sizing a borrow needs one, and inventing a
   * default would fabricate the calculation's most important input.
   */
  const observedNow = Date.now();
  /**
   * An amount the user named outright is honoured as stated, never re-sized to the floor.
   * When it cannot be valued from a price read this turn, NO options are offered: sizing to
   * the floor would answer a question they did not ask, and quietly substituting a larger
   * number than the one they gave is the worst outcome available here.
   */
  const requestedBorrow = requestedBorrowFrom(messages, result.observations, observedNow);
  if (requestedBorrow && requestedBorrow.usd === null) warnings.push(
    `You asked to borrow ${requestedBorrow.tokens} ${requestedBorrow.asset}, but no ${requestedBorrow.asset} price was read, so that amount could not be checked against your floor.`);
  /**
   * Permission to borrow is not an instruction to borrow. "Unspecified" still offers
   * both the idle path and a levered path — the owner prompt says the copilot may take
   * new loans. Only an explicit prohibition suppresses borrow shapes.
   */
  const borrowing = outcome.kind === "research_complete" ? outcome.goal.borrowing : "unspecified";
  const candidates = outcome.kind === "research_complete" && outcome.goal.intent === "strategy" && rateComparisons.length && requestedBorrow?.usd !== null
    ? generateCandidates({
        grossCollateralUsd: capacity?.grossCollateralUsd ?? "0",
        debtUsd: capacity?.debtUsd ?? "0",
        floor: capacity?.floor ?? "1.30",
        idleWalletUsd: idleWalletUsdFrom(result.observations, observedNow),
        idleWalletByAssetUsd: idleWalletByAssetUsdFrom(result.observations, observedNow),
        borrowingAllowed: Boolean(capacity) && borrowing !== "forbidden",
        requestedBorrowUsd: requestedBorrow?.usd ?? null,
        comparisons: rateComparisons,
      })
    : null;
  let question = outcome.kind === "clarify" ? outcome.question
    : outcome.kind === "research_complete" ? outcome.openQuestions[0] ?? null : null;
  // Venue, pair and "how much" are decided by ranking to the stated floor. Asking them
  // after that ranking exists is the failure the research prompt already forbids.
  if (question && candidates?.feasible.length && decidedWithoutUser(question)) question = null;
  const status: ResearchView["status"] = outcome.kind === "blocked" ? "blocked"
    : question ? "needs_input"
      : candidates?.feasible.length || outcome.kind === "research_complete" ? "researched"
        : outcome.kind === "stopped" ? "incomplete"
          : "needs_input";
  const message = strategyReply({ status, facts, candidates, capacity, question });
  if (!scope.trader) warnings.push("No verified wallet is connected. Only public market information was available.");
  else if (!scope.smartAccount) warnings.push("No active margin account was discovered for this wallet.");
  if (outcome.kind === "stopped") warnings.push(outcome.reason === "model_unavailable"
    ? "The language model was unavailable. No keyword plan was substituted."
    : `Research stopped: ${outcome.reason.replaceAll("_", " ")}.`);
  const evidence = compactResearchEvidence(result.observations, capacity, observedNow);
  evidence.allowedCandidateIds = outcome.kind === "research_complete" && !question
    ? candidates?.feasible.map(candidate => candidate.id) ?? [] : [];
  const requestedSteps = outcome.kind === "research_complete" && !question ? compileRequestedActions(outcome.goal, messages, scope) : [];
  if (requestedSteps.length) {
    evidence.requestedSteps = requestedSteps;
    evidence.allowedCandidateIds = ["requested_actions"];
  }
  return {
    status, message, originalRequest: messages[0], refinements: messages.slice(1), question,
    proposalCandidateId: requestedSteps.length ? "requested_actions" : candidates?.feasible[0]?.id ?? null,
    // The goal restatement is the user's own request echoed back, not a financial claim,
    // so it is publishable while findings prose is not.
    understanding: outcome.kind === "research_complete" ? outcome.goal
      : candidates?.feasible.length
        ? {
            objective: messages[0],
            constraints: capacity ? [`Health factor at or above ${capacity.floor}`] : [],
            borrowing,
          }
        : null,
    facts, capacity, candidates: requestedSteps.length ? null : candidates, rateComparisons, checks: result.observations.map((observation) => ({
      id: observation.id, label: observation.capability.replaceAll("_", " "), status: observation.status, readAt: observation.observedAt,
    })), warnings, scope: { wallet: scope.trader, smartAccount: scope.smartAccount, network: scope.network },
    continuation: codec.seal(scope, messages, question, evidence), executionAllowed: false,
  };
}

function decidedWithoutUser(question: string): boolean {
  return /how much|budget|allocat|which (venue|pool|market)|spot or farm|earn or farm|which usdc/i.test(question);
}
