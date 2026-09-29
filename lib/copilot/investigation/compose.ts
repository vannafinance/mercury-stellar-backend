import { copilotConfig } from "../config";
import { generateInvestigationJson } from "../vertex";
import { healthOnContractBasis } from "./answer";
import { bindSegments, formatFactValue } from "./answer-prose";
import { REQUESTED_ACTIONS_ID } from "./candidate-id";
import { OP_FLOW, type WorkflowOp, type WorkflowView } from "../workflow/types";
import { resolveAssetDef } from "../registry/assets";
import { pct, shownApyPct } from "./apy";
import type { RateComparison } from "./rate-comparison";
import { doneClause } from "./completion";
import type { ReplyBlock, ReplySegment, ResearchFact, ResearchView } from "./view";

/**
 * The model writes the reply; code writes every figure in it.
 *
 * Every answer on the investigate path was assembled from sentence templates ("I could not
 * read a live figure…", "Your reported margin debt is $X."), so it read like a form letter
 * next to the same model answering in its own chat. This asks the model to write the answer
 * as a few plain blocks, citing each figure by fact id; `bindSegments` substitutes the audited
 * values and refuses a reply that names an unread fact, types a digit itself, or carries markup.
 * Anything refused, late, or out of scope keeps the deterministic reply unchanged — so a
 * composed answer can only ever say what the reads already said, in better words.
 *
 * Scope: factual answers (a question about the account, prices, positions) and the words
 * above a strategy's plan cards. Questionnaires, refusals, warnings, direct actions and
 * executions keep their own replies.
 */

const COMPOSE_BUDGET_MS = 6_000;
const MAX_BLOCKS = 8;
const MAX_ITEMS = 12;

const SYSTEM = `You write the reply a user reads in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar).
You are given the user's question and FACTS read live from their account and the protocol. Write the answer the way a sharp, friendly analyst would reply in a chat app.

Figures: every number, amount, price, rate, health factor, or address MUST appear as {{factId}} using an id from FACTS, and nothing else. Each {{factId}} is replaced by exactly that fact's "shown" text, unit and currency sign included, so never write the unit again beside it. Never type a digit yourself, not even in words like "2x" or a list number. If a figure you want is not in FACTS, leave it out.
Shape: answer in ONE paragraph of one to three sentences that leads with the direct answer; related figures belong in that same paragraph, never a new paragraph per sentence. Add a short bullet list only when three or more figures belong together (holdings per venue, a breakdown). Use a heading only when the reply has two distinct parts. Keep it under about 110 words. Say what a figure means for the user when that helps (e.g. whether a health factor leaves room), without advice to trade.
Plain text only: no markdown symbols, asterisks, hashes, underscores, backticks or links. Mention only facts that answer the question. Do not invent reasons, venues, or events. "draft" is the current plain answer, given for meaning only.
Return JSON: {"blocks":[{"type":"paragraph","text":"..."},{"type":"bullets","items":["...","..."]},{"type":"heading","text":"..."}]}`;

const PLANS_SYSTEM = `You write the reply shown above a set of plan cards in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar). The cards already show every step and figure; your words help the user choose, the way a thoughtful analyst would explain options in a chat app.
You are given the user's request and PLANS, each with facts computed by the sizer. Plans are named by letter, exactly as the cards label them: "Plan A", "Plan B" and so on.
Figures: every number, amount, rate, or health factor MUST appear as {{factId}} using an id from PLANS, and nothing else. Each {{factId}} is replaced by exactly that fact's "shown" text, unit and currency sign included, so never write the unit again beside it. Never type a digit yourself. If a figure you want is not given, leave it out.
Shape: two short paragraphs. The first says which plan leads and why, using "lead" (the sizer's reason: already_held = it uses a token the user already holds, thin_margin = the rates are within noise so the held token wins, net_return = the best return at the user's size). The second says how the other plans differ, in a sentence or two, and that nothing runs until they approve a plan. Use a bullet list instead of the second paragraph only when there are four or more plans.
Plain text only: no markdown symbols, asterisks, hashes, underscores, backticks or links. Do not invent risks, venues, or reasons. "draft" is the current plain reply, given for meaning only.
Return JSON: {"blocks":[{"type":"paragraph","text":"..."},{"type":"paragraph","text":"..."}]}`;

const COMPLETION_SYSTEM = `You write the reply shown once a user's transactions have finished, in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar). Say what happened and what it means now, the way a helpful analyst would confirm a completed trade in a chat app.
You are given the user's request and FACTS: each settled step (what was done, the amount), the rate a step now earns or costs, and, when it was read after the run, the account's health factor now.
Figures: every number, amount, rate, or health factor MUST appear as {{factId}} using an id from FACTS, and nothing else. Each {{factId}} is replaced by exactly that fact's "shown" text, unit and currency sign included, so never write the unit again beside it. Never type a digit yourself.
Shape: ONE paragraph of one to three sentences. Open by confirming what was done. Then what it now earns or costs, and the health factor now if given. If some steps did not go through ("stopped" is given), say plainly which part ran and that the rest was not submitted. Add a bullet list only when four or more steps settled.
Plain text only: no markdown symbols, asterisks, hashes, underscores, backticks or links. Do not invent outcomes, rates, or next steps. "draft" is the current plain reply, given for meaning only.
Return JSON: {"blocks":[{"type":"paragraph","text":"..."}]}`;

type Generate = (system: string, user: string, signal: AbortSignal) => Promise<unknown>;

/** The only shapes a reply may take, enforced by the decoder rather than asked for in words. */
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_BLOCKS,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["paragraph", "heading", "bullets"] },
          text: { type: "string" },
          items: { type: "array", items: { type: "string" }, maxItems: MAX_ITEMS },
        },
        required: ["type"],
      },
    },
  },
  required: ["blocks"],
};

const defaultGenerate: Generate = (system, user, signal) =>
  generateInvestigationJson(copilotConfig.vertexModel, system, user, signal, "LOW", [], REPLY_SCHEMA);

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

/**
 * Each plan's figures as the sizer computed them, keyed by the letter its card shows. Only
 * these reach the model on a strategy turn, never the raw reads, so every figure it can
 * cite is one the card itself shows.
 */
export function planFacts(view: ResearchView): {
  facts: ResearchFact[];
  plans: Array<{ plan: string; borrows: boolean; facts: Array<{ id: string; label: string; shown: string }> }>;
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
    facts.push(...own);
    return { plan: letter, borrows: candidate.borrows, facts: own.map((fact) => ({ id: fact.id, label: fact.label, shown: formatFactValue(fact) })) };
  });
  return { facts, plans, lead: feasible[0]?.decision?.factor ?? null };
}

/**
 * A finished run's facts: each settled step from the journal (never the browser's copy), the
 * rate it earns or costs from the sealed reads, and the health factor read after it ran.
 */
export function completionFacts(view: WorkflowView, comparisons: readonly RateComparison[], healthNow: string | null): ResearchFact[] {
  const facts: ResearchFact[] = [];
  const add = (id: string, label: string, value: string, unit: string) =>
    facts.push({ id, label, value, unit, venue: "margin", evidenceId: "run", sourcePath: id, readAt: 0 });
  view.steps.filter((step) => step.status === "settled").forEach((step, index) => {
    const n = index + 1;
    const def = resolveAssetDef(step.asset);
    add(`step${String.fromCharCode(64 + n)}:done`, "what was done", doneClause(step), "");
    if (step.amount) add(`step${String.fromCharCode(64 + n)}:amount`, "amount settled", step.amount, def?.displayLabel ?? step.asset);
    const kind = OP_FLOW[step.op as WorkflowOp]?.rate;
    const row = kind ? comparisons.find((comparison) => comparison.asset === step.asset) : undefined;
    const apr = kind === "earn_supply" ? row?.earnSupplyApr : kind === "blend_supply" ? row?.blendSupplyApr : kind === "earn_borrow" ? row?.marginBorrowApr : null;
    if (kind && apr != null && Number.isFinite(Number(apr))) {
      add(`step${String.fromCharCode(64 + n)}:rate`, kind === "earn_borrow" ? "borrow cost now" : "earning now", pct(shownApyPct(kind, apr)), kind === "earn_borrow" ? "% a year" : "% APY");
    }
  });
  if (healthNow) add("account:health_now", "health factor now", healthNow, "HF");
  return facts;
}

/**
 * The finished reply composed around the run's own facts, or null to keep the deterministic
 * one. Never throws.
 */
export async function composeCompletion(input: {
  view: WorkflowView;
  request: string;
  draft: string;
  comparisons: readonly RateComparison[];
  healthNow: string | null;
}, signal: AbortSignal, generate: Generate = defaultGenerate): Promise<{ message: string; blocks: ReplyBlock[] } | null> {
  if (process.env.COPILOT_COMPOSED_REPLIES === "off") return null;
  const facts = completionFacts(input.view, input.comparisons, input.healthNow);
  if (!facts.length) return null;
  const stopped = input.view.status !== "completed";
  const user = JSON.stringify({
    request: input.request,
    facts: facts.map((fact) => ({ id: fact.id, label: fact.label, shown: formatFactValue(fact) })),
    ...(stopped ? { stopped: `${input.view.status}; later steps were not submitted` } : {}),
    draft: input.draft,
  });
  const bound = await boundReply(COMPLETION_SYSTEM, user, facts, signal, generate);
  return bound ? { message: plainReply(bound), blocks: bound } : null;
}

/** One budgeted model call, bound to `facts`, or null. Shared by every composed reply. */
async function boundReply(system: string, user: string, facts: readonly ResearchFact[], signal: AbortSignal, generate: Generate): Promise<ReplyBlock[] | null> {
  try {
    const budget = AbortSignal.any([signal, AbortSignal.timeout(COMPOSE_BUDGET_MS)]);
    const raw = await Promise.race([
      generate(system, user, budget),
      new Promise<never>((_, reject) => {
        if (budget.aborted) reject(new DOMException("compose budget", "TimeoutError"));
        budget.addEventListener("abort", () => reject(new DOMException("compose budget", "TimeoutError")), { once: true });
      }),
    ]);
    const bound = bindBlocks(raw, facts);
    if (!bound.ok) {
      console.info("[copilot] composed reply refused", { reason: bound.reason });
      return null;
    }
    return bound.blocks;
  } catch (error) {
    console.info("[copilot] composed reply unavailable", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/** A factual answer the composer may rewrite. Everything else keeps its own reply. */
export function composable(view: ResearchView): boolean {
  return view.status === "researched"
    && view.understanding?.intent === "answer"
    && view.facts.length > 0
    // Live, 29 Sep: given the contract-basis read, the model told the user "1.83" — the figure
    // the owner ruled out. Those facts are never handed to the composer.
    && !healthOnContractBasis(view.facts)
    && !view.warnings.length
    && !view.questionnaire
    && !view.pendingWrite
    && !view.choices?.length
    && !view.candidates?.feasible?.length
    && !view.proposalCandidateId;
}

function textOf(segments: readonly ReplySegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/** Flattened for `message`, history and any surface that renders plain text. */
export function plainReply(blocks: readonly ReplyBlock[]): string {
  return blocks.map((block) => block.type === "bullets"
    ? block.items.map((item) => `• ${textOf(item)}`).join("\n")
    : textOf(block.segments)).join("\n\n");
}

/** Bind the model's blocks to the facts, or say why they are refused. Pure; exported for tests. */
export function bindBlocks(raw: unknown, facts: readonly ResearchFact[]): { ok: true; blocks: ReplyBlock[] } | { ok: false; reason: string } {
  const blocks = (raw as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_BLOCKS) return { ok: false, reason: "no usable blocks" };
  const out: ReplyBlock[] = [];
  let figures = 0;
  const bind = (text: unknown) => {
    if (typeof text !== "string" || !text.trim() || text.length > 700) return null;
    const bound = bindSegments(text, facts);
    if (!bound.ok) return bound.reason;
    figures += bound.cited.length;
    return bound.segments;
  };
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (block?.type === "paragraph" || block?.type === "heading") {
      const segments = bind(block.text);
      if (!Array.isArray(segments)) return { ok: false, reason: segments ?? `empty ${String(block.type)}` };
      out.push({ type: block.type, segments });
    } else if (block?.type === "bullets" && Array.isArray(block.items) && block.items.length && block.items.length <= MAX_ITEMS) {
      const items: ReplySegment[][] = [];
      for (const item of block.items) {
        const segments = bind(item);
        if (!Array.isArray(segments)) return { ok: false, reason: segments ?? "empty bullet" };
        items.push(segments);
      }
      out.push({ type: "bullets", items });
    } else {
      return { ok: false, reason: "unknown block" };
    }
  }
  // An answer about the account that cites none of what was read has answered nothing.
  if (figures === 0) return { ok: false, reason: "reply cites no fact" };
  return { ok: true, blocks: out };
}

/**
 * The view with its reply written by the model around the audited figures, or the view
 * unchanged. Never throws: a composed reply is an improvement, never a dependency.
 */
export async function composeReply(view: ResearchView, signal: AbortSignal, generate: Generate = defaultGenerate): Promise<ResearchView> {
  if (process.env.COPILOT_COMPOSED_REPLIES === "off") return view;
  const request = [view.originalRequest, ...view.refinements].filter(Boolean).join("\n");
  let system: string;
  let user: string;
  let facts: readonly ResearchFact[];
  if (composable(view)) {
    system = SYSTEM;
    facts = view.facts;
    user = JSON.stringify({
      question: request,
      facts: view.facts.map((fact) => ({ id: fact.id, label: fact.label, shown: formatFactValue(fact), venue: fact.venue })),
      draft: view.message,
    });
  } else if (composablePlans(view)) {
    const plans = planFacts(view);
    if (!plans.facts.length) return view;
    system = PLANS_SYSTEM;
    facts = plans.facts;
    user = JSON.stringify({ request, plans: plans.plans, lead: plans.lead, draft: view.message });
  } else {
    return view;
  }
  // Raced, not only signalled, in `boundReply`: a step before the model call (the access token)
  // does not listen to the signal, and a reset there held a reply for 34 s (29 Sep, local).
  // Errors are logged by class only: provider errors can carry upstream detail (HANDOFF rule 11).
  const blocks = await boundReply(system, user, facts, signal, generate);
  return blocks ? { ...view, message: plainReply(blocks), replyBlocks: blocks } : view;
}
