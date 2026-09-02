/**
 * Page-aware assistant: Gemini answers from LIVE page snapshot (DOM).
 * No hand-coded per-page registry. Glossary is optional background only.
 */

import glossaryJson from "@/data/glossary.json";
import type { ChatResponse, PageDescriptorCtx, PageSnapshotCtx } from "./types";
import { generateText, VertexError } from "./vertex";
import { ASSET_SYMBOL_PATTERN } from "./registry/assets";

type GlossaryEntry = {
  term: string;
  aliases: string[];
  short: string;
  detailed: string;
  why_it_matters: string;
  common_mistake?: string;
  pages?: string[];
};

const GLOSSARY = glossaryJson as Record<string, GlossaryEntry>;

const ACTION_INTENT =
  /\b(swap|lend|borrow|deposit|repay|redeem|withdraw|farm|supply|deploy|add\s+liquidity|remove\s+liquidity|enable\s+auto|disable\s+auto|create\s+(?:margin\s+)?account|transfer|bridge)\b/i;

/**
 * "Tell me about MY account" — always the copilot, never the page guide.
 *
 * Every inflection is spelled out because a trailing `\b` after a singular stem does not
 * match its plural: `position\b` fails on "positions", since `s` is a word character.
 * That single detail sent "what are my positions" — the most common question this
 * surface gets — to the page assistant, which has no MCP access and answered "I do not
 * have access to your live wallet balances or active positions" while the copilot was
 * sitting behind it with the numbers. The singular "what is my position" worked, which
 * is how it survived: it reads as a phrasing quirk rather than a whole class of failure.
 *
 * "what are" is in the possessive alternation for the same reason — it was absent, so
 * only "what is my …" and "what's my …" were recognised.
 */
/**
 * "whats my helth factr" (G-06, typos and all) has to reach this second branch, which
 * asks for the question FRAME only ("what's my …") and never checks the noun that
 * follows — so a typo in "health factor" never matters here, unlike the first branch.
 * "whats" (no apostrophe) was missing from the frame alternatives even though
 * `DEFINITIONAL` below already treats it as equivalent to "what's" — that mismatch is
 * what let the message fall all the way through to the generic concept explainer,
 * which then wrongly claimed "I cannot view your personal account balances".
 */
const LIVE_PERSONAL =
  /\b(my|mine|mera|meri)\b.+\b(health|hf|balances?|collaterals?|debts?|borrowed|borrowings?|positions?|holdings?|exposures?|portfolios?|wallets?|accounts?|pnl|apy|credit|earnings?|rewards?)\b|\b(what(?:'s|s| is| are)\s+my|how\s+much\s+(?:do\s+i|have\s+i|i\s+have|can\s+i)|show\s+my|list\s+my|check\s+my|am\s+i\s+(?:safe|at\s+risk|close\s+to))\b/i;

const LIVE_DATA_QUERY =
  /\b(list|show|fetch|get|check|query|look\s+up)\b.+\b(pool|pools|reserve|reserves|price|prices|apy|tvl|farm\s+overview|wallet|balance|health|position|positions|stats)\b|\b(all\s+earn\s+pools|earn\s+pools|blend\s+reserves|pool\s+stats|oracle\s+price|current\s+price)\b/i;

/**
 * Explicit "explain something to me" framing.
 *
 * Comparisons count. The Guide's own follow-up chips are phrased as them ("how is that
 * different from Earn?") and only matched "difference between", so clicking the question
 * the Guide had just offered routed to the MCP router instead of back to the Guide. A
 * comparison of two real assets is caught earlier by MARKET_NOUN + ASSET_SYMBOL, so this
 * cannot swallow "compare the XLM and USDC pools".
 */
const DEFINITIONAL =
  /\b(what(?:'s| is| are| does)|whats|explain|define|definition|meaning|how\s+(?:does|do|can|to)|why|tell me about|differ|differs|different|difference|compared\s+to|versus|vs\.?|what happens|is it safe|should i)\b/i;

/**
 * "Tell me about what I'm looking at" — the page agent's home question.
 *
 * Kept separate from DEFINITIONAL because the phrasings share no stem: people ask
 * "what am I looking at?", "walk me through this screen", "what does this mean?", none
 * of which start with "what is". Without this they missed the assistant, fell through
 * to the MCP router, and came back as a clarification for a question about a page that
 * was sitting right there in the request.
 */
const PAGE_REFERENTIAL =
  /\b(what|where)\s+am\s+i\b|\b(looking\s+at|on\s+(?:my\s+)?screen|this\s+page|this\s+screen|shown\s+here)\b|\b(what|how)\s+does\s+(this|that|it)\b|\b(what|who)\s+(is|are)\s+(this|that|these|those)\b|\b(explain|walk\s+me\s+through|describe)\s+(this|the\s+page|the\s+screen)\b/i;

/**
 * "What can you do?" — a question about the assistant, answered by the assistant.
 *
 * Mirrors SELF_REFERENTIAL in domain-firewall.ts. Kept in both places deliberately: the
 * firewall decides whether to spend a token at all, this decides which surface answers.
 */
const SELF_REFERENTIAL =
  /\b(what|which)\s+(can|could|do|does)\s+(you|u|this|it)\b|\bwhat\s+(are\s+you|is\s+this)\b|\b(who|what)\s+are\s+you\b|\b(your|you)\s+(capabilities|features|abilities|commands|tools)\b|\b(how\s+do\s+i\s+(use|start)|getting\s+started|what\s+should\s+i\s+ask)\b/i;

/** A concrete market datum… */
const MARKET_NOUN =
  /\b(price|prices|apy|apr|yield|tvl|utilization|liquidity|pool|pools|reserve|reserves|stats|rate|rates)\b/i;
/**
 * …attached to a real asset means "look it up", not "explain it".
 *
 * "What is Current Rate of bXLM?" fell through to the concept explainer instead of the
 * live Blend reserve rate — "rate" satisfies `MARKET_NOUN`, but `\bXLM\b` can never match
 * inside "bXLM" (no word-boundary between "b" and "X"), so this override never fired. Same
 * composite-bToken gap already fixed in the domain firewall and the asset registry —
 * fixed HERE for good by reading the same registry those two now read, instead of a
 * third hand-copied list that would silently fall behind again the next time an asset or
 * spelling is added. Bare "USDC" is added on top: the registry deliberately excludes it
 * (BLUSDC/AQUSDC/SOUSDC are three separate tokens, and naming none of them is a question,
 * not an asset — see registry/assets.ts's file header) but "what is the price of USDC" is
 * still a live-data lookup, not a concept question.
 */
const ASSET_SYMBOL = new RegExp(ASSET_SYMBOL_PATTERN.source + "|\\busdc\\b", "i");

/**
 * True only for genuine concept questions ("what is Blend?").
 *
 * This deliberately defaults to FALSE. It used to default to true — anything that did
 * not match an allow-list of "live" phrasings fell through to the page assistant, which
 * has no MCP access and so answered market questions with "I do not have access to
 * real-time prices". That swallowed the most basic reads there are: "price of XLM",
 * "which Blend reserve pays more", "compare the XLM and USDC pools". Routing is now
 * opt-in for the assistant, so an unrecognised message goes to the copilot, where the
 * router can at worst ask for clarification instead of refusing outright.
 */
export function isAssistantChat(message: string): boolean {
  const m = message.trim();
  if (!m) return false;

  // Live data wins even when phrased as a question: "what is the price of XLM?" is a
  // lookup, not a concept question.
  if (LIVE_PERSONAL.test(m) || LIVE_DATA_QUERY.test(m)) return false;
  if (MARKET_NOUN.test(m) && ASSET_SYMBOL.test(m)) return false;

  // Questions about the surface itself: only the page agent has the page.
  if (PAGE_REFERENTIAL.test(m)) return true;

  // Questions about the assistant's own capabilities. These belong to the Guide, not the
  // MCP router — there is no tool that answers "what can you do", so routing them to the
  // copilot produced a clarification asking the user to rephrase.
  if (SELF_REFERENTIAL.test(m)) return true;

  // An action instruction is a write unless it is framed as a how-to
  // ("how do I deposit XLM as collateral?" is still assistant work).
  if (ACTION_INTENT.test(m) && !DEFINITIONAL.test(m)) return false;

  return DEFINITIONAL.test(m);
}

export function classifyConcept(message: string): { mode: "assistant" } | null {
  return isAssistantChat(message) ? { mode: "assistant" } : null;
}

function lightGlossaryHints(message: string, path?: string | null): string {
  const lower = message.toLowerCase();
  const hits: GlossaryEntry[] = [];
  for (const e of Object.values(GLOSSARY)) {
    const terms = [e.term, ...e.aliases].map((a) => a.toLowerCase());
    if (terms.some((t) => t.length > 2 && lower.includes(t))) hits.push(e);
  }
  if (hits.length < 3 && path) {
    const routeKey = path.includes("farm")
      ? "farm"
      : path.includes("earn")
        ? "earn"
        : path.includes("margin") || path === "/"
          ? "margin"
          : path.includes("portfolio")
            ? "portfolio"
            : path.includes("trade")
              ? "trade-spot"
              : null;
    if (routeKey) {
      for (const e of Object.values(GLOSSARY)) {
        if (e.pages?.includes(routeKey) && hits.length < 6) hits.push(e);
      }
    }
  }
  const uniq = new Map(hits.map((e) => [e.term, e]));
  const pack = [...uniq.values()].slice(0, 8).map((e) => ({
    term: e.term,
    note: e.detailed,
    caveat: e.common_mistake,
  }));
  if (!pack.length) return "(none matched)";
  return JSON.stringify(pack, null, 2);
}

function renderSnapshot(snap: PageSnapshotCtx | null): string {
  if (!snap?.visible_text?.trim() && !snap?.region_text?.trim() && !snap?.selection) {
    return "LIVE PAGE: (no snapshot received — say you cannot see the page content yet.)";
  }

  const metrics =
    Array.isArray((snap as { metrics?: unknown }).metrics) &&
    ((snap as { metrics?: Array<{ label: string; value: string }> }).metrics?.length ?? 0) > 0
      ? ((snap as { metrics: Array<{ label: string; value: string }> }).metrics
          .slice(0, 30)
          .map((m) => `- ${m.label}: ${m.value}`)
          .join("\n") || "")
      : "";

  return [
    "LIVE PAGE (browser DOM — source of truth for on-screen numbers):",
    `url: ${snap.url || snap.path || "?"}`,
    `document title: ${snap.title || "?"}`,
    `path: ${snap.path || "?"}`,
    snap.selection ? `USER TEXT HIGHLIGHT:\n"""${snap.selection}"""` : "USER TEXT HIGHLIGHT: (none)",
    snap.region_text
      ? `USER SCREEN REGION (drawn box):\n"""${String(snap.region_text).slice(0, 6000)}"""`
      : "USER SCREEN REGION: (none)",
    snap.headings?.length ? `headings: ${snap.headings.slice(0, 20).join(" | ")}` : "",
    metrics ? `structured metrics:\n${metrics}` : "",
    "",
    "VISIBLE PAGE TEXT:",
    "-----",
    String(snap.visible_text || "").slice(0, 12_000),
    "-----",
    "If a figure looks decorative or stuck at zero, say you are unsure it is live data.",
  ]
    .filter(Boolean)
    .join("\n");
}

const ASSISTANT_SYSTEM = `You are Vanna’s in-page assistant (like Gemini’s side panel in Chrome).
You help the user understand THIS webpage while they keep working.

Ground every answer in LIVE PAGE text / region / highlight. You are not a generic chatbot.

VOICE & POLISH:
- Calm, expert, concise. Product guide — not sales, not a ticket bot.
- Hinglish is fine if the user uses it.
- Lead with a one-sentence direct answer, then structured options when useful.

OUTPUT FORMAT (strict — the UI renders this as designed type, not raw markdown):
- NEVER use asterisks for bold/italic. No **text**, no *text*, no __text__.
- NEVER use markdown headings (#) or code fences (\`\`\`).
- NEVER use raw hyphen bullets with ** labels.
- Use plain section titles on their own line (Title Case, no trailing junk), for example:
  What you can do
- Numbered options as:
  1. Short title — one or two sentences of detail.
  2. Next option — detail.
- Simple lists as lines starting with "• " (bullet character), not "-" or "*".
- Keep total length reasonable: usually 120–220 words unless the user asks for deep detail.
- Optional single closing question, one sentence, no pressure.

CONTENT RULES:
1. Numbers: only from LIVE PAGE, REGION, HIGHLIGHT, or the user message. Never invent balances/APYs/HF.
2. Thin snapshot → say you cannot see enough; do not invent UI.
3. Placeholders / all-zero demo stats → flag uncertainty.
4. Never claim you executed a trade or signature.
5. No financial advice ("you should 5x"). Describe options neutrally.
6. Health factor liquidation context on Vanna is ~1.1 when needed; prefer page text.
7. BLUSDC, AQUSDC, SOUSDC are different tokens — do not conflate.
8. When asked "what can I do with …", list 3–5 realistic in-app paths tied to what is on the page (Swap, Earn, Farm, Margin, Portfolio) — not generic crypto tips.

PRODUCT REFERENCE notes below are background only — never override LIVE PAGE numbers.`;

export type AssistantChatOpts = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  page_snapshot?: PageSnapshotCtx | null;
};

export async function answerAssistant(
  message: string,
  _page: PageDescriptorCtx | null,
  request_id: string,
  opts?: AssistantChatOpts,
): Promise<ChatResponse> {
  const snap = opts?.page_snapshot ?? null;
  const pageBlock = renderSnapshot(snap);
  const path = snap?.path || "";
  const ref = lightGlossaryHints(message, path);

  const historyBlock =
    opts?.history && opts.history.length > 0
      ? [
          "RECENT TURNS:",
          ...opts.history.slice(-6).map((t) => `${t.role}: ${t.text.slice(0, 1500)}`),
          "",
        ].join("\n")
      : "";

  const user = [
    pageBlock,
    "",
    "PRODUCT REFERENCE (optional — paraphrase, never recite as a script):",
    ref,
    "",
    historyBlock,
    `USER REQUEST: ${message}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const prose = await generateText(ASSISTANT_SYSTEM, user, { temperature: 0.4 });
    // Belt-and-suspenders: strip stars if the model ignores format
    const cleaned = prose
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .trim();

    return {
      kind: "answer",
      message: cleaned,
      data: {
        assistant: true,
        page_path: path || null,
        used_dom: Boolean(snap?.visible_text?.trim() || snap?.region_text?.trim()),
        selection: Boolean(snap?.selection),
        model: "vertex",
      },
      intent: {
        template_id: "page_assist",
        slots: { path: path || null, mode: "dom_grounded" },
      },
      request_id,
    };
  } catch (e) {
    const hint = e instanceof VertexError ? " Model temporarily unavailable." : "";
    return {
      kind: "answer",
      message: `I could not read the page with the model just now.${hint} Try again in a moment.`,
      data: { assistant: true, offline: true },
      intent: { template_id: "page_assist", slots: { mode: "unavailable" } },
      request_id,
    };
  }
}

export async function answerConcept(
  _hit: unknown,
  message: string,
  page: PageDescriptorCtx | null,
  request_id: string,
): Promise<ChatResponse> {
  return answerAssistant(message, page, request_id);
}
