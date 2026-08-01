/**
 * Page-aware assistant: Gemini answers from LIVE page snapshot (DOM),
 * not a hand-coded per-page registry.
 *
 * Glossary is optional background only. Never invent numbers not on the page
 * or in the snapshot. Live "my balance" / on-chain actions still use MCP.
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

/**
 * Free-form page Q&A → Gemini with DOM snapshot.
 * Actions / live account data → MCP (return false).
 */
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
  // path-based soft hints (not a page allowlist — just richer refs)
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
              : path.includes("analytics")
                ? "margin"
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

function renderSnapshot(snap: PageSnapshotCtx | null, legacy?: PageDescriptorCtx | null): string {
  if (snap?.visible_text?.trim()) {
    return [
      "LIVE PAGE (extracted from what the user currently sees in the browser):",
      `url: ${snap.url || snap.path || "?"}`,
      `document title: ${snap.title || "?"}`,
      `path: ${snap.path || "?"}`,
      snap.selection ? `USER HIGHLIGHT / SELECTION:\n"""${snap.selection}"""` : "USER HIGHLIGHT: (none)",
      snap.headings?.length ? `headings: ${snap.headings.slice(0, 20).join(" | ")}` : "",
      "",
      "VISIBLE PAGE TEXT:",
      "-----",
      snap.visible_text.slice(0, 12_000),
      "-----",
      "Treat the text above as the source of truth for what is on screen.",
      "If a number looks stuck at zero or clearly decorative, say you are unsure whether it is live data.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Legacy registry only if DOM snapshot missing
  if (legacy) {
    const metrics = (legacy.metrics || [])
      .map(
        (m) =>
          `- ${m.label}: ${m.value ?? "?"}${m.isPlaceholder ? " [PLACEHOLDER]" : ""}`,
      )
      .join("\n");
    return [
      "PAGE REGISTRY (fallback — DOM snapshot was empty):",
      `${legacy.title} (${legacy.route})`,
      legacy.purpose,
      metrics,
    ].join("\n");
  }

  return "LIVE PAGE: (no snapshot received — answer generally about Vanna and ask the user what they see if needed.)";
}

const ASSISTANT_SYSTEM = `You are Vanna’s in-page assistant — same role as Gemini in Chrome’s side panel:
you help the user understand **this webpage** while they keep working on it.

You are NOT a generic chatbot. You are grounded in the LIVE PAGE text extracted from their browser.

How to behave:
- Answer about what is on the page: labels, numbers, tables, charts titles, buttons, sections.
- If they highlight text, prioritize explaining that highlight in context of the rest of the page.
- "Summarize this page" / "what am I looking at?" → structured, clear takeaways from LIVE PAGE.
- Be a product guide for Vanna Finance (Stellar DeFi: margin, earn, farm, portfolio, trade, analytics).
- Natural language, including Hinglish if they use it.
- Sound like a calm expert panel, not a marketing bot and not a support ticket system.

HARD RULES:
1. Numbers: only cite figures that appear in LIVE PAGE (or USER HIGHLIGHT), or that the user typed.
   Never invent APYs, TVL, balances, health factors, or addresses.
2. If the page text is thin/empty, say you cannot see enough of the page — do not fabricate UI.
3. Placeholder / stub UI: if many zeros or obviously static demo stats, warn that the value may not be live.
4. Never claim you executed a trade, deposit, or signature. Execution is a separate copilot path.
5. No financial advice ("you should leverage 5x"). Explain options and risks neutrally.
6. Vanna margin liquidates around health factor 1.1 when that fact is needed; prefer page text if it states LT.
7. BLUSDC / AQUSDC / SOUSDC are different USDC variants — do not conflate them.
8. Style: clean prose for a side panel. Short paragraphs. No markdown headings (#), no code fences,
   no fake "As an AI…" disclaimers. Optional one follow-up question only when useful.

Optional PRODUCT REFERENCE notes below are background only — never override LIVE PAGE numbers.`;

export type AssistantChatOpts = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  page_snapshot?: PageSnapshotCtx | null;
};

export async function answerAssistant(
  message: string,
  page: PageDescriptorCtx | null,
  request_id: string,
  opts?: AssistantChatOpts,
): Promise<ChatResponse> {
  const snap = opts?.page_snapshot ?? null;
  const pageBlock = renderSnapshot(snap, page);
  const path = snap?.path || page?.route || "";
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
    "PRODUCT REFERENCE (optional background — paraphrase, do not recite as a script):",
    ref,
    "",
    historyBlock,
    `USER REQUEST: ${message}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const prose = await generateText(ASSISTANT_SYSTEM, user, { temperature: 0.45 });
    return {
      kind: "answer",
      message: prose,
      data: {
        assistant: true,
        page_path: path || null,
        used_dom: Boolean(snap?.visible_text?.trim()),
        selection: Boolean(snap?.selection),
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
      message: `I couldn’t read the page with the model just now.${hint} Try again in a moment.`,
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
