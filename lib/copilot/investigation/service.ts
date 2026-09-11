import type { MCPClient } from "../mcp-client";
import type { ResearchModel, InvestigationProgress, InvestigationLimits } from "./types";
import type { ResearchView } from "./view";
import { resolveInvestigationScope, ResearchError } from "./scope";
import { researchCodec } from "./continuation";
import { runInvestigation, interruptible } from "./runtime";
import { strategyReply } from "./answer";
import { normalizeResearchFacts } from "./normalize";
import { compareObservedRates } from "./rate-comparison";
import { computeBorrowCapacity, computeAccountPosition } from "./capacity";
import { SIZING_SOURCES_DISAGREE_WARNING } from "./sizing-copy";
import { generateCandidates, idleWalletUsdFrom, idleWalletByAssetUsdFrom, requestedBorrowFrom } from "./candidates";
import { immediateReply } from "./immediate";
import { compactResearchEvidence } from "./evidence";
import { compileRequestedActions } from "./requested-actions";
import { matchFastPath, fastPathView, healthObservations, priceObservation, parseWithdrawCheck, withdrawObservation, readHealthFastPath } from "./fast-path";
import { detectAutomationGap } from "../conditional-guard";
import { parseStandingOrder, createStandingOrder, evaluateStandingOrders, STANDING_ORDER_OFFER } from "../standing-orders";
import { wouldExceedTokenCap, tokenCapMessage } from "../token-budget";
import { withInvestigationPhase, withInvestigationRun, setSpanAttr } from "../telemetry";

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

export interface ResearchInput {
  message: string;
  wallet: string | null;
  continuation: string | null;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Named eval fixture for traces. Never the user message. */
  promptName?: string;
}

export async function researchTurn(input: ResearchInput, dependencies: {
  subject: string;
  server: string;
  network: string;
  secret: string;
  mcp: Pick<MCPClient, "call">;
  model: ResearchModel;
  signal: AbortSignal;
  onProgress?: (event: InvestigationProgress) => void;
  limits?: Partial<InvestigationLimits>;
}): Promise<ResearchView> {
  return withInvestigationRun(input.promptName, async (span) => {
  const startedAt = Date.now();
  const logPhase = (phase: string, extra: Record<string, unknown> = {}) => {
    console.info("[copilot] investigation phase", { phase, ms: Date.now() - startedAt, ...extra });
  };
  const view = await executeResearchTurn(input, { ...dependencies, logPhase });
  logPhase("turn", { status: view.status });
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  span.setAttribute("vanna.investigation.status", view.status);
  span.setAttribute("vanna.investigation.elapsed_ms", elapsedMs);
  return { ...view, elapsedMs };
  });
}

async function executeResearchTurn(input: ResearchInput, dependencies: {
  subject: string;
  server: string;
  network: string;
  secret: string;
  mcp: Pick<MCPClient, "call">;
  model: ResearchModel;
  signal: AbortSignal;
  onProgress?: (event: InvestigationProgress) => void;
  limits?: Partial<InvestigationLimits>;
  logPhase?: (phase: string, extra?: Record<string, unknown>) => void;
}): Promise<ResearchView> {
  const logPhase = dependencies.logPhase ?? (() => undefined);
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
  const immediate = await immediateReply(input.message, {
    subject: dependencies.subject, signal: dependencies.signal,
  });
  if (immediate) {
    return {
      status: "replied", message: immediate.message,
      originalRequest: input.message, refinements: [], understanding: null, question: null,
      facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
      warnings: [], scope: { wallet: input.wallet, smartAccount: null, network: dependencies.network },
      continuation: "", executionAllowed: false,
    };
  }
  if (wouldExceedTokenCap(dependencies.subject)) {
    return {
      status: "blocked", message: tokenCapMessage(),
      originalRequest: input.message, refinements: [], understanding: null, question: null,
      facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
      warnings: [], scope: { wallet: input.wallet, smartAccount: null, network: dependencies.network },
      continuation: "", executionAllowed: false,
    };
  }
  const fast = input.continuation ? null : matchFastPath(input.message);
  if (fast?.kind === "price") {
    try {
      const publicScope = {
        subject: dependencies.subject, trader: null, smartAccount: null, network: dependencies.network,
      };
      const observation = await interruptible(
        () => priceObservation(fast.asset, publicScope, dependencies.mcp),
        AbortSignal.any([dependencies.signal, AbortSignal.timeout(POSITION_BUDGET_MS)]),
      );
      return fastPathView({
        message: input.message, scope: publicScope, observations: [observation],
        secret: dependencies.secret, server: dependencies.server,
      });
    } catch (error) {
      console.warn("[copilot] investigation price fast-path failed", {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      // Fall through to the investigation loop rather than failing a price question.
    }
  }
  dependencies.onProgress?.({ kind: "scope", label: "Verifying your connected wallet and account" });
  /**
   * Scope resolution runs BEFORE the investigation loop and so is outside its 55s
   * deadline. Two slow MCP reads here could therefore consume the whole route budget and
   * leave the client to time out with no message at all. Bounded explicitly so the loop
   * always gets its own budget, and a stall here reports itself.
   *
   * Inner MCP calls also race this signal, but some fallbacks (on-chain discovery) do
   * not. The outer `interruptible` is what keeps a hung resolve from eating the
   * client's 120s backstop.
   */
  let scope;
  const scopeStarted = Date.now();
  logPhase("scope_start");
  const scopeSignal = AbortSignal.any([dependencies.signal, AbortSignal.timeout(SCOPE_BUDGET_MS)]);
  try {
    scope = await withInvestigationPhase("scope", () => interruptible(
      () => resolveInvestigationScope({
        subject: dependencies.subject, wallet: input.wallet, network: dependencies.network,
      }, dependencies.mcp, scopeSignal),
      scopeSignal,
    ));
    logPhase("scope", { ms: Date.now() - scopeStarted, unverified: scope.unverified ?? null });
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    console.error("[copilot] investigation scope failed", {
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    throw new ResearchError("account_unavailable", "I couldn't read the wallet's margin-account association. Try again when account data is available.");
  }
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
  if (fast?.kind === "health") {
    /**
     * Contract first. The app snapshot is a labelled fallback only — never the blocking
     * path. Waiting on `computeMarginSnapshot` is what turned a health question into the
     * client's 120s abort (11 Sep): the snapshot is a shared unbounded inflight the
     * copilot cannot cancel. MCP `liquidation_snapshot` is one cancellable call.
     */
    const healthStarted = Date.now();
    const observations = await readHealthFastPath({
      scope,
      mcp: scopedMcp,
      signal: dependencies.signal,
      budgetMs: POSITION_BUDGET_MS,
      snapshotFallback: () => computeAccountPosition(scope.smartAccount, dependencies.signal),
    });
    logPhase("health_fast_path", {
      ms: Date.now() - healthStarted,
      source: observations[0]?.capability ?? null,
      status: observations[0]?.status ?? null,
    });
    return fastPathView({
      message: input.message, scope, observations,
      secret: dependencies.secret, server: dependencies.server,
    });
  }
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
  const withdrawAsk = !prior && scope.smartAccount ? parseWithdrawCheck(input.message) : null;
  const positionStarted = Date.now();
  const positionSignal = AbortSignal.any([dependencies.signal, AbortSignal.timeout(POSITION_BUDGET_MS)]);
  const positionTask = interruptible(
    () => computeAccountPosition(scope.smartAccount, positionSignal),
    positionSignal,
  ).then((value) => ({ value, error: null as unknown }), (error) => ({ value: null, error }));
  const withdrawTask = withdrawAsk
    ? interruptible(
        () => withdrawObservation(withdrawAsk.asset, withdrawAsk.amount, scope, scopedMcp),
        AbortSignal.any([dependencies.signal, AbortSignal.timeout(POSITION_BUDGET_MS)]),
      ).then((value) => ({ value, error: null as unknown }), (error) => {
        console.warn("[copilot] investigation withdraw pre-read failed", {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        return { value: null, error };
      })
    : Promise.resolve({ value: null, error: null });
  if (!prior) {
    const parsed = parseStandingOrder(input.message);
    if (parsed && scope.trader) {
      const order = createStandingOrder({
        subject: dependencies.subject, trader: scope.trader, smartAccount: scope.smartAccount,
        trigger: parsed.trigger, action: parsed.action,
      });
      return {
        status: "blocked",
        message: `${STANDING_ORDER_OFFER} Mandate ${order.id} is waiting for an approved plan; nothing is watching yet.`,
        originalRequest: input.message, refinements: [], understanding: null, question: null,
        facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
        warnings: [], scope: { wallet: scope.trader, smartAccount: scope.smartAccount, network: scope.network },
        continuation: "", executionAllowed: false,
      };
    }
    const gap = detectAutomationGap(input.message, true);
    if (gap?.kind === "standing_order") {
      return {
        status: "blocked", message: gap.message,
        originalRequest: input.message, refinements: [], understanding: null, question: null,
        facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
        warnings: [], scope: { wallet: scope.trader, smartAccount: scope.smartAccount, network: scope.network },
        continuation: "", executionAllowed: false,
      };
    }
  }
  const withdrawResult = await withdrawTask;
  const withdrawObs = withdrawResult.value;
  if (withdrawAsk) {
    logPhase("withdraw_preread", {
      ms: Date.now() - positionStarted,
      status: withdrawObs?.status ?? "skipped",
    });
  }
  if (withdrawAsk && withdrawObs && withdrawObs.status === "ok") {
    const positionResult = await positionTask;
    position = positionResult.value;
    return fastPathView({
      message: input.message, scope,
      observations: [
        ...(position ? healthObservations(position) : []),
        { ...withdrawObs, id: position ? "e1" : "e0" },
      ],
      secret: dependencies.secret, server: dependencies.server,
    });
  }
  /**
   * The planner's first turn can compile a fully specified write with no account
   * snapshot. Waiting on the snapshot here is what turned "repay 1 XLM" into a 40s
   * research loop. Seed it only after we know we still need ranking.
   */
  const loopStarted = Date.now();
  const result = await withInvestigationPhase("loop", () => runInvestigation({
    message: input.message, scope, seed: [],
    history: (input.history ?? []).slice(-8),
    task: { messages, lastQuestion: prior?.lastQuestion ?? null },
    promptName: input.promptName,
  }, { model: dependencies.model, mcp: scopedMcp, signal: dependencies.signal, onProgress: dependencies.onProgress, limits: dependencies.limits }));
  logPhase("loop", {
    ms: Date.now() - loopStarted,
    outcome: result.outcome.kind,
    modelTurns: result.usage.modelTurns,
    toolCalls: result.usage.toolCalls,
    loopElapsedMs: result.usage.elapsedMs,
  });
  const outcome = result.outcome;
  if (outcome.kind === "research_complete") {
    const compiledQuestion = outcome.openQuestions[0] ?? null;
    const earlySteps = !compiledQuestion ? compileRequestedActions(outcome.goal, messages, scope) : [];
    if (earlySteps.length) {
      const evidence = compactResearchEvidence(result.observations, null, Date.now());
      evidence.requestedSteps = earlySteps;
      evidence.allowedCandidateIds = ["requested_actions"];
      logPhase("compiled_write", { steps: earlySteps.length, op: earlySteps[0]?.op });
      return {
        status: "researched",
        message: strategyReply({
          status: "researched", facts: [], candidates: null, capacity: null, question: null,
          intent: "strategy", originalRequest: messages[0], statedSteps: earlySteps,
        }),
        originalRequest: messages[0], refinements: messages.slice(1), question: null,
        proposalCandidateId: "requested_actions",
        understanding: outcome.goal, facts: [], capacity: null, candidates: null, rateComparisons: [],
        checks: result.observations.map((observation) => ({
          id: observation.id, label: observation.capability.replaceAll("_", " "),
          status: observation.status, readAt: observation.observedAt,
        })),
        warnings: [],
        scope: { wallet: scope.trader, smartAccount: scope.smartAccount, network: scope.network },
        continuation: codec.seal(scope, messages, null, evidence), executionAllowed: false,
      };
    }
  }
  const [positionResult] = await withInvestigationPhase("position", () =>
    Promise.all([positionTask]));
  if (positionResult.error) {
    console.warn("[copilot] investigation position seed failed", {
      error: positionResult.error instanceof Error
        ? { name: positionResult.error.name, message: positionResult.error.message }
        : String(positionResult.error),
    });
  }
  position = positionResult.value;
  const positionMs = Date.now() - positionStarted;
  setSpanAttr("vanna.position.ms", positionMs);
  setSpanAttr("vanna.position.seeded", !!position);
  logPhase("position", { ms: positionMs, seeded: !!position });
  if (position) {
    try {
      evaluateStandingOrders({
        liveFor: (order) => ({
          healthFactor: order.trigger.kind === "health_factor" && position.healthFactor
            ? Number(position.healthFactor) : null,
          priceUsd: null,
        }),
      });
    } catch (error) {
      console.warn("[copilot] standing order evaluation failed", {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
    }
  }
  /**
   * Headroom reuses the snapshot the position read already paid for. Both need the same
   * figures, and `computeMarginSnapshot` is a 5-7s live RPC call — buying it twice per turn
   * was on its own enough to push past the route deadline. With the snapshot shared this is
   * pure arithmetic; without it (position timed out) it still overlaps the loop under its
   * own bound rather than adding latency after it.
   */
  const capacityTask = interruptible(
    () => computeBorrowCapacity(
      scope.smartAccount, messages, dependencies.signal, position?.snapshot ?? null,
      { mcp: scopedMcp, trader: scope.trader },
    ),
    AbortSignal.any([dependencies.signal, AbortSignal.timeout(CAPACITY_BUDGET_MS)]))
    .then(value => ({ value, failed: false as const, reason: null as string | null }), (error) => ({
      value: null, failed: true as const,
      reason: error instanceof Error ? error.message : "unavailable",
    }));
  const { facts, warnings } = normalizeResearchFacts(result.observations);
  /**
   * Deterministic headroom, from the contract liquidation_snapshot once it agrees
   * with the app snapshot. Display still uses the snapshot; a material drift
   * refuses to quote a size rather than silently preferring either source.
   */
  const capacityResult = await capacityTask;
  let capacity = capacityResult.value;
  if (prior && outcome.kind === "research_complete" && outcome.goal.relation === "new") {
    messages = [input.message];
    // Never carry the previous task's floor or amount into an unrelated new goal.
    try {
      capacity = position?.snapshot
        ? await computeBorrowCapacity(
          scope.smartAccount, messages, dependencies.signal, position.snapshot,
          { mcp: scopedMcp, trader: scope.trader },
        )
        : null;
    } catch (error) {
      console.warn("[copilot] investigation capacity refresh failed", {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      capacity = null;
      if (!capacityResult.failed && error instanceof Error && error.message === "sizing_sources_disagree") {
        warnings.push(SIZING_SOURCES_DISAGREE_WARNING);
      }
    }
  }
  if (capacityResult.failed) {
    // Only a genuine FAILURE is worth saying. "No floor was stated" is not a failure, and
    // warning about it read as "your position could not be read", which is a false claim.
    warnings.push(
      capacityResult.reason === "sizing_sources_disagree"
        ? SIZING_SOURCES_DISAGREE_WARNING
        : "Borrowing headroom could not be computed from your current position.",
    );
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
  let candidates = null;
  try {
    candidates = outcome.kind === "research_complete" && outcome.goal.intent === "strategy" && rateComparisons.length && requestedBorrow?.usd !== null
      ? generateCandidates({
          grossCollateralUsd: capacity?.grossCollateralUsd ?? "0",
          debtUsd: capacity?.debtUsd ?? "0",
          floor: capacity?.floor ?? "1.30",
          idleWalletUsd: idleWalletUsdFrom(result.observations, observedNow),
          idleWalletByAssetUsd: idleWalletByAssetUsdFrom(result.observations, observedNow),
          // A failed capacity (dropped-leg debt, sources disagree) must not
          // invent headroom from $0 / a default 1.30 floor.
          borrowingAllowed: Boolean(capacity) && !capacityResult.failed && borrowing !== "forbidden",
          requestedBorrowUsd:
            capacity && !capacityResult.failed ? (requestedBorrow?.usd ?? null) : null,
          comparisons: rateComparisons,
        })
      : null;
  } catch (error) {
    console.error("[copilot] investigation candidate ranking failed", {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    warnings.push("Strategy options could not be ranked from the reads that completed.");
  }
  if (outcome.kind === "research_complete" && outcome.goal.constraints.some((constraint) => /time budget ran out/i.test(constraint))) {
    warnings.push("The investigation ran out of time. Ranked options use only the reads that finished.");
  }
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
  const requestedSteps = outcome.kind === "research_complete" && !question
    ? compileRequestedActions(outcome.goal, messages, scope) : [];
  const message = strategyReply({
    status, facts, candidates: requestedSteps.length ? null : candidates, capacity, question,
    intent: outcome.kind === "research_complete" ? outcome.goal.intent : undefined,
    findings: outcome.kind === "research_complete" ? outcome.findings : undefined,
    originalRequest: messages[0],
    statedSteps: requestedSteps,
  });
  if (scope.unverified === "bindings") {
    warnings.push("I couldn't verify the wallet link this turn, so I did not load your margin account. Ask again in a moment.");
  } else if (!scope.trader) {
    warnings.push("No verified wallet is connected. Only public market information was available.");
  } else if (!scope.smartAccount) {
    warnings.push("No active margin account was discovered for this wallet.");
  }
  if (outcome.kind === "stopped") warnings.push(outcome.reason === "model_unavailable"
    ? "The language model was unavailable. No keyword plan was substituted."
    : `Research stopped: ${outcome.reason.replaceAll("_", " ")}.`);
  const evidence = compactResearchEvidence(result.observations, capacity, observedNow);
  evidence.allowedCandidateIds = outcome.kind === "research_complete" && !question
    ? candidates?.feasible.map(candidate => candidate.id) ?? [] : [];
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
