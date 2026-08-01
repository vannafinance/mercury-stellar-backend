/**
 * Page-aware assistant: Gemini answers from LIVE page snapshot (DOM).
 * No hand-coded per-page registry. Glossary is optional background only.
 */

import glossaryJson from "@/data/glossary.json";
import type { ChatResponse, PageDescriptorCtx, PageSnapshotCtx } from "./types";
import { generateText, VertexError } from "./vertex";

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

const LIVE_PERSONAL =
  /\b(my|mine|mera|meri)\b.+\b(health|hf|balance|collateral|debt|borrowed|position|wallet|pnl|apy|earnings?|rewards?)\b|\b(what(?:'s| is)\s+my|how\s+much\s+(?:do\s+i|have\s+i|i\s+have)|show\s+my|list\s+my|check\s+my)\b/i;

const LIVE_DATA_QUERY =
  /\b(list|show|fetch|get|check|query|look\s+up)\b.+\b(pool|pools|reserve|reserves|price|prices|apy|tvl|farm\s+overview|wallet|balance|health|position|positions|stats)\b|\b(all\s+earn\s+pools|earn\s+pools|blend\s+reserves|pool\s+stats|oracle\s+price|current\s+price)\b/i;

export function isAssistantChat(message: string): boolean {
  const m = message.trim();
  if (!m) return false;

  if (ACTION_INTENT.test(m)) {
    const definitional =
      /\b(what(?:'s| is| are| does)|whats|explain|define|meaning|how does|how do|why|tell me about|difference between)\b/i.test(
        m,
      );
    if (!definitional) return false;
  }
  if (LIVE_PERSONAL.test(m) || LIVE_DATA_QUERY.test(m)) return false;
  return true;
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
