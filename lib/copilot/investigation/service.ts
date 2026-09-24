import type { MCPClient } from "../mcp-client";
import type { ResearchModel, InvestigationProgress, InvestigationLimits, Observation } from "./types";
import { StrKey } from "@stellar/stellar-sdk";
import { MarginAccountService } from "@/lib/margin-utils";
import type { ResearchView } from "./view";
import { resolveInvestigationScope, ResearchError } from "./scope";
import { researchCodec } from "./continuation";
import { boundedLimits, runInvestigation, interruptible } from "./runtime";
import { strategyReply } from "./answer";
import { normalizeResearchFacts } from "./normalize";
import { analyseObservedRates } from "./rate-comparison";
import { computeBorrowCapacity, computeAccountPosition, computeSizingBasis } from "./capacity";
import { anchoredGoalFloor, anchoredPlanParts, anchoredSlippageAccepted, anchoredWalletReserves, statedCeilingFrom, statedFloorFrom } from "./floor";
import { SIZING_SOURCES_DISAGREE_WARNING, unpostedCollateralNote } from "./sizing-copy";
import { generateCandidates, idleWalletAfterReserves, onlyNamedAssets, idleWalletUsdFrom, idleWalletByAssetUsdFrom, idleWalletByAssetTokensFrom, mergeCandidateSets, plansBorrow, rankingBorrowing, requestedBorrowFrom, type CandidateSet } from "./candidates";
import { REQUESTED_ACTIONS_ID } from "./candidate-id";
import { capToOneApproval, joinPlanParts, planCandidateId, resolveJoinedOrParts, unchosenUsdcVariant, USDC_QUESTION, planFromStatedActions, resolvePlans, shareSameOpLiteralActions, verbOf, withBoughtAsset, withSharedLiteralAmount } from "./plan";
import { touchesMarginAccount } from "../workflow/types";
import { actionsFromAnswers, answerProblem, buildQuestionnaireSet, readsForQuestionnaire } from "./questionnaire";
import { simulateCandidates } from "./simulate";
import { immediateReply } from "./immediate";
import { compactResearchEvidence, reusableObservations } from "./evidence";
import { appendDiagnostics } from "./diagnostics-log";
import type { ResearchConversation } from "./continuation";
import { collectStrategyReads, looksLikeStatedWrite, needsMarketSeed, readsForPlans, type StrategyRead } from "./strategy-reads";
import { matchFastPath, fastPathView, healthObservations, priceObservation, parseWithdrawCheck, withdrawObservation, readHealthFastPath } from "./fast-path";
import { detectAutomationGap, futureConditionRefusal } from "../conditional-guard";
import { parseStandingOrder, createStandingOrder, evaluateStandingOrders, STANDING_ORDER_OFFER } from "../standing-orders";
import { resolveLifecycleWrite } from "../workflow/lifecycle";
import { wouldExceedTokenCap, tokenCapMessage } from "../token-budget";
import { withInvestigationPhase, withInvestigationRun, setSpanAttr } from "../telemetry";
import { ASSET_SYMBOL_PATTERN, lpPairs, poolVenueFor, resolveAssetDef } from "../registry/assets";
import { WORKFLOW_OPS } from "../workflow/types";
import { MAX_WORKFLOW_STEPS } from "../workflow/journal";

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
  /**
   * Last sealed conversation, used only for evidence when `continuation` is
   * absent. Never inherits the prior objective, question, or approval binding.
   */
  session?: string | null;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** The conversation this turn belongs to; absent on the first turn of a new chat. */
  conversationId?: string | null;
  /** Named eval fixture for traces. Never the user message. */
  promptName?: string;
  /** Structured questionnaire answers. Validated against the issued options. No model call. */
  answers?: import("./view").QuestionnaireAnswers;
}

function optionalConversation(
  codec: ReturnType<typeof researchCodec>,
  token: string | null | undefined,
  scope: Parameters<ReturnType<typeof researchCodec>["open"]>[1],
): ResearchConversation | null {
  if (!token) return null;
  try {
    return codec.open(token, scope);
  } catch (error) {
    if (error instanceof ResearchError && (error.code === "context_expired" || error.code === "context_full")) {
      return null;
    }
    throw error;
  }
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
  const immediate = input.continuation
    ? null
    : await immediateReply(input.message, {
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
  if (!scope.trader && input.wallet) {
    /**
     * Navbar sent a G-address this request could not bind. Guest/public is not a
     * fallback runner for Earn — the bound investigation is. Stop here so the
     * card cannot dump oracle rows and call that a plan.
     */
    return reconnectWalletView(input, dependencies.network, scope.unverified === "bindings" ? "bindings" : "session");
  }
  const prior = input.continuation ? codec.open(input.continuation, scope) : null;
  if (input.answers) {
    const problem = answerProblem(prior?.evidence?.questionnaire, input.answers);
    if (problem) throw new ResearchError("invalid_answers", problem, 400);
  }
  const session = prior ? null : optionalConversation(codec, input.session, scope);
  const carried = prior?.evidence ?? session?.evidence;
  /**
   * Carried reads seed the investigation only if they are still fresh when it ENDS. 23 Sep,
   * "aquarius lp": the reads were 54s old at the start, the turn took 23s, and the finish-time
   * freshness check refused them at 71-77s, voiding the whole run ("could not be completed
   * from the reads it made"). Checking at start + the loop's own budget re-reads instead.
   * The instant health answer runs no loop, so it keeps the at-start check.
   */
  const carriedNow = reusableObservations(carried, Date.now());
  const carriedObs = reusableObservations(carried, Date.now() + boundedLimits(dependencies.limits).maxDurationMs);
  const haveCarriedPosition = carriedObs.some(
    (observation) => observation.capability === "account_position" && observation.status === "ok",
  );
  let messages = [...prior?.messages ?? [], input.answers?.summary ?? input.message];
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
    const fromCarry = carriedNow.filter((observation) =>
      (observation.capability === "account_position" || observation.capability === "account_health")
      && observation.status === "ok");
    if (fromCarry.length) {
      logPhase("health_fast_path", { ms: 0, source: "carried_evidence", status: "ok" });
      return fastPathView({
        message: input.message, scope, observations: fromCarry,
        secret: dependencies.secret, server: dependencies.server,
      });
    }
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
  const positionTask = haveCarriedPosition
    ? Promise.resolve({ value: null as Awaited<ReturnType<typeof computeAccountPosition>>, error: null as unknown })
    : interruptible(
        () => computeAccountPosition(scope.smartAccount, positionSignal),
        positionSignal,
      ).then((value) => ({ value, error: null as unknown }), (error) => ({ value: null, error }));
  const namedAssets = [...new Set([...input.message.matchAll(new RegExp(ASSET_SYMBOL_PATTERN.source, "gi"))]
    .map((match) => resolveAssetDef(match[0])?.id).filter((id): id is NonNullable<typeof id> => !!id))];
  const explicitOp = new RegExp(`\\b(?:${WORKFLOW_OPS.map((op) => op.replaceAll("_", " ")).join("|")})\\b`, "i").test(input.message);
  // Whichever venue trades the named pair — a Soroswap swap needs its pool's numbers
  // just as much as an Aquarius one, and seeding only Aquarius left Soroswap on the
  // oracle quote (see strategy-reads.ts).
  const namedPair = lpPairs().find((pair) => pair.tokens.every((token) => namedAssets.includes(token)));
  const poolAsset = namedPair?.tokens[1];
  const poolCapability = namedPair?.venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves";
  const poolOp = /\b(?:swap|add liquidity|remove liquidity)\b/i.test(input.message);
  const evidenceSeedRequests: StrategyRead[] = explicitOp && !needsMarketSeed(input.message)
    ? [
        ...namedAssets.map((asset) => ({ capability: "asset_price", args: { asset } })),
        ...(poolOp && poolAsset ? [{ capability: poolCapability, args: { asset: poolAsset } }] : []),
        ...(poolOp && scope.trader && scope.smartAccount ? [{ capability: "wallet_balances", args: {} }] : []),
      ].filter((request) => !carriedObs.some((observation) => observation.capability === request.capability
        && observation.status === "ok" && observation.args.asset === ("asset" in request.args ? request.args.asset : undefined)
        && Date.now() - observation.observedAt <= 60_000))
    : [];
  const evidenceSeedTask = evidenceSeedRequests.length
    ? collectStrategyReads(scope, scopedMcp,
        AbortSignal.any([dependencies.signal, AbortSignal.timeout(15_000)]),
        Date.now(), evidenceSeedRequests, "w")
    : Promise.resolve([]);
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
   * research loop. Seed ranking evidence only when this is not a stated write.
   */
  const statedWrite = looksLikeStatedWrite(input.message);
  const seedMarkets = needsMarketSeed(input.message);
  let seed: Awaited<ReturnType<typeof healthObservations>> = [...carriedObs];
  let positionAwaited = haveCarriedPosition;
  const haveCarriedMarkets = carriedObs.some((observation) =>
    (observation.capability === "earn_market" || observation.capability === "blend_markets"
      || observation.capability === "wallet_balances") && observation.status === "ok");
  if (!statedWrite && seedMarkets && !(haveCarriedPosition && haveCarriedMarkets)) {
    const marketSignal = AbortSignal.any([dependencies.signal, AbortSignal.timeout(12_000)]);
    const [pos, markets] = await withInvestigationPhase("position", () => Promise.all([
      positionTask,
      collectStrategyReads(scope, scopedMcp, marketSignal, Date.now()).catch((error) => {
        console.warn("[copilot] investigation market seed failed", {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        return [];
      }),
    ]));
    if (pos.error) {
      console.warn("[copilot] investigation position seed failed", {
        error: pos.error instanceof Error
          ? { name: pos.error.name, message: pos.error.message }
          : String(pos.error),
      });
    }
    position = pos.value;
    positionAwaited = true;
    const positionMs = Date.now() - positionStarted;
    setSpanAttr("vanna.position.ms", positionMs);
    setSpanAttr("vanna.position.seeded", !!position || haveCarriedPosition);
    logPhase("position", { ms: positionMs, seeded: !!position || haveCarriedPosition, markets: markets.length });
    seed = [
      ...carriedObs,
      ...(position ? healthObservations(position) : []),
      ...markets,
    ];
  } else if (haveCarriedPosition) {
    logPhase("position", { ms: 0, seeded: true, source: "carried_evidence" });
  }
  const evidenceSeed = await evidenceSeedTask;
  if (evidenceSeed.length) {
    seed.push(...evidenceSeed);
    logPhase("evidence_seed", { requested: evidenceSeedRequests.map((request) => `${request.capability}:${request.args.asset ?? ""}`), ok: evidenceSeed.filter((observation) => observation.status === "ok").length });
  }
  const loopStarted = Date.now();
  const answered = input.answers && prior?.evidence?.questionnaire
    ? actionsFromAnswers(prior.evidence.questionnaire, input.answers) : null;
  const result = answered
    ? await (async () => {
        const draft = planFromStatedActions(answered, input.answers!.summary);
        const now = Date.now();
        const needed = readsForPlans(draft ? [draft] : [], seed, now);
        const fresh = needed.length
          ? await collectStrategyReads(scope, scopedMcp, dependencies.signal, now, needed, "qa") : [];
        return {
          outcome: {
            kind: "research_complete" as const,
            goal: {
              intent: "strategy" as const,
              objective: input.answers!.summary,
              constraints: [] as string[],
              borrowing: "unspecified" as const,
              actions: answered,
            },
            findings: [{ summary: input.answers!.summary, evidenceIds: [] as string[] }],
            openQuestions: [] as string[],
          },
          observations: [...seed, ...fresh],
          usage: { modelTurns: 0, toolCalls: fresh.length, elapsedMs: 0 },
          executionAllowed: false as const,
        } as Awaited<ReturnType<typeof runInvestigation>>;
      })()
    : await withInvestigationPhase("loop", () => runInvestigation({
      message: input.message, scope, seed,
      history: (input.history ?? []).slice(-8),
      task: { messages, lastQuestion: prior?.lastQuestion ?? null },
      promptName: input.promptName,
    }, { model: dependencies.model, mcp: scopedMcp, signal: dependencies.signal, onProgress: dependencies.onProgress, limits: dependencies.limits }));
  logPhase("loop", {
    ms: Date.now() - loopStarted,
    outcome: result.outcome.kind,
    // WHY it stopped is the whole diagnosis — "stopped" alone sent a live 15 Sep failure
    // ("deploy my XLM in farm") to the generic timeout copy while the loop had actually
    // ended after one model turn and no tool calls at all.
    ...(result.outcome.kind === "stopped" ? { reason: result.outcome.reason } : {}),
    modelTurns: result.usage.modelTurns,
    toolCalls: result.usage.toolCalls,
    loopElapsedMs: result.usage.elapsedMs,
  });
  const outcome = result.outcome;
  if (outcome.kind === "clarify" && outcome.missing?.length) {
    const questionnaireNow = Date.now();
    const needed = outcome.missing.flatMap((entry) => readsForQuestionnaire(entry, result.observations, questionnaireNow, messages));
    if (needed.length) {
      const batch = await collectStrategyReads(scope, scopedMcp, dependencies.signal, questionnaireNow, needed, "qn");
      result.observations.push(...batch);
    }
  }
  const droppedMissingAccountActions = !scope.smartAccount && outcome.kind === "clarify" && outcome.missing
    ? outcome.missing.filter((entry) => entry.op && touchesMarginAccount(entry.op))
    : [];
  const questionnaire = outcome.kind === "clarify" && outcome.missing?.length
    ? buildQuestionnaireSet(outcome.missing, result.observations, Date.now(), messages, outcome.actions ?? [], Boolean(scope.smartAccount)) ?? undefined
    : undefined;
  /**
   * Borrow ranking is enabled by the typed goal/plan, not by re-reading the user's
   * wording. A required borrow (or a composed/stated borrow leg) needs a live capacity
   * object even when the user did not provide a floor; capacity.ts applies the
   * configured safety buffer and records that provenance on the object.
   */
  const borrowing = rankingBorrowing(
    outcome.kind === "research_complete" ? outcome.goal.borrowing : "unspecified",
    outcome.kind === "research_complete" ? outcome.goal.actions : undefined,
  );
  const needsBorrowCapacity = borrowing === "required" ||
    (outcome.kind === "research_complete" && plansBorrow(outcome.plans));
  const capacityMessages = prior && outcome.kind === "research_complete" && outcome.goal.relation === "new"
    ? [input.message]
    : messages;
  const goalFloor = outcome.kind === "research_complete" ? anchoredGoalFloor(outcome.goal, capacityMessages) : null;
  const capacityOptions = {
    mcp: scopedMcp,
    trader: scope.trader,
    ...(needsBorrowCapacity
      ? { floor: goalFloor, useConfiguredFloor: true }
      : {}),
  };
  /**
   * Stated actions ("repay 1 XLM") do NOT short-cut to steps here. They join the plans
   * below and are sized, funded, precision-cut and simulated like every other plan; the
   * shortcut that used to live here is what offered "lend 1 xlm" from a wallet with
   * nothing spendable (14 Sep).
   */
  if (!positionAwaited) {
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
  }
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
      scope.smartAccount, capacityMessages, dependencies.signal, position?.snapshot ?? null,
      capacityOptions,
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
          scope.smartAccount, capacityMessages, dependencies.signal, position.snapshot,
          capacityOptions,
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
  const rateAnalysis = analyseObservedRates(result.observations, Date.now());
  const rateComparisons = rateAnalysis.comparisons;
  // A rate that was read but not used must be visible, or the prose (which saw the raw
  // read) and the ranked options (which did not) will disagree with no explanation.
  for (const dropped of rateAnalysis.excluded) warnings.push(dropped.detail);
  /**
   * Options, generated from the evidence rather than proposed by the model. Borrowing
   * goals may use the configured safety floor; its provenance is carried by `capacity`.
   */
  let observedNow = Date.now();
  /**
   * An amount the user named outright is honoured as stated, never re-sized to the floor.
   * When it cannot be valued from a price read this turn, NO options are offered: sizing to
   * the floor would answer a question they did not ask, and quietly substituting a larger
   * number than the one they gave is the worst outcome available here.
   */
  const requestedBorrow = requestedBorrowFrom(messages, result.observations, observedNow);
  /**
   * Permission to borrow is not an instruction to borrow. "Unspecified" still offers
   * both the idle path and a levered path — the owner prompt says the copilot may take
   * new loans. Only an explicit prohibition suppresses borrow shapes. A typed borrow
   * leg already coerced `borrowing` to required above.
   */
  const lifecycleOp = outcome.kind === "research_complete"
    ? resolveLifecycleWrite({
        modelWrite: outcome.goal.write,
        messages,
        hasSizedWork: Boolean(outcome.goal.actions?.length || outcome.plans?.length),
      })
    : null;

  if (lifecycleOp === "create_account") {
    let existingAccount = scope.smartAccount;
    if (!existingAccount && scope.trader) {
      try {
        const res = await dependencies.mcp.call(
          "vanna_resolve_account",
          { trader: scope.trader },
          dependencies.subject,
        );
        if (
          typeof res?.smart_account === "string" &&
          StrKey.isValidContract(res.smart_account) &&
          ["found_on_chain", "found"].includes(String(res.status))
        ) {
          existingAccount = res.smart_account;
        }
      } catch (error) {
        console.warn("[copilot] account resolution before create_account failed", error);
      }
      if (!existingAccount) {
        try {
          const discovered = await MarginAccountService.discoverExistingAccount(scope.trader);
          if (typeof discovered === "string" && StrKey.isValidContract(discovered)) {
            existingAccount = discovered;
          }
        } catch (error) {
          console.warn("[copilot] MarginAccountService discovery failed", error);
        }
      }
    }

    if (existingAccount) {
      const replyMsg = `You already have an active margin account (${existingAccount}). You can deposit collateral, borrow, or manage positions directly.`;
      const accountObservation: Observation = {
        id: "e_account",
        capability: "vanna_resolve_account",
        args: { trader: scope.trader ?? "" },
        observedAt: observedNow,
        status: "ok",
        data: { smart_account: existingAccount, status: "found" },
      };
      result.observations.push(accountObservation);
      const filteredWarnings = warnings.filter(
        (w) => !w.includes("No active margin account was discovered"),
      );
      const evidence = compactResearchEvidence(result.observations, null, observedNow);

      return {
        status: "researched",
        message: replyMsg,
        originalRequest: messages[0],
        refinements: messages.slice(1),
        question: null,
        proposalCandidateId: null,
        understanding: null,
        facts: [
          ...facts,
          {
            id: "f_account",
            label: "smart account",
            value: existingAccount,
            unit: "address",
            venue: "margin",
            evidenceId: "e_account",
            sourcePath: "smart_account",
            readAt: observedNow,
          },
        ],
        capacity: null,
        candidates: null,
        swapIntent: null,
        rateComparisons: [],
        checks: [
          ...result.observations.map((o) => ({
            id: o.id,
            label: o.capability.replaceAll("_", " "),
            status: o.status,
            readAt: o.observedAt,
          })),
          {
            id: "e_account",
            label: "margin account lookup",
            status: "ok" as const,
            readAt: observedNow,
          },
        ],
        warnings: filteredWarnings,
        scope: {
          wallet: scope.trader,
          smartAccount: existingAccount,
          network: scope.network,
        },
        continuation: codec.seal(scope, messages, null, evidence),
        executionAllowed: false,
        pendingWrite: null,
      };
    }
  }

  // Amounts the user said to keep in the wallet, anchored to their own words; every sizer below honours them.
  const walletReserves = outcome.kind === "research_complete" ? anchoredWalletReserves(outcome.goal, messages) : [];
  const idleAfterReserves = idleWalletAfterReserves(result.observations, observedNow, walletReserves);
  let candidates = null;
  try {
    /**
     * Ranked options ARE the answer to an open-ended prompt, so a deadline after the rates
     * were read still salvages them — pinned by `investigation-service-borrowing`. They are
     * NOT the answer to a request that named its own operations: 16 Sep, "deposit 100 XLM,
     * borrow 2x bLUSD and SOUSDC, then provide liquidity in Blend and Soroswap" timed out
     * and was offered "Lend idle BLUSDC to Earn - no new borrowing", the opposite of the
     * request, because the generator ranks venues from the wallet and never sees the ask.
     * Suppressing on `partial` alone would break the open-ended case too, so the fix for
     * that belongs upstream: the run must finish. `partial` is carried as a fact so the
     * card can say what happened without re-parsing prose.
     */
    candidates = !lifecycleOp && outcome.kind === "research_complete" && outcome.goal.intent === "strategy" && rateComparisons.length && requestedBorrow?.usd !== null
      ? generateCandidates({
          grossCollateralUsd: capacity?.grossCollateralUsd ?? "0",
          debtUsd: capacity?.debtUsd ?? "0",
          floor: capacity?.floor ?? null,
          ...idleAfterReserves,
          // A failed capacity (dropped-leg debt, sources disagree) must not
          // invent headroom from $0 / a default 1.30 floor.
          borrowingAllowed: Boolean(capacity) && !capacityResult.failed && borrowing !== "forbidden",
          borrowing,
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
  /**
   * The model's composed shapes, sized and checked in code, ranked beside the fixed
   * shapes. A plan that does not fit is listed with the reason, never dropped silently —
   * on 13 Sep the card showed nothing at all and the user could not tell "no good option"
   * from "option discarded".
   */
  let modelPlans = !lifecycleOp && outcome.kind === "research_complete" && outcome.goal.intent === "strategy" ? [...(outcome.plans ?? [])] : [];
  /**
   * A stated write ("lend 1 xlm to earn") the model nominated as `goal.actions` is a plan
   * of literal legs, and goes through the same sizer as every other plan: the reads it
   * needs are fetched, its amount is checked against the pocket it draws from, and a
   * refusal names the figure. It used to compile straight to steps (14 Sep: "lend 1 xlm"
   * from a wallet with nothing spendable, refused by the contract after Approve).
   */
  const statedActions = outcome.kind === "research_complete" ? outcome.goal.actions
    : (outcome.kind === "clarify" && !questionnaire ? outcome.actions : undefined);
  const statedPlan = !lifecycleOp && (outcome.kind === "research_complete" || (outcome.kind === "clarify" && !questionnaire)) && (outcome.kind === "research_complete" ? outcome.goal.intent === "strategy" : true) && !modelPlans.length && statedActions?.length
    ? planFromStatedActions(shareSameOpLiteralActions(statedActions, messages), outcome.kind === "research_complete" ? outcome.goal.objective : messages[0]) : null;
  /**
   * Its POSITION, not its identity: `withSharedLiteralAmount` below can append a leg,
   * which would change the plan's candidate id and silently turn the user's own
   * instruction back into a composed proposal. The transforms map in order and never
   * reorder, so the index survives what the id does not.
   */
  const statedPlanIndex = statedPlan ? modelPlans.length : -1;
  if (statedPlan) modelPlans.push(statedPlan);
  /**
   * A swap that did not say what it buys is completed from the user's sentence here, before
   * the reads are chosen and before the evidence is sealed, so the reads phase, the sizer,
   * the card and the sealed plan all see the same leg.
   */
  modelPlans = withSharedLiteralAmount(withBoughtAsset(modelPlans, messages), messages);
  /**
   * Plans the user asked for together become ONE plan (23 Sep, XS6: "use my whole wallet"
   * came back as one option per asset, and Approve could run only one). Only when the model
   * says they are parts, in words the user really sent, and never for the user's own stated
   * plan. The separate parts are kept: if the joined plan does not size, or needs more steps
   * than one approval can run, the turn falls back to them exactly as before.
   */
  /**
   * A USDC the user never chose is asked about BEFORE any plan is built (owner, 23 Sep, option
   * b): sizing it first refused the leg inside the swap card, which then offered "accept the
   * quoted loss" for what was really a missing choice. No plan means no card; the question is
   * the turn. The same check plan.ts applies to every leg (`unchosenUsdcVariant`).
   */
  const usdcToChoose = modelPlans.some((plan) => plan.legs.some((leg) => unchosenUsdcVariant(leg, messages)));
  // Only the plans that need the choice wait for it; the rest ("deploy my XLM and USDC") still size.
  if (usdcToChoose) modelPlans = modelPlans.filter((plan) => !plan.legs.some((leg) => unchosenUsdcVariant(leg, messages)));
  const onlyUsdcAsked = usdcToChoose && !modelPlans.length;
  let partsBeforeJoin: typeof modelPlans | null = null;
  if (statedPlanIndex < 0 && modelPlans.length > 1 && outcome.kind === "research_complete" && anchoredPlanParts(outcome.goal, messages)) {
    const joined = joinPlanParts(modelPlans);
    if ("plan" in joined) { partsBeforeJoin = modelPlans; modelPlans = [joined.plan]; }
    else logPhase("plans_not_joined", { reason: joined.reason });
  }
  if (outcome.kind === "research_complete" && outcome.droppedPlanReasons?.length) logPhase("plans_dropped", { reasons: outcome.droppedPlanReasons });
  if (outcome.kind === "research_complete" && outcome.droppedPlans) {
    warnings.push(`${outcome.droppedPlans} proposed ${outcome.droppedPlans === 1 ? "strategy shape" : "strategy shapes"} could not be read and ${outcome.droppedPlans === 1 ? "was" : "were"} not sized.`);
  }
  if (outcome.kind === "research_complete" && outcome.droppedFindings) {
    warnings.push(`${outcome.droppedFindings} ${outcome.droppedFindings === 1 ? "statement" : "statements"} from the model quoted a figure with no read behind it and ${outcome.droppedFindings === 1 ? "was" : "were"} left out.`);
  }
  /**
   * The position the plans are sized against comes from the account read, and the floor
   * from the user's words — even when borrowing headroom could not be computed (a floor
   * at 1.1, or none stated). A deposit needs no floor; a borrow with none is rejected
   * with a sentence saying so, instead of every account leg claiming the position was
   * never read (13 Sep card).
   */
  /**
   * The floor the model understood and the user's words confirm comes first; the regex
   * parser is the fallback. When it differs from what headroom was computed with (the
   * regex missed "HF stays above 1.3" on 13 Sep), headroom is recomputed with it so the
   * fixed shapes and the plans size against the floor the user actually stated.
   */
  if (goalFloor && goalFloor !== capacity?.floor && scope.smartAccount && !capacityResult.failed) {
    try {
      capacity = await computeBorrowCapacity(scope.smartAccount, messages, dependencies.signal, position?.snapshot ?? null, {
        mcp: scopedMcp, trader: scope.trader, floor: goalFloor,
      });
      logPhase("floor", { source: "goal", floor: goalFloor, headroom: capacity?.maxBorrowUsd ?? null });
    } catch (error) {
      console.warn("[copilot] investigation capacity refresh with the stated floor failed", {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
    }
  }
  const statedFloor = goalFloor ?? capacity?.floor ?? statedFloorFrom(messages);
  /**
   * A floor stated as a ceiling is still a stated limit, and dropping it silently is
   * the failure. "keep HF < 1.3" matches none of the floor patterns, so the turn ran
   * with NO health-factor constraint while the user believed they had set one — a `<`
   * typed for a `>` left only the liquidation line protecting them.
   *
   * It is reported rather than guessed at: reading it as 1.3 would invent a floor the
   * user did not state, and reading it as a real ceiling would mean deliberately
   * targeting a riskier position than the number names. Both are decisions that
   * belong to them, so the turn says what it saw and what it did with it.
   */
  if (statedFloor === null) {
    const ceiling = statedCeilingFrom(messages);
    if (ceiling) {
      const note =
        `You asked for a health factor BELOW ${ceiling}, which is a ceiling, not a floor — ` +
        `a lower health factor is the riskier side. No floor was applied. If you meant ` +
        `"at least ${ceiling}", say so and I will size against it.`;
      if (!warnings.includes(note)) warnings.push(note);
    }
  }
  /**
   * Plans size from the contract's figures always — the one number that liquidates you
   * (`grossCollateralUsd`/`debtUsd` here are `computeSizingBasis`'s contract basis
   * regardless of `issue`). An account holding any unposted balance or LP receipt
   * disagrees with the Margin page PERMANENTLY by design (the app counts everything held,
   * the contract counts only what is posted), so a plan no longer refuses on the
   * disagreement itself — only when the contract read that IS the basis could not be made
   * (`sizing_contract_unavailable`; see plan.ts). The gap becomes information instead: the
   * unposted amount, named plainly, rather than a reason nothing can be sized.
   */
  let planPosition: import("./plan").PlanContext["capacity"] = null;
  if (scope.smartAccount && outcome.kind === "research_complete" && modelPlans.length) {
    try {
      const basis = await computeSizingBasis(scope.smartAccount, position?.snapshot ?? null, { mcp: scopedMcp, trader: scope.trader }, dependencies.signal);
      if (basis) {
        planPosition = {
          grossCollateralUsd: basis.grossCollateralUsd, debtUsd: basis.debtUsd, floor: statedFloor,
          issue: basis.issue ? { reason: basis.issue, app: basis.app, contract: basis.contract } : null,
        };
        if (basis.issue === "sizing_sources_disagree") {
          const note = unpostedCollateralNote(basis.app, basis.contract ?? basis.app);
          if (note && !warnings.includes(note)) warnings.push(note);
        }
      }
    } catch (error) {
      console.warn("[copilot] investigation sizing basis failed", { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
    }
  }
  let planComparisons = rateComparisons;
  if (modelPlans.length) {
    /**
     * Code fetches what code needs. The loop may not have read a price, a wallet balance
     * or a market the plans depend on — a phrase list used to decide whether the market
     * seed ran at all — so the missing reads are made here, deterministically, before
     * sizing. They join the observations so the card, the sealed evidence and propose
     * all see the same reads.
     */
    const missing = readsForPlans(modelPlans, result.observations, observedNow);
    if (missing.length) {
      const extra = await collectStrategyReads(scope, scopedMcp, dependencies.signal, observedNow, missing, "q");
      result.observations.push(...extra);
      logPhase("plan_reads", { requested: missing.map((r) => `${r.capability}${r.args.asset ? `:${r.args.asset}` : ""}`), ok: extra.filter((o) => o.status === "ok").length });
      /**
       * "Now" moves past the reads just made. Freshness is `observedAt <= now`, so a read
       * stamped after a clock taken before it is not fresh — and the rate analysis and the
       * sizer both dropped the very reads fetched for the plan (14 Sep: "lend 25% of xlm"
       * fetched earn_market:XLM and was refused for "no usable Earn supply rate").
       */
      observedNow = Date.now();
      planComparisons = analyseObservedRates(result.observations, observedNow).comparisons;
    }
    const planContext = {
      scope, observations: result.observations, now: observedNow, messages,
      capacity: planPosition, borrowing, comparisons: planComparisons,
      /**
       * Which of these the user stated outright, so the carry guard can tell an offer it
       * should never make from an instruction it has no business refusing. `statedPlan`
       * is one of `modelPlans` by this point, and its id is the only thing separating
       * them again.
       */
      statedPlanId: statedPlanIndex >= 0 && modelPlans[statedPlanIndex]
        ? planCandidateId(modelPlans[statedPlanIndex]) : null,
      // Only an acceptance anchored in the user's own message counts.
      goal: outcome.kind === "research_complete" && anchoredSlippageAccepted(outcome.goal, messages)
        ? outcome.goal : undefined,
      walletReserves,
    };
    let resolved;
    if (partsBeforeJoin) {
      const choice = resolveJoinedOrParts(modelPlans[0], partsBeforeJoin, planContext, MAX_WORKFLOW_STEPS);
      if (choice.plans.length > 1) logPhase("plans_join_fallback", { warning: choice.warning });
      if (choice.warning) warnings.push(choice.warning);
      modelPlans = choice.plans;
      resolved = choice.resolved;
    } else {
      resolved = resolvePlans(modelPlans, planContext);
    }
    // A plan sized past one approval is refused with the count, not failed later at propose.
    resolved = capToOneApproval(resolved, MAX_WORKFLOW_STEPS);
    logPhase("plans", { proposed: modelPlans.length, sized: resolved.candidates.length, rejected: resolved.rejected.map((r) => `${r.title}: ${r.reason}`) });
    // Fixed options only for the assets the user named; the model's composed plans are untouched.
    candidates = mergeCandidateSets(onlyNamedAssets(candidates, messages), resolved, borrowing);
    /**
     * The sizer said what fits the facts it read; the protocol's preview says what the
     * contract will accept. An option the preview refuses is never shown; one it cannot
     * judge is shown as not simulated.
     */
    if (candidates.feasible.some((c) => c.steps?.length)) {
      candidates = await simulateCandidates(candidates, scope, scopedMcp, dependencies.signal);
      logPhase("simulation", { options: candidates.feasible.map((c) => `${c.id}: ${c.simulation?.verdict ?? "not simulated"}`), refused: candidates.rejected.filter((r) => /^The protocol refuses/.test(r.reason)).map((r) => r.reason) });
    }
  }
  if (droppedMissingAccountActions.length > 0) {
    const droppedRejections: CandidateSet["rejected"] = droppedMissingAccountActions.map((entry) => {
      const op = entry.op!;
      const asset = entry.asset ?? "tokens";
      const name = `${verbOf(op)} ${asset}`;
      return {
        label: `${name.charAt(0).toUpperCase()}${name.slice(1)}`,
        reason: `${name}: a margin account is needed for this step and none is connected.`,
        asset,
        accountRequired: { code: "accountRequired" as const, actions: [name] },
      };
    });
    candidates = candidates
      ? { ...candidates, rejected: [...candidates.rejected, ...droppedRejections] }
      : { feasible: [], rejected: droppedRejections };
  }
  /**
   * Checked against the FINAL observations for this turn, after `plan_reads` — not the
   * snapshot from before it ran. `requestedBorrow` above is read early because the fixed
   * shapes need it to decide whether to generate at all; the warning does not have that
   * constraint, and checking it early meant a price `plan_reads` fetched moments later was
   * still reported missing (15 Sep: BLUSDC's price read ok at plan_reads, ~4.7s after the
   * copilot had already told the user it was never read).
   */
  const requestedBorrowNow = requestedBorrowFrom(messages, result.observations, observedNow);
  if (requestedBorrowNow && requestedBorrowNow.usd === null) warnings.push(
    `You asked to borrow ${requestedBorrowNow.tokens} ${requestedBorrowNow.asset}, but no ${requestedBorrowNow.asset} price was read, so that amount could not be checked against your floor.`);
  if (outcome.kind === "research_complete" && outcome.partial) {
    /**
     * A partial run can still have produced ranked options from the reads that did
     * finish, and there is a test that pins exactly that. Asserting "no options are
     * offered" beside a list of them told the user something plainly false, so the
     * sentence follows whether any option actually survived rather than assuming none did.
     */
    warnings.push(candidates?.feasible.length
      ? "The investigation ran out of time, so only what the finished reads could support is"
        + " offered here. Ask again, or split it into smaller steps, for the full picture."
      : "The investigation ran out of time before it could work out a plan for this, so no options are"
        + " offered — only the reads that finished are shown. Ask again, or split it into smaller steps.");
  }
  let question = outcome.kind === "clarify" && questionnaire ? outcome.question
    : outcome.kind === "research_complete" ? outcome.openQuestions[0] ?? null : null;
  question = simplifyQuestion(question, Boolean(candidates?.feasible.length), borrowing);
  // The choice IS the turn: no options beside it, which would answer a question not yet settled.
  // Asked always; the turn is ONLY the question when every plan was waiting on it.
  if (usdcToChoose && !questionnaire) {
    if (onlyUsdcAsked) candidates = null;
    // The model's own open question, when it asked one, stands (it often already names the USDC).
    question = question ?? USDC_QUESTION.charAt(0).toUpperCase() + USDC_QUESTION.slice(1);
  }
  /**
   * A refusal the user could lift is a question, not a verdict.
   *
   * The price-impact guard, and now the carry guard, end their refusal by saying the
   * acceptance that would lift it — but a sentence buried in a rejected option is not an
   * invitation, and it asks the user to know the words before they have been told them.
   * Raising it as the turn's question puts it where the UI already handles one ("Needs
   * your answer"), and `shouldContinueInvestigation` already treats an open question as a
   * thread the next message continues — so "yes, go ahead" lands on this same
   * investigation instead of starting a new one.
   *
   * Only when nothing was offered: an option the user can approve is the better answer,
   * and a question beside it would take it away.
   */
  if (!question && !candidates?.feasible.length) {
    const liftable = candidates?.rejected.find((entry) => entry.acceptable);
    if (liftable) question = liftable.reason;
  }
  /**
   * An option the code sized is an answer. A question the model left open beside it is
   * shown as an open point the user MAY refine — it does not take the option away. 14 Sep:
   * "Repay XLM debt with idle wallet XLM" was sized, shown with its button, and Prepare
   * answered "This option was not proposed by the completed investigation", because the
   * model's note "No BLUSDC balance is available to repay the BLUSDC debt directly" had
   * been sealed as a blocking question.
   */
  const offered = Boolean(candidates?.feasible.length);
  const status: ResearchView["status"] = outcome.kind === "blocked" ? "blocked"
    : offered ? "researched"
      : question ? "needs_input"
        : outcome.kind === "research_complete" ? "researched"
          : outcome.kind === "stopped" ? "incomplete"
            : "needs_input";
  // A stated write, once sized and simulated, is offered as the steps to approve — not as a ranked option.
  const statedId = statedPlan ? planCandidateId(statedPlan) : null;
  const statedCandidate = statedId ? candidates?.feasible.find((c) => c.id === statedId) : undefined;
  const requestedSteps = statedCandidate?.steps ?? [];
  if (statedCandidate && candidates) candidates = { ...candidates, feasible: candidates.feasible.filter((c) => c.id !== statedId) };
  const message = lifecycleOp === "create_account"
    ? "No active margin account was found for your wallet. Approve below to deploy and initialize your margin smart account."
    : strategyReply({
        status, facts, candidates: requestedSteps.length ? null : candidates, capacity, question,
        intent: outcome.kind === "research_complete" ? outcome.goal.intent : undefined,
        findings: outcome.kind === "research_complete" ? outcome.findings : undefined,
        originalRequest: messages[0],
        statedSteps: requestedSteps,
        stopReason: outcome.kind === "stopped" ? outcome.reason : null,
      });
  if (scope.unverified === "bindings") {
    warnings.push("I couldn't verify the wallet link this turn, so I did not load your margin account. Ask again in a moment.");
  } else if (scope.unverified === "claimed") {
    // The account is loaded — from the address the browser sent, which nothing has yet
    // proved belongs to this login. Say that, rather than let the card imply a link.
    warnings.push("This wallet isn't linked to your account yet, so I worked from the address your browser is connected to. Anything prepared here has to be signed by that wallet.");
  } else if (!scope.trader) {
    warnings.push("No verified wallet is connected. Only public market information was available.");
  } else if (!scope.smartAccount && !lifecycleOp) {
    warnings.push("No active margin account was discovered for this wallet.");
  }
  if (outcome.kind === "stopped") warnings.push(outcome.reason === "model_unavailable"
    ? "The language model was unavailable. No keyword plan was substituted."
    : `Research stopped: ${outcome.reason.replaceAll("_", " ")}.`);
  // Every read that errored, with what it was asked and what came back. The card only says "unavailable".
  const failedReads = result.observations.filter((o) => o.status === "error").slice(0, 12)
    .map((o) => ({ capability: o.capability, args: o.args, error: (o.error ?? "no error text").slice(0, 240) }));
  if (failedReads.length) logPhase("reads_failed", { reads: failedReads });
  // The reads the sealed plans need survive sealing, so propose can re-size exactly what was offered.
  const evidence = compactResearchEvidence(result.observations, capacity, observedNow, readsForPlans(modelPlans, [], observedNow));
  if (questionnaire) evidence.questionnaire = questionnaire;
  // Every option shown can be prepared; the sealed list is exactly the shown list.
  evidence.allowedCandidateIds = outcome.kind === "research_complete"
    ? candidates?.feasible.map(candidate => candidate.id) ?? [] : [];
  if (requestedSteps.length) {
    evidence.requestedSteps = requestedSteps;
    evidence.allowedCandidateIds = [REQUESTED_ACTIONS_ID];
  }
  if (modelPlans.length) {
    evidence.plans = modelPlans;
    evidence.position = planPosition;
    // Sealed with the plans it applies to, already anchored to the user's own words.
    if (outcome.kind === "research_complete" && anchoredSlippageAccepted(outcome.goal, messages)) {
      evidence.slippageAccepted = true;
    }
    evidence.floor = statedFloor;
    if (walletReserves.length) evidence.walletReserves = walletReserves;
  }
  const swapLeg = modelPlans.flatMap((plan) => plan.legs).find((leg) => leg.op === "swap" && leg.sizing.kind === "literal" && leg.assetOut);
  const swapVenue = swapLeg?.assetOut ? poolVenueFor(swapLeg.asset, swapLeg.assetOut) : null;
  const swapSourceQuote = swapLeg?.sizing.kind === "literal" ? swapLeg.sizing.sourceQuote : null;
  const swapIntent: ResearchView["swapIntent"] = swapLeg?.sizing.kind === "literal" && swapLeg.assetOut && swapVenue
    && (!swapLeg.venue || swapLeg.venue === swapVenue)
    && swapSourceQuote && messages.some((message) => message.includes(swapSourceQuote))
      ? { tokenIn: swapLeg.asset, tokenOut: swapLeg.assetOut, venue: swapVenue,
          amount: swapLeg.sizing.amount, amountAsset: swapLeg.sizing.amountAsset ?? "asset" }
      : null;
  const diagnostics = outcome.kind === "stopped" || (outcome.kind === "research_complete" && outcome.droppedPlanReasons?.length) || failedReads.length ? {
    ...(failedReads.length ? { failedReads } : {}),
    ...(outcome.kind === "stopped" ? { stopReason: outcome.reason, ...(result.stopDetail ? { stopDetail: result.stopDetail } : {}) } : {}),
    ...(outcome.kind === "research_complete" && outcome.droppedPlanReasons?.length ? { droppedPlanReasons: outcome.droppedPlanReasons } : {}),
  } : undefined;
  if (diagnostics) void appendDiagnostics({ message: messages[messages.length - 1] ?? "", status, diagnostics });
  if (outcome.kind === "research_complete") {
    const conditionalMessage = futureConditionRefusal(outcome.goal.trigger, messages);
    if (conditionalMessage) {
      return {
        status: "blocked", message: conditionalMessage,
        originalRequest: messages[0] ?? input.message, refinements: messages.slice(1),
        understanding: outcome.goal, question: null,
        facts: [], capacity: null, candidates: null, rateComparisons: [], checks: [],
        warnings: [], scope: { wallet: scope.trader, smartAccount: scope.smartAccount, network: scope.network },
        continuation: "", executionAllowed: false,
      };
    }
  }
  return {
    status, message, originalRequest: messages[0], refinements: messages.slice(1), question,
    /**
     * A nomination means "there is one unambiguous thing to prepare", not "here is the
     * first row". The client auto-proposes whatever is nominated, and with session signing
     * on it then auto-approves and broadcasts — so nominating `feasible[0]` out of several
     * competing strategies executed a financial choice the user never made (15 Sep, S4:
     * two options offered, the first one signed and sent before it could be read).
     * Delegated signing is consent to skip the wallet popup, not consent to pick the
     * strategy. With more than one option the choice stays the user's.
     */
    proposalCandidateId: lifecycleOp ? null
      : requestedSteps.length ? REQUESTED_ACTIONS_ID
      : candidates?.feasible.length === 1 ? candidates.feasible[0].id : null,
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
    facts, capacity, candidates: requestedSteps.length ? null : candidates, swapIntent, rateComparisons, checks: result.observations.map((observation) => ({
      id: observation.id, label: observation.capability.replaceAll("_", " "), status: observation.status, readAt: observation.observedAt,
    })), warnings, scope: { wallet: scope.trader, smartAccount: scope.smartAccount, network: scope.network },
    continuation: codec.seal(scope, messages, question, evidence), executionAllowed: false,
    ...(questionnaire ? { questionnaire } : {}),
    ...(input.answers ? { directAction: true } : {}),
    // Not rendered. Why a run stopped, a plan was dropped or a read failed, readable from the response (23 Sep).
    ...(diagnostics ? { diagnostics } : {}),
    pendingWrite: lifecycleOp && scope.trader ? { op: lifecycleOp } : null,
    ...(!scope.smartAccount && (candidates?.rejected.some((r) => r.accountRequired) || droppedMissingAccountActions.length > 0)
      ? {
          choices: [
            { id: "create_account", label: "Open a margin account", write: "create_account" as const },
          ],
        }
      : {}),
  };
}

function decidedWithoutUser(question: string): boolean {
  return /how much|budget|allocat|which (venue|pool|market)|spot or farm|earn or farm|which usdc|which (of )?(the )?(two )?(usdc )?variant/i.test(question);
}

const BORROW_AUTHORITY =
  "May I borrow against your margin account, or should this use idle funds only?";

function simplifyQuestion(
  question: string | null,
  hasCandidates: boolean,
  borrowing: string,
): string | null {
  if (!question) return null;
  const asksAuthority = /may i borrow|borrow against|permission to borrow|new (debt|borrow)|should (i|we) borrow/i.test(question);
  if (hasCandidates && decidedWithoutUser(question)) {
    if (asksAuthority && borrowing === "unspecified") return BORROW_AUTHORITY;
    return null;
  }
  if (asksAuthority && decidedWithoutUser(question) && borrowing === "unspecified") {
    return BORROW_AUTHORITY;
  }
  return question;
}

/**
 * The bound investigation is the only runner for a wallet strategy. This view is the
 * miss — navbar G-address, request not signed in — not a public-market substitute.
 */
function reconnectWalletView(
  input: ResearchInput,
  network: string,
  reason: "session" | "bindings",
): ResearchView {
  const bindings = reason === "bindings";
  return {
    status: "needs_input",
    message: bindings
      ? "I couldn't verify the wallet link this turn, so I did not read balances or prepare a plan. Ask again in a moment. Nothing was executed."
      : "This investigation is not signed in to the wallet shown in the navbar, so I cannot read balances or prepare a plan. Reconnect that wallet and send this again. Nothing was executed.",
    originalRequest: input.message,
    refinements: [],
    understanding: null,
    question: bindings
      ? "Ask again in a moment."
      : "Reconnect the connected wallet so this request can use it.",
    facts: [],
    checks: [],
    warnings: [bindings
      ? "I couldn't verify the wallet link this turn, so I did not load your margin account."
      : "The page shows a wallet, but this request was not signed in."],
    scope: { wallet: input.wallet, smartAccount: null, network },
    continuation: "",
    executionAllowed: false,
  };
}
