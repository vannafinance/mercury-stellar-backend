/**
 * Page-aware AI assistant lane.
 *
 * Uses Gemini for free-form understanding — NOT a glossary lookup table or
 * canned Q&A. Glossary + page snapshot are grounding context only.
 *
 * Still zero MCP: live balances / "my HF" / writes fall through to the
 * existing read/write path. Never invent numbers.
 */

import glossaryJson from "@/data/glossary.json";
import type { ChatResponse, PageDescriptorCtx } from "./types";
import { generateText, VertexError } from "./vertex";

export type GlossaryEntry = {
  term: string;
  aliases: string[];
  short: string;
  detailed: string;
  why_it_matters: string;
  common_mistake?: string;
  related?: string[];
  pages?: string[];
};

const GLOSSARY = glossaryJson as Record<string, GlossaryEntry>;

/** Imperative / on-chain actions — must use MCP write path, not chat. */
const ACTION_INTENT =
  /\b(swap|lend|borrow|deposit|repay|redeem|withdraw|farm|supply|deploy|add\s+liquidity|remove\s+liquidity|enable\s+auto|disable\s+auto|create\s+(?:margin\s+)?account|transfer|bridge)\b/i;

/** Live personal portfolio reads — need MCP, not page snapshot alone. */
const LIVE_PERSONAL =
  /\b(my|mine|mera|meri)\b.+\b(health|hf|balance|collateral|debt|borrowed|position|wallet|pnl|apy|earnings?|rewards?)\b|\b(how much|what(?:'s| is)|do i have|am i)\b.+\b(my|i|mine)\b|\b(what(?:'s| is)\s+my|how\s+much\s+(?:do\s+i|have\s+i|i\s+have)|show\s+my|list\s+my|check\s+my)\b/i;

/**
 * Market / account data the user wants fetched live — MCP read tools.
 * Keep narrow so normal conversation is not stolen from Gemini.
 */
const LIVE_DATA_QUERY =
  /\b(list|show|fetch|get|check|query|look\s+up)\b.+\b(pool|pools|reserve|reserves|price|prices|apy|tvl|farm\s+overview|wallet|balance|health|position|positions|stats)\b|\b(all\s+earn\s+pools|earn\s+pools|blend\s+reserves|pool\s+stats|oracle\s+price|current\s+price)\b/i;

/**
 * True when this message should be answered conversationally by Gemini with
 * page context — not routed to MCP tools.
 */
export function isAssistantChat(message: string): boolean {
  const m = message.trim();
  if (!m) return false;

  // Explicit action → write/read path (unless purely definitional)
  if (ACTION_INTENT.test(m)) {
    const definitional =
      /\b(what(?:'s| is| are| does)|whats|explain|define|meaning|how does|how do|why|tell me about|difference between)\b/i.test(
        m,
      );
    if (!definitional) return false;
  }

  // Live personal values or market data queries → MCP
  if (LIVE_PERSONAL.test(m) || LIVE_DATA_QUERY.test(m)) return false;

  // Free-form product / page conversation for Gemini
  return true;
}

/** @deprecated use isAssistantChat — kept for any external callers */
export function classifyConcept(message: string): { mode: "assistant" } | null {
  return isAssistantChat(message) ? { mode: "assistant" } : null;
}

function renderPageContext(page: PageDescriptorCtx | null): string {
  if (!page) {
    return [
      "PAGE CONTEXT: none registered for this route.",
      "You can still explain Vanna products in general, but say you cannot see their screen numbers.",
    ].join("\n");
  }
  const metrics = (page.metrics || [])
    .slice(0, 12)
    .map(
      (m) =>
        `- ${m.label}: ${m.value ?? "(loading / unknown)"}${
          m.isPlaceholder ? "  [PLACEHOLDER — not real data]" : ""
        }`,
    )
    .join("\n");
  return [
    "CURRENT SCREEN (authoritative for on-screen numbers):",
    `title: ${page.title}`,
    `route: ${page.route}`,
    `purpose: ${page.purpose}`,
    `actions available in the product UI / copilot: ${(page.actions || []).join(", ") || "none listed"}`,
    "metrics the user can see right now:",
    metrics || "- (none registered)",
  ].join("\n");
}

function glossaryReferencePack(page: PageDescriptorCtx | null, message: string): string {
  const lower = message.toLowerCase();
  const pageRoute = page?.route;
  const entries = Object.entries(GLOSSARY);

  // Prefer terms mentioned in the question or tied to this page
  const scored = entries.map(([key, e]) => {
    let score = 0;
    if (pageRoute && e.pages?.includes(pageRoute)) score += 2;
    const hay = [e.term, ...e.aliases, key].join(" ").toLowerCase();
    if (hay.split(/\s+/).some((w) => w.length > 2 && lower.includes(w))) score += 5;
    if (e.term.toLowerCase().split(/\s+/).every((w) => lower.includes(w))) score += 3;
    return { key, e, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked =
    scored.filter((s) => s.score > 0).slice(0, 8).length > 0
      ? scored.filter((s) => s.score > 0).slice(0, 8)
      : scored.filter((s) => s.score >= 2).slice(0, 6).length
        ? scored.filter((s) => pageRoute && s.e.pages?.includes(pageRoute)).slice(0, 8)
        : scored.slice(0, 6);

  // Always include page-relevant pack as baseline
  const byPage = pageRoute
    ? entries.filter(([, e]) => e.pages?.includes(pageRoute)).slice(0, 10)
    : [];
  const map = new Map<string, GlossaryEntry>();
  for (const [, e] of byPage) map.set(e.term, e);
  for (const { e } of picked) map.set(e.term, e);

  const pack = [...map.values()].slice(0, 12).map((e) => ({
    term: e.term,
    meaning: e.detailed,
    why: e.why_it_matters,
    common_mistake: e.common_mistake || undefined,
  }));

  return JSON.stringify(pack, null, 2);
}

const ASSISTANT_SYSTEM = `You are Vanna Assistant — a smart, conversational in-app guide for Vanna Finance
(DeFi on Stellar / Soroban: Margin, Earn, Farm, Portfolio, Spot trade).

You talk like a helpful product expert, not a FAQ bot. Understand free-form English and Hinglish.
Adapt length to the question: short for simple asks, a bit fuller when the user is confused.

WHAT YOU KNOW:
- CURRENT SCREEN: what page they are on, its purpose, actions, and the exact metric labels/values shown.
- PRODUCT REFERENCE: curated term notes (health factor, Blend vs Aquarius USDC variants, vTokens, etc.).
  Use these as background knowledge — paraphrase in your own words. Do NOT dump them verbatim or
  recite them as a fixed script.

HARD RULES (never break these):
1. NUMBERS: Only state balances, APYs, health factors, rates, or other figures that appear in
   CURRENT SCREEN (or that the user just typed). If a metric is marked [PLACEHOLDER], say clearly
   it is a testnet placeholder / not real measured data. If you do not have a number, say you
   cannot see it and suggest they ask "what is my …" so live data can be fetched, or open the
   relevant page.
2. NO FAKE ON-CHAIN ACTIONS: Never claim you deposited, borrowed, swapped, or signed anything.
   You only explain and guide. Execution is a separate copilot path.
3. NO FINANCIAL ADVICE: Describe capabilities ("You can supply to Earn to earn yield") not orders
   ("You should borrow more" / "definitely farm 2x"). Risk is personal.
4. USDC VARIANTS: BLUSDC, AQUSDC, SOUSDC are different tokens. Do not treat bare "USDC" as
   interchangeable across Blend / Aquarius / Soroswap without saying so.
5. Liquidation threshold on Vanna margin is health factor 1.1 (not 1.3) when you need that fact —
   prefer CURRENT SCREEN if it shows LT.
6. Style: natural prose. No markdown headings, no code fences, no bullet walls unless the user
   asked for a list. You may use short paragraphs. Optional: one clarifying question at the end
   if it helps.

If the user wants a live personal figure ("my health factor", "my balance") or an action
("lend 10 XLM", "swap…"), tell them briefly you can handle that as a command — they can rephrase
as the action itself or open Full copilot — but if this turn is only explanatory, just explain.`;

export type AssistantChatOpts = {
  /** Prior turns for multi-turn continuity (user/assistant alternating). */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
};

/**
 * Free-form Gemini answer grounded on page + product reference.
 * No canned replies, no hardcoded chip lines.
 */
export async function answerAssistant(
  message: string,
  page: PageDescriptorCtx | null,
  request_id: string,
  opts?: AssistantChatOpts,
): Promise<ChatResponse> {
  const pageBlock = renderPageContext(page);
  const refPack = glossaryReferencePack(page, message);

  const historyBlock =
    opts?.history && opts.history.length > 0
      ? [
          "RECENT CONVERSATION (oldest first):",
          ...opts.history.slice(-8).map((t) => `${t.role.toUpperCase()}: ${t.text}`),
          "",
        ].join("\n")
      : "";

  const user = [
    pageBlock,
    "",
    "PRODUCT REFERENCE (paraphrase freely — not a script):",
    refPack,
    "",
    historyBlock,
    `USER: ${message}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const prose = await generateText(ASSISTANT_SYSTEM, user, { temperature: 0.55 });
    return {
      kind: "answer",
      message: prose,
      data: {
        assistant: true,
        page_route: page?.route ?? null,
      },
      intent: {
        template_id: "assistant_chat",
        slots: { route: page?.route ?? null, mode: "generative" },
      },
      request_id,
    };
  } catch (e) {
    const hint =
      e instanceof VertexError
        ? " (The language model is temporarily unavailable — try again in a moment.)"
        : "";
    // Minimal non-canned fallback: honest failure, still page-aware one-liner
    const where = page
      ? `You're on ${page.title}: ${page.purpose}`
      : "I could not reach the model just now.";
    return {
      kind: "answer",
      message: `${where}${hint}`,
      data: { assistant: true, offline: true },
      intent: {
        template_id: "assistant_chat",
        slots: { mode: "model_unavailable" },
      },
      request_id,
    };
  }
}

/** @deprecated use answerAssistant */
export async function answerConcept(
  _hit: unknown,
  message: string,
  page: PageDescriptorCtx | null,
  request_id: string,
): Promise<ChatResponse> {
  return answerAssistant(message, page, request_id);
}
