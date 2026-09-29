import { copilotConfig } from "../config";
import { generateInvestigationJson } from "../vertex";
import { healthOnContractBasis } from "./answer";
import { bindSegments, formatFactValue } from "./answer-prose";
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
 * Scope for now: factual answers (a question about the account, prices, positions). Plans,
 * questionnaires, refusals, warnings and executions keep their own replies.
 */

const COMPOSE_BUDGET_MS = 6_000;
const MAX_BLOCKS = 8;
const MAX_ITEMS = 12;

const SYSTEM = `You write the reply a user reads in the chat of a DeFi copilot (Vanna: margin account, lending, liquidity on Stellar).
You are given the user's question and FACTS read live from their account and the protocol. Write the answer the way a sharp, friendly analyst would reply in a chat app.

Figures: every number, amount, price, rate, health factor, or address MUST appear as {{factId}} using an id from FACTS, and nothing else. Each {{factId}} is replaced by exactly that fact's "shown" text, unit and currency sign included, so never write the unit again beside it. Never type a digit yourself, not even in words like "2x" or a list number. If a figure you want is not in FACTS, leave it out.
Shape: lead with the direct answer to the question in one sentence. Add a short bullet list only when several figures belong together (holdings per venue, a breakdown). Use a heading only when the reply has two distinct parts. Keep it under about 110 words. Say what a figure means for the user when that helps (e.g. whether a health factor leaves room), without advice to trade.
Plain text only: no markdown symbols, asterisks, hashes, underscores, backticks or links. Mention only facts that answer the question. Do not invent reasons, venues, or events. "draft" is the current plain answer, given for meaning only.
Return JSON: {"blocks":[{"type":"paragraph","text":"..."},{"type":"bullets","items":["...","..."]},{"type":"heading","text":"..."}]}`;

type Generate = (system: string, user: string, signal: AbortSignal) => Promise<unknown>;

const defaultGenerate: Generate = (system, user, signal) =>
  generateInvestigationJson(copilotConfig.vertexModel, system, user, signal, "LOW");

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
  if (process.env.COPILOT_COMPOSED_REPLIES === "off" || !composable(view)) return view;
  const request = [view.originalRequest, ...view.refinements].filter(Boolean).join("\n");
  const user = JSON.stringify({
    question: request,
    facts: view.facts.map((fact) => ({ id: fact.id, label: fact.label, shown: formatFactValue(fact), venue: fact.venue })),
    draft: view.message,
  });
  try {
    const raw = await generate(SYSTEM, user, AbortSignal.any([signal, AbortSignal.timeout(COMPOSE_BUDGET_MS)]));
    const bound = bindBlocks(raw, view.facts);
    if (!bound.ok) {
      console.info("[copilot] composed reply refused", { reason: bound.reason });
      return view;
    }
    return { ...view, message: plainReply(bound.blocks), replyBlocks: bound.blocks };
  } catch (error) {
    // Class only: provider errors can carry upstream detail (HANDOFF rule 11).
    console.info("[copilot] composed reply unavailable", { error: error instanceof Error ? error.name : "unknown" });
    return view;
  }
}
