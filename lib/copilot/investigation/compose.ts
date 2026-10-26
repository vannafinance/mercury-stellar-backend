import { copilotConfig } from "../config";
import { generateInvestigationJson } from "../vertex";
import { factualReplyBlocks, healthOnContractBasis } from "./answer";
import { formatFactValue } from "./answer-prose";
import { bindReplyBlocks, plainReply, REPLY_SCHEMA, replyFactContext } from "./reply-contract";
import { REQUESTED_ACTIONS_ID } from "./candidate-id";
import { OP_FLOW, type ProposalStep, type WorkflowOp, type WorkflowView } from "../workflow/types";
import { lpPairs, resolveAssetDef, venueTable, venueSpellings, venueUsdc } from "../registry/assets";
import { pct, shownApyPct } from "./apy";
import type { RateComparison } from "./rate-comparison";
import { doneClause } from "./completion";
import { consideredAlongside } from "./considered";
import { opWords, unusedVenueOps, venueReasons } from "./venues";
import type { ReplyBlock, ResearchFact, ResearchView } from "./view";

export { plainReply } from "./reply-contract";
export const bindBlocks = bindReplyBlocks;

/**
 * The model writes the reply; code writes every figure in it.
 *
 * The model chooses a bounded block layout and freely written text. Typed fact references
 * are bound to audited values by the reply contract. This enforces source identity and
 * presentation validity, not the semantic truth of arbitrary prose. Invalid or late
 * output keeps the existing verified fallback; execution authority never comes from prose.
 *
 * Scope: factual answers (a question about the account, prices, positions) and the words
 * above a strategy's plan cards. Partial answers retain their unavailable-data warnings.
 * Questionnaires, refusals and direct actions keep their replies, while
 * workflow completion has a separate composer. Other execution states keep their replies.
 */

const DEFAULT_COMPOSE_BUDGET_MS = 15_000;
export function composeBudgetMs(): number {
  const configured = Number(process.env.COPILOT_COMPOSE_BUDGET_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_COMPOSE_BUDGET_MS;
}

/**
 * What the summary of a finished run may wait. It must outlast the failover to the fallback model (a slow primary is given
 * 15 s before it is replaced) and leave the fallback time to answer: at 15 s, the old budget, a degraded primary ended the
 * summary before the failover could finish and the user got the receipt-only "Done." (24 Oct). A run that has settled is
 * worth the wait; the browser is told to wait longer than this (hooks/composed-completion.ts).
 */
const COMPLETION_COMPOSE_BUDGET_MS = 28_000;

/** The most the writing step may wait, however much of the route is left: past this a reply is not worth the wait. */
const MAX_COMPOSE_BUDGET_MS = 45_000;
/** Kept back so the response can still be sent before the route's own deadline cuts the stream. */
const ROUTE_RESPONSE_MARGIN_MS = 3_000;

/**
 * The writing step's budget once research has taken `elapsedMs` of a route that ends at `routeDeadlineMs`.
 *
 * A fixed 15 s cut the step off even when research had finished in 16 s of a 75 s route, and the reply
 * fell back to a canned message that answered a different question (24 Oct, live). The call is already
 * made and paid for; letting it finish costs nothing, throwing it away costs the answer. Never less
 * than the configured default: a nearly spent route is cut by its own deadline, not by a smaller budget.
 */
export function composeBudgetAfter(elapsedMs: number, routeDeadlineMs: number): number {
  const left = routeDeadlineMs - elapsedMs - ROUTE_RESPONSE_MARGIN_MS;
  return Math.max(composeBudgetMs(), Math.min(MAX_COMPOSE_BUDGET_MS, left));
}
const PRESENTATION = `Organize the response around what the user needs to understand. Lead with the answer, then group related information. For a broad position overview, open with a brief explanation of the account breakdown before the grouped holdings. Distinguish collateral deposited, posted collateral and outstanding debt by their supplied basis. The supplied labels use the Margin page's own wording; name each figure the way the user asked for it, so a user who says "collateral" reads collateral, one who says "deposit" reads deposit, and one who says "borrowed" or "debt" reads that; separate holdings in other venues and never add overlapping valuations together. Honor the user's requested presentation format when it can represent the supplied evidence faithfully. Otherwise use paragraphs for a connected explanation, bullets for parallel points, steps only when order matters, and a table for genuinely comparable rows. Use short descriptive headings when they improve navigation. Choose the combination and length needed by this request; avoid a wall of text, unnecessary sections, and repeating what a card already shows. Match the user's language where practical.
Return JSON with a blocks array. A paragraph or heading has segments; bullets or steps have items (an array of segment arrays); a table has columns (an array of segment arrays) and rows (an array of rows of segment arrays). Each segment is either {"type":"text","text":"your freely written words"} or {"type":"fact","factId":"an supplied fact id"}. Code renders fact segments with their verified value and unit. Never type a figure, amount, rate, address or numeric unit in text; use its fact reference, and do not repeat its unit. Do not use placeholder strings or markdown. Refer only to supplied facts. Keep each reference attached to its correct label, venue and meaning. Evidence timestamps describe when a read happened; absent timestamps do not establish a live observation. Do not invent causes, risk conclusions, events or outcomes. The draft is background meaning, not a required sentence or layout.`;

const CHAT_STYLE = `Address the person as you or your, never as the user or a third-person research subject. For a focused answer, lead with the useful conclusion in one short sentence. Add only the supporting comparison, next step or blocker the person needs. Keep paragraphs to one or two short sentences and use bullets for distinct parallel points. State each supporting comparison once: either include its figures in the lead sentence or put them in bullets below a conclusion without figures. Never repeat the same figures in both places. If one sentence fully answers the question, end there without bullets. Prefer one rate convention in a comparison; do not repeat both APR and APY for the same option unless that distinction was requested. Omit unrelated rates, empty holdings and zero balances unless they explain the blocker. Keep required facts and relevant limitations. Do not narrate the investigation or describe planning internals. Do not use em dashes or the word idle.`;

const SYSTEM = `You write the reply a user reads in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar).
You are given the user's question and FACTS read live from their account and the protocol. Write the answer the way a sharp, friendly analyst would reply in a chat app.

Use the supplied scope, intent and fact metadata to answer the actual question. Quantity and measurement facts are different: never describe a rate or ratio as a token balance. When the user requests a comparison or preferred option, lead with the conclusion supported by their criterion and the supplied evidence, then explain the reason. A list of observations alone does not answer a request to choose between options. Distinguish asset variants and eligibility; a higher quoted rate for another underlying asset does not establish a better return for the user's asset. If evidence cannot determine a preference, say which missing comparison prevents it. Keep supporting facts relevant to that conclusion; do not list unrelated assets, holdings or pool totals simply because they were read. An informational recommendation does not authorize a transaction or claim safety beyond the supplied evidence.
Warnings identify unavailable data. Answer only from the supplied verified facts, make relevant limitations clear, and never describe partial observations as a complete account or market assessment. Unavailable prices do not invalidate successfully observed rates; a rate comparison does not authorize an allocation or transaction.
When a health-factor state says there is no debt, explain that the ratio does not apply yet. Do not substitute LTV or distance to liquidation for a health factor, or list those measures unless requested.
The context's venueAssets is the registry of supported underlying assets, venueSpellings maps venue-local symbols to their actual asset identities, and venueUsdc identifies the sole USDC variant supported by single-variant venues. Use them to establish eligibility before comparing rates. An asset absent from a venue's supported list cannot be supplied there directly. Do not treat similarly named variants as interchangeable or assume a conversion; its costs and feasibility are separate evidence.
${PRESENTATION}
${CHAT_STYLE}`;

const PLANS_SYSTEM = `You write the reply shown above a set of plan cards in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar). The cards already show every step and figure; your words help the user choose, the way a thoughtful analyst would explain options in a chat app.
You are given the user's request and PLANS, each with facts computed by the sizer. A plan's non-null letter is the label shown on its card. If its letter is null, there is only one card: refer to its title or the proposed action without adding an option letter or comparing alternatives.
Each plan's movements states the operation's source and destination pocket. account means the margin account; wallet means the spendable wallet. Describe destinations from these movements, not from the user's requested outcome or a plan title. An exit into the margin account is not a transfer to the wallet. When context.openPoint is present, distinguish the prepared portion from the unresolved portion; do not claim the whole request is covered.
When a plan has liquidityOutputs, those are the registered assets its removal returns. Their market rates are verified research comparisons, not rates earned by the exit itself. For a request to reinvest, lead with the relevant same-asset yield comparison and then state which outputs have no prepared supply step. An exit-only card does not prepare reinvestment. Do not imply that a quoted venue is included merely because its rate is higher. If the request only asks to remove liquidity, omit unrelated yield comparisons. Never explain a yield preference merely as using an already held token.
Explain the leading plan using the supplied sizer reason (already_held means an already held token; thin_margin means rates are within noise; net_return means the best computed return at this size). CONSIDERED lists other tokens the user holds that were compared for the same job, with their rates; say they were checked and how the leading plan's token compares, using only those facts, when the list is there. NOT_USED names operations the user said you may use that none of the plans uses; when it is not empty, say in one clause that none of the plans used them, giving the reason when one is supplied and no other. Lay it out as one short lead sentence naming the leading plan and why, then bullets, one parallel point each (what else was compared, operations that were not used, how the other plans differ), each a single short sentence. No paragraph longer than two sentences; the cards already show every step and figure, so do not walk through them. Describe useful differences without inventing a ranking. These are options awaiting approval, not executed transactions. Do not invent risks or reasons.
${PRESENTATION}
${CHAT_STYLE}`;

const COMPLETION_SYSTEM = `You write the reply shown once a user's transactions have finished, in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar). Say what happened and what it means now, the way a helpful analyst would confirm a completed trade in a chat app.
You are given the user's LATEST request, earlier messages of the conversation (context only), and FACTS: each settled step (what was done, the amount), any previously observed rates, and, when it was read after the run, the account's health factor now.
Only supplied settled steps completed. Use workflow status and step statuses to distinguish settled, pending, failed and unsubmitted work. Rates come from the supplied sealed comparisons; they are not a new post-run read. If stopped is given, distinguish what ran from what did not. Do not invent current health or next actions.
Connect the settled outcome to the original request and approved constraints. When a health-floor fact is supplied, include it as a fact reference and explain that it was the approved safety target for the run. Distinguish this target from freshly observed health: only health_now is a post-run observation, and a target alone does not prove the resulting health or that the whole request completed. Use your own concise wording rather than a fixed sentence.
Write one combined summary for the whole run, short: open with one or two plain sentences saying what was done overall and, when health_now is supplied, what the health factor is now. Add no headings or tables, and no paragraphs beyond the answer to anything else the request asked (below). The renderer draws each transaction as its own row with a tick and its explorer link, so never write hashes, links or ledgers. When more than one transaction settled, follow the sentences with one bullet per transaction, in the order given: a short past-tense line saying what that transaction did, which becomes that transaction's row. With a single transaction, the sentences are enough. Do not ask for approval or narrate waiting for signatures when the workflow is completed.
One request gets one reply. When the request also asked for something beyond the transactions (a figure to show, a price to tell, something to check), answer it in this same reply, in a sentence or two after the transactions, from the supplied facts, and give only what was asked: never the other figures. Account figures read after the run (leverage, liquidation prices, whether a margin account exists) are supplied for that, and are cited like any other fact. Answer only the latest request. Use the earlier messages only to understand what the latest one refers to (it may continue or answer something said before); a figure an earlier message asked for belongs in this reply only when the latest message repeats or depends on it, since earlier questions were answered in their own replies. If a figure the latest request asked for is not among the supplied facts, leave it out; never write that something could not be read, is unavailable or was not checked. When part of the request needed no transaction (the margin account already exists, so none was opened), say so in a few words.
${PRESENTATION}
${CHAT_STYLE}`;

type Generate = (system: string, user: string, signal: AbortSignal) => Promise<unknown>;
type ReplyLane = "answer" | "conceptual" | "plans" | "completion" | "refusal";

const CONCEPTUAL_SYSTEM = `Rewrite the supplied conceptual draft for a DeFi chat. Preserve its meaning and answer the latest request's presentation instructions, including the requested number of bullets or sentences. Do not add account observations, protocol guarantees, recommendations or transaction claims. Keep each sentence under twenty-five words and each bullet to one short point. Use familiar words and direct verbs; avoid dense phrases such as dynamically updating, variable rate dynamics or supplied pool capital. Preserve qualifications about whether a venue compounds interest; do not turn a possibility into a guarantee. Omit examples and background detail when the request asks for a short summary. For conceptual examples, express numbers in words; these are illustrations, never observed account facts.
${PRESENTATION}
${CHAT_STYLE}
There are no observed facts to cite. Use text segments only. If the user asks for bullets, return a bullets block directly without an introductory paragraph.`;

const REFUSAL_SYSTEM = `You explain why a requested borrow could not be prepared. Lead with the requested amount versus the current protocol ceiling. Both figures must come from supplied fact references. Explain a limiting factor only when one was supplied; do not invent a collateral, liquidity or health-factor cause. The rejected plan was not submitted. Describe the ceiling as an observed protocol limit, not a promise that a smaller loan will pass all checks. Do not invent a replacement plan or change execution authority.
${PRESENTATION}
${CHAT_STYLE}
For this refusal, return one short paragraph combining the requested amount, current ceiling, supplied reason and the fact that nothing was submitted. Avoid repeating the limit, explaining internal checks or adding a separate caution paragraph. State what happened in plain language; the ceiling should never be described as a guaranteed executable amount.`;

function borrowRefusalContext(view: ResearchView) {
  const rejected = view.candidates?.rejected ?? [];
  if (view.status !== "researched" || view.candidates?.feasible.length || view.questionnaire || view.pendingWrite || view.choices?.length || view.proposalCandidateId ||
    !rejected.length || rejected.some(row => !row.borrowLimit)) return null;
  const facts: ResearchFact[] = [];
  const rejections = rejected.map((row, index) => {
    const limit = row.borrowLimit!;
    const prefix = `refusal${String.fromCharCode(65 + index)}`;
    for (const [field, value, label] of [
      ["requested_amount", limit.requestedAmount, "Requested borrow"],
      ["maximum_amount", limit.maximumAmount, "Observed protocol borrow ceiling"],
    ]) facts.push({ id: `${prefix}:${field}`, label, value, unit: limit.asset, venue: "margin", evidenceId: limit.evidenceId,
      sourcePath: field, readAt: limit.readAt, quantity: true, requiredInReply: true });
    return { asset: limit.asset, limitingFactor: limit.limitingFactor ?? null, requestedFact: `${prefix}:requested_amount`, ceilingFact: `${prefix}:maximum_amount` };
  });
  return { facts, rejections };
}

const CAUSE_REFUSAL_SYSTEM = `You tell the user, in plain words, why the requested step could not be prepared and what they can do next. Use only the supplied reasons; never add a cause, a number or a replacement plan. Name the refused step by citing its fact reference. Say the cause in everyday language: no protocol or system jargon, no names of internal limits or checks, no unit names such as CPU or ledger. Say what to change (for example state an amount, pick a smaller size, or a different asset) only when a supplied reason says so. End by saying nothing was submitted.
${PRESENTATION}
${CHAT_STYLE}
Return one short paragraph, two sentences at most. Write no digits yourself; the only figure allowed is the cited step.`;

/**
 * A refusal whose cause is a sentence, not a measured ceiling: the planner's or protocol's reason is
 * reworded plainly around the audited step label. Turns that carry their own action (an account button,
 * an "accept the loss" choice, a missing-amount question, a wrong-pocket remedy) keep their own reply.
 */
function causeRefusalContext(view: ResearchView) {
  const rejected = view.candidates?.rejected ?? [];
  if (view.status !== "researched" || view.candidates?.feasible.length || view.questionnaire || view.pendingWrite || view.choices?.length || view.proposalCandidateId ||
    !rejected.length || rejected.some(row => row.borrowLimit || row.accountRequired || row.poolLimited || row.ceilingNeeded || row.needsInput || row.acceptable)) return null;
  const facts: ResearchFact[] = [];
  const rejections = rejected.slice(0, 3).map((row, index) => {
    const id = `refused${String.fromCharCode(65 + index)}:step`;
    facts.push({ id, label: "Refused step", value: row.label, unit: "", venue: "margin", evidenceId: "refusal", sourcePath: "label", readAt: 0, requiredInReply: true });
    return { stepFact: id, reason: row.cause ?? row.reason };
  });
  return { facts, rejections };
}

/** Aggregatable lifecycle data only: no request text, account identifiers or fact values. */
function compositionEvent(lane: ReplyLane | "other", outcome: "composed" | "skipped" | "off" | "refused" | "unavailable", ms = 0, blocks: readonly ReplyBlock[] = [], reason?: string) {
  console.info("[copilot] reply composition", {
    lane, outcome, ms: Math.round(ms), blockCount: blocks.length,
    blockTypes: blocks.map((block) => block.type), ...(reason ? { reason } : {}),
  });
}

function scopeContext(view: ResearchView) {
  return { network: view.scope.network, walletPresent: Boolean(view.scope.wallet), smartAccountPresent: Boolean(view.scope.smartAccount) };
}

const defaultGenerate: Generate = (system, user, signal) =>
  generateInvestigationJson(copilotConfig.vertexComposeModel, system, user, signal, "LOW", [], REPLY_SCHEMA);

/** Plan cards the composer may introduce: a strategy's own options, not a direct action. */
export function composablePlans(view: ResearchView): boolean {
  return view.status === "researched"
    && view.understanding?.intent === "strategy"
    && Boolean(view.candidates?.feasible?.length)
    && !view.questionnaire
    && !view.pendingWrite
    && !view.choices?.length
    && view.proposalCandidateId !== REQUESTED_ACTIONS_ID;
}

function payoutOrigin(step: ProposalStep, steps: readonly ProposalStep[]): string | null {
  const visited = new Set<string>();
  let current: ProposalStep | undefined = step;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const sizing: ProposalStep["sizing"] = current.sizing;
    if (sizing?.basis === "settled_payout" && sizing.asset === step.asset) return sizing.fromStep;
    if (sizing?.basis !== "settled_transfer" || sizing.asset !== step.asset) return null;
    const producer: ProposalStep | undefined = steps.find(row => row.id === sizing.fromStep);
    if (!producer || producer.asset !== step.asset || OP_FLOW[producer.op].from !== "account" || OP_FLOW[producer.op].to !== "wallet") return null;
    current = producer;
  }
  return null;
}

/**
 * Each plan's figures as the sizer computed them, keyed by the letter its card shows. Only
 * these reach the model on a strategy turn, never the raw reads, so every figure it can
 * cite is one the card itself shows.
 */
export function planFacts(view: ResearchView): {
  facts: ResearchFact[];
  plans: Array<{ plan: string | null; borrows: boolean; movements: Array<{ op: WorkflowOp; from: string; to: string }>; liquidityOutputs: Array<{ asset: string; supplyPrepared: boolean; marketRates: Array<{ venue: string; factId: string }> }>; facts: Array<{ id: string; label: string; shown: string }> }>;
  considered: Array<{ id: string; label: string; shown: string }>;
  /** Operations the user allowed that no plan uses, by name. Empty when every one is used. */
  notUsed: Array<{ operation: string; reason: string | null }>;
  lead: string | null;
} {
  const feasible = (view.candidates?.feasible ?? []).slice(0, 6);
  const facts: ResearchFact[] = [];
  const plans = feasible.map((candidate, index) => {
    const letter = String.fromCharCode(65 + index);
    const own: ResearchFact[] = [];
    const add = (key: string, label: string, value: string | null | undefined, unit: string) => {
      if (value == null || value === "") return;
      own.push({ id: `plan${letter}:${key}`, label, value: String(value), unit, venue: "margin", evidenceId: `plan${letter}`, sourcePath: key, readAt: 0 });
    };
    add("name", "what the plan does", candidate.label, "");
    add("amount", "amount the plan places, in USD", candidate.amountUsd, "USD");
    add("rate", candidate.supplyApyPct != null ? "supply APY" : "supply APR", candidate.supplyApyPct ?? candidate.supplyAprPct, candidate.supplyApyPct != null ? "% APY" : "% APR");
    if (candidate.borrows) add("net_rate", "net rate after borrow cost", candidate.netApyPct ?? candidate.netAprPct, candidate.netApyPct != null ? "% APY" : "% APR");
    add("hf_before", "health factor before", candidate.initialHealthFactor ?? candidate.healthFactorBefore, "HF");
    if (candidate.repaysAllDebt) add("hf_after", "health factor after", "no debt left", "");
    else add("hf_after", "health factor after", candidate.finalHealthFactor, "HF");
    const liquidityOutputs = (candidate.steps ?? []).flatMap((step, removalIndex) => {
      const flow = OP_FLOW[step.op];
      if (flow.from !== "lp" || flow.to !== "account") return [];
      const pair = lpPairs().find(pair => pair.tokens.includes(step.asset as never));
      if (!pair) return [];
      return pair.tokens.map(asset => {
        const comparison = view.rateComparisons?.find(row => row.asset === asset);
        const marketRates = ([
          ["earn_supply", "earnSupplyApr", "earn"],
          ["blend_supply", "blendSupplyApr", "blend"],
        ] as const).flatMap(([kind, field, venue]) => {
          const apr = comparison?.[field];
          if (apr == null || !Number.isFinite(Number(apr))) return [];
          const factId = `plan${letter}:output${removalIndex}:${asset}:${venue}`;
          own.push({ id: factId, label: `${asset} ${venue} observed supply APY`,
            value: pct(shownApyPct(kind, apr)), unit: "% APY", venue,
            evidenceId: comparison!.evidenceIds.join(","), sourcePath: field, readAt: 0 });
          return [{ venue, factId }];
        });
        const supplyPrepared = (candidate.steps ?? []).slice(removalIndex + 1).some(later => later.asset === asset
          && payoutOrigin(later, candidate.steps ?? []) === step.id
          && (OP_FLOW[later.op].rate === "earn_supply" || OP_FLOW[later.op].rate === "blend_supply"));
        return { asset, supplyPrepared, marketRates };
      });
    });
    facts.push(...own);
    const movements = (candidate.steps ?? []).map((step) => ({ op: step.op, from: OP_FLOW[step.op].from, to: OP_FLOW[step.op].to }));
    return { plan: feasible.length > 1 ? letter : null, borrows: candidate.borrows, movements, liquidityOutputs, facts: own.map((fact) => ({ id: fact.id, label: fact.label, shown: formatFactValue(fact) })) };
  });
  // What else was compared for the leading plan's job (the other held tokens priced as the same dollar), as facts the
  // reply may cite, so "why this token" is an answer from the reads and not a silence.
  const leadingLiquidityExit = (feasible[0]?.steps ?? []).some(step => OP_FLOW[step.op].from === "lp");
  const considered = (leadingLiquidityExit ? [] : consideredAlongside(feasible[0]?.steps ?? [], view.rateComparisons ?? [], view.facts)).flatMap((token) => {
    const make = (key: string, label: string, value: string): ResearchFact =>
      ({ id: `considered:${token.asset}:${key}`, label, value, unit: "% APY", venue: "margin", evidenceId: "considered", sourcePath: key, readAt: 0 });
    return [
      make("rate", `${token.label} ${token.venue} supply rate, compared`, token.apy),
      make("lead", `${token.leadLabel} ${token.venue} supply rate, the token the leading plan uses`, token.leadApy),
    ];
  });
  facts.push(...considered);
  return {
    facts, plans, considered: considered.map((fact) => ({ id: fact.id, label: fact.label, shown: formatFactValue(fact) })),
    notUsed: unusedVenueOps([...new Set((view.understanding?.venuesAllowed ?? []).map((row) => row.op))], feasible)
      .map((op) => ({ operation: opWords(op), reason: venueReasons(view.understanding?.venuesAllowed ?? []).get(op) ?? null })),
    lead: leadingLiquidityExit ? null : feasible[0]?.decision?.factor ?? null,
  };
}

/**
 * A finished run's facts: each settled step from the journal (never the browser's copy), the
 * rate it earns or costs from the sealed reads, and the health factor read after it ran.
 */
export function completionFacts(view: WorkflowView, comparisons: readonly RateComparison[], healthNow: string | null, positionNow?: { grossCollateralUsd: string; debtUsd: string; observedAt: number }, healthFloor?: string | null, extra: readonly ResearchFact[] = []): ResearchFact[] {
  const facts: ResearchFact[] = [];
  const add = (id: string, label: string, value: string, unit: string) =>
    facts.push({ id, label, value, unit, venue: "margin", evidenceId: "run", sourcePath: id, readAt: 0 });
  view.steps.filter((step) => step.status === "settled").forEach((step, index) => {
    const n = index + 1;
    const def = resolveAssetDef(step.asset);
    add(`step${String.fromCharCode(64 + n)}:done`, "what was done", doneClause(step), "");
    const flow = OP_FLOW[step.op as WorkflowOp];
    // Receipt-share exits already carry their unit and any approved conversion in
    // the action label. Their raw amount is not an underlying-token quantity.
    if (step.amount && flow?.from !== "earn" && flow?.from !== "lp") {
      add(`step${String.fromCharCode(64 + n)}:amount`, "amount settled", step.amount, def?.displayLabel ?? step.asset);
    }
    const kind = OP_FLOW[step.op as WorkflowOp]?.rate;
    const row = kind ? comparisons.find((comparison) => comparison.asset === step.asset) : undefined;
    const apr = kind === "earn_supply" ? row?.earnSupplyApr : kind === "blend_supply" ? row?.blendSupplyApr : kind === "earn_borrow" ? row?.marginBorrowApr : null;
    if (kind && apr != null && Number.isFinite(Number(apr))) {
      add(`step${String.fromCharCode(64 + n)}:rate`, kind === "earn_borrow" ? "borrow cost now" : "earning now", pct(shownApyPct(kind, apr)), kind === "earn_borrow" ? "% a year" : "% APY");
    }
  });
  if (healthNow) add("account:health_now", "health factor now", healthNow, "HF");
  if (positionNow) {
    add("account:collateral_now", "observed collateral value after settlement", positionNow.grossCollateralUsd, "USD");
    add("account:debt_now", "observed debt value after settlement", positionNow.debtUsd, "USD");
    for (const fact of facts.filter((entry) => entry.id.startsWith("account:"))) {
      fact.readAt = positionNow.observedAt;
      fact.evidenceId = "post-settlement-account-read";
    }
  }
  if (healthFloor) facts.push({ id: "account:health_floor", label: "approved minimum health factor target", value: healthFloor,
    unit: "HF", venue: "margin", evidenceId: "approved-proposal", sourcePath: "floor", readAt: 0, quantity: true, requiredInReply: true });
  // Figures read from the account after the run, offered for a request that asked for them. Never required: a reply
  // that was not asked for a liquidation price does not carry one.
  for (const fact of extra) facts.push({ ...fact, requiredInReply: false });
  return facts;
}

/**
 * The finished reply composed around the run's own facts, or null to keep the deterministic
 * one. Never throws.
 */
export async function composeCompletion(input: {
  view: WorkflowView;
  /** The latest thing the user asked: the message that produced this run. */
  request: string;
  /** Earlier messages of the conversation, for context only; they have their own replies. */
  earlierMessages?: readonly string[];
  draft: string;
  comparisons: readonly RateComparison[];
  healthNow: string | null;
  healthFloor?: string | null;
  constraints?: readonly string[];
  positionNow?: { grossCollateralUsd: string; debtUsd: string; observedAt: number };
  /** Post-run figures (leverage, liquidation, whether the account exists) offered for what the request asked. */
  extraFacts?: readonly ResearchFact[];
}, signal: AbortSignal, generate: Generate = defaultGenerate): Promise<{ message: string; blocks: ReplyBlock[] } | null> {
  if (process.env.COPILOT_COMPOSED_REPLIES === "off") { compositionEvent("completion", "off"); return null; }
  const facts = completionFacts(input.view, input.comparisons, input.healthNow, input.positionNow, input.healthFloor, input.extraFacts);
  if (!facts.length) { compositionEvent("completion", "skipped", 0, [], "no_facts"); return null; }
  const stopped = input.view.status !== "completed";
  const user = JSON.stringify({
    request: input.request,
    ...(input.earlierMessages?.length ? { earlierMessages: input.earlierMessages } : {}),
    facts: facts.map(replyFactContext),
    context: { category: "completion", workflowStatus: input.view.status,
      steps: input.view.steps.map((step) => ({ op: step.op, asset: step.asset, status: step.status })),
      rateBasis: "sealed_comparison", healthProvided: Boolean(input.healthNow), approvedConstraints: input.constraints ?? [] },
    ...(stopped ? { stopped: { status: input.view.status } } : {}),
    draft: input.draft,
  });
  const bound = await boundReply(COMPLETION_SYSTEM, user, facts, signal, generate, "completion", COMPLETION_COMPOSE_BUDGET_MS);
  return bound ? { message: plainReply(bound), blocks: bound } : null;
}

/** One budgeted model call, bound to `facts`, or null. Shared by every composed reply. */
async function boundReply(system: string, user: string, facts: readonly ResearchFact[], signal: AbortSignal, generate: Generate, lane: ReplyLane, budgetMs: number = composeBudgetMs()): Promise<ReplyBlock[] | null> {
  const start = performance.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("compose deadline", "TimeoutError")), budgetMs);
  const budget = AbortSignal.any([signal, deadline.signal]);
  let onAbort: (() => void) | undefined;
  try {
    const ask = (payload: string) => Promise.race([
      generate(system, payload, budget),
      new Promise<never>((_, reject) => {
        if (budget.aborted) reject(new DOMException("compose budget", "TimeoutError"));
        onAbort = () => reject(new DOMException("compose budget", "TimeoutError"));
        budget.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    const mode = lane === "conceptual" ? "conceptual" : "factual";
    let bound = bindReplyBlocks(await ask(user), facts, mode);
    if (!bound.ok) {
      /**
       * A refused reply is told why, once: the validator's reason is a fixed sentence ("reply contains a figure the
       * model wrote itself"), never user text. Without this the user got the plain template instead (7 Oct: the
       * prose "Non-borrowing Farm & Earn: ... deposit 1496.767159 XLM ..." where a written reply used to be).
       */
      compositionEvent(lane, "refused", performance.now() - start, [], `first_attempt:${bound.reason}`);
      let feedback: string | null = null;
      try {
        feedback = JSON.stringify({ ...JSON.parse(user), previousReplyRefused: `${bound.reason}. Write the reply again: type no digit in any text segment, and take every figure from a fact reference.` });
      } catch { feedback = null; }
      // A second attempt that cannot finish inside the budget only spends it: ask again only when the first came back early.
      if (feedback && !budget.aborted && performance.now() - start < budgetMs / 2) bound = bindReplyBlocks(await ask(feedback), facts, mode);
    }
    if (!bound.ok) {
      compositionEvent(lane, "refused", performance.now() - start, [], `invalid_output:${bound.reason}`);
      return null;
    }
    compositionEvent(lane, "composed", performance.now() - start, bound.blocks);
    return bound.blocks;
  } catch {
    compositionEvent(lane, "unavailable", performance.now() - start, [], signal.aborted ? "request_aborted" : deadline.signal.aborted ? "compose_deadline" : "provider_unavailable");
    return null;
  } finally {
    clearTimeout(timer);
    if (onAbort) budget.removeEventListener("abort", onAbort);
  }
}

/** A factual answer the composer may rewrite. Everything else keeps its own reply. */
export function composable(view: ResearchView): boolean {
  return view.status === "researched"
    && view.understanding?.intent === "answer"
    && view.facts.length > 0
    // Live, 29 Sep: given the contract-basis read, the model told the user "1.83" - the figure
    // the owner ruled out. Those facts are never handed to the composer.
    && !healthOnContractBasis(view.facts)
    // Failed optional reads must not discard the facts that succeeded. The
    // warnings remain visible and are supplied to the composer as limitations.
    && !view.questionnaire
    && !view.pendingWrite
    && !view.choices?.length
    && !view.candidates?.feasible?.length
    && !view.proposalCandidateId;
}

/** Explain completed strategy research even when it produced no executable option. */
function composableUnpreparedStrategy(view: ResearchView): boolean {
  return view.status === "researched" && view.understanding?.intent === "strategy"
    && view.facts.length > 0 && !healthOnContractBasis(view.facts)
    && !view.question && !view.questionnaire && !view.pendingWrite && !view.choices?.length
    && !view.candidates?.feasible?.length && !view.proposalCandidateId
    && !view.directAction && !view.executionAllowed;
}

/**
 * The view with its reply written by the model around the audited figures, or the view
 * unchanged. Never throws: a composed reply is an improvement, never a dependency.
 */
export async function composeReply(view: ResearchView, signal: AbortSignal, generate: Generate = defaultGenerate, options: { budgetMs?: number } = {}): Promise<ResearchView> {
  if (process.env.COPILOT_COMPOSED_REPLIES === "off") { compositionEvent("other", "off"); return view; }
  const request = [view.originalRequest, ...view.refinements].filter(Boolean).join("\n");
  let system: string;
  let user: string;
  let facts: readonly ResearchFact[];
  let lane: ReplyLane;
  const refusal = borrowRefusalContext(view);
  if (refusal) {
    lane = "refusal";
    system = REFUSAL_SYSTEM;
    facts = refusal.facts;
    user = JSON.stringify({ request, facts: facts.map(replyFactContext), rejections: refusal.rejections,
      context: { category: "refusal", status: view.status, executionSubmitted: false }, draft: view.message });
  } else if (!composableUnpreparedStrategy(view) && causeRefusalContext(view)) {
    const cause = causeRefusalContext(view)!;
    lane = "refusal";
    system = CAUSE_REFUSAL_SYSTEM;
    facts = cause.facts;
    user = JSON.stringify({ request, facts: facts.map(replyFactContext), rejections: cause.rejections,
      context: { category: "refusal", status: view.status, executionSubmitted: false }, draft: view.message });
  } else if (view.status === "researched" && view.understanding?.intent === "answer" && !view.facts.length
    && view.message.trim() && !view.question && !view.questionnaire && !view.pendingWrite && !view.choices?.length
    && !view.candidates?.feasible?.length && !view.proposalCandidateId && !view.directAction && !view.executionAllowed) {
    lane = "conceptual";
    system = CONCEPTUAL_SYSTEM;
    facts = [];
    user = JSON.stringify({ request, draft: view.message, context: { category: "conceptual", warnings: view.warnings } });
  } else if (composable(view) || composableUnpreparedStrategy(view)) {
    lane = "answer";
    system = SYSTEM;
    facts = view.facts;
    system += " Every fact marked requiredInReply is a core answer figure and must appear as a fact reference in your reply.";
    const unprepared = composableUnpreparedStrategy(view);
    if (unprepared) system += " This strategy research produced no executable plan. Explain the useful finding briefly and make that unresolved state clear. A rate preference is informational, not a prepared allocation. State a cause only when supplied in preparation.reasons; an empty list does not establish a funding or protocol blocker. The draft is not proof of a cause or that every requested output was covered. Nothing was submitted.";
    user = JSON.stringify({
      question: request,
      facts: view.facts.map(replyFactContext),
      context: { category: "answer", status: view.status, scope: scopeContext(view), understanding: view.understanding, warnings: view.warnings,
        ...(unprepared ? { preparation: { status: "not_prepared", executionSubmitted: false,
          reasons: view.candidates?.rejected.map(row => row.reason) ?? [] } } : {}),
        venueAssets: venueTable(), venueSpellings: venueSpellings(), venueUsdc: venueUsdc() },
      draft: view.message,
    });
  } else if (composablePlans(view)) {
    lane = "plans";
    const plans = planFacts(view);
    if (!plans.facts.length) { compositionEvent("plans", "skipped", 0, [], "no_facts"); return view; }
    system = PLANS_SYSTEM;
    facts = plans.facts;
    user = JSON.stringify({ request, plans: plans.plans, considered: plans.considered, notUsed: plans.notUsed, facts: facts.map(replyFactContext), lead: plans.lead,
      context: { category: "plans", status: view.status, scope: scopeContext(view), requiresApproval: true,
        constraints: view.understanding?.constraints ?? [], warnings: view.warnings, openPoint: view.question }, draft: view.message });
  } else {
    const reason = view.status !== "researched" ? "response_state"
      : healthOnContractBasis(view.facts) ? "contract_health_basis"
      : view.questionnaire ? "questionnaire"
      : view.pendingWrite ? "pending_write" : view.choices?.length ? "choices"
      : view.proposalCandidateId ? "direct_action" : !view.facts.length ? "no_facts" : "unsupported_intent";
    compositionEvent("other", "skipped", 0, [], reason);
    return view;
  }
  // Raced, not only signalled, in `boundReply`: a step before the model call (the access token)
  // does not listen to the signal, and a reset there held a reply for 34 s (29 Sep, local).
  // Errors are logged by class only: provider errors can carry upstream detail (HANDOFF rule 11).
  const blocks = await boundReply(system, user, facts, signal, generate, lane, options.budgetMs);
  if (blocks) return { ...view, message: plainReply(blocks), replyBlocks: blocks };
  if (lane === "answer") {
    const fallback = factualReplyBlocks(facts, request);
    if (fallback.some((block) => block.type !== "paragraph")) return { ...view, message: plainReply(fallback), replyBlocks: fallback };
    return { ...view, replyBlocks: [{ type: "paragraph", segments: [{ text: view.message }] }] };
  }
  return view;
}
