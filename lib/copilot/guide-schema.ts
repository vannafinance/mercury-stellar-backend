/**
 * Structured Guide answers for Vanna Assist.
 *
 * The Assist explains, diagnoses, and guides around the UI; the Copilot acts.
 * Returning structured fields (summary, highlights, sections with formula/bullets/steps,
 * terms glossary, followUps, copilotHandoffPrompt, and optional clientTools) allows every
 * Assist turn to complete in a single low-latency LLM pass and render as a rich,
 * scannable card layout rather than a flat wall of text.
 */

export interface GuideHighlight {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}

export interface GuideSection {
  heading: string;
  body: string;
  /** Rendered as its own monospace callout block - formulas are what people re-read. */
  formula?: string;
  bullets?: string[];
  /** Numbered step-by-step instructions when explaining a workflow or UI action. */
  steps?: string[];
}

export interface GuideTerm {
  term: string;
  short: string;
}

export interface GuideClientTool {
  name: "navigateToRoute" | "scrollToSection" | "highlightElement" | "openConnectWallet";
  path?: string;
  elementId?: string;
  selector?: string;
  prefer?: string;
  intent?: string;
}

export interface GuideAnswer {
  /** The question, echoed so the panel can title itself. */
  question: string;
  /** Two or three sentences that answer it directly before any section. */
  summary: string;
  /** Key metrics or status pills extracted from the current page or session context. */
  highlights?: GuideHighlight[];
  sections: GuideSection[];
  /** Jargon used above, defined inline so the reader never has to leave. */
  terms: GuideTerm[];
  /** Follow-up questions offered as interactive chips. */
  followUps: string[];
  /**
   * When the user asks to execute an on-chain action, build a strategy, or retry a
   * transaction, provide the exact prompt they can hand off to Copilot in one click.
   */
  copilotHandoffPrompt?: string | null;
  /** Optional UI navigation/highlight tools to invoke on the client. */
  clientTools?: GuideClientTool[];
  /**
   * An on-screen element this answer refers to, for the "show me on this page"
   * affordance. Null when there was no page context or nothing relevant on it.
   */
  pageRef?: { label: string; elementId: string } | null;
  /** True when Assist genuinely does not know - rendered as an honest state. */
  unknown?: boolean;
}

export const GUIDE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    question: { type: "STRING", description: "The user's question, lightly tidied." },
    summary: {
      type: "STRING",
      description:
        "One to three crisp sentences answering the question directly. Plain text, no markdown.",
    },
    highlights: {
      type: "ARRAY",
      description:
        "Optional (up to 4) key figures, metrics, or statuses visible on the user's current page " +
        "or session events that directly relate to their question. Never invent figures not in context.",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING", description: "Short metric or status label, e.g. 'Health Factor' or 'Pool APY'." },
          value: { type: "STRING", description: "Exact value from pageContext or protocol law, e.g. '1.10 liquidation floor'." },
          tone: {
            type: "STRING",
            enum: ["good", "warn", "bad", "neutral"],
            description: "Visual tone for the metric card.",
          },
        },
        required: ["label", "value"],
        propertyOrdering: ["label", "value", "tone"],
      },
    },
    sections: {
      type: "ARRAY",
      description:
        "1 to 4 structured sections. Keep simple questions to 1-2 sections; use more only for full page walkthroughs or multi-part comparisons.",
      items: {
        type: "OBJECT",
        properties: {
          heading: { type: "STRING", description: "Short sentence-case heading." },
          body: { type: "STRING", description: "Concise, clear plain prose (1-3 sentences)." },
          formula: {
            type: "STRING",
            description:
              "A formula in plain text if one genuinely clarifies this section, e.g. " +
              "'Health Factor = Gross Collateral / Debt (Liquidation <= 1.10)'. Omit otherwise.",
          },
          bullets: {
            type: "ARRAY",
            description: "Up to 4 short bullet points when comparing items or listing key takeaways.",
            items: { type: "STRING" },
          },
          steps: {
            type: "ARRAY",
            description: "Up to 5 ordered steps when explaining how to perform an action in the UI.",
            items: { type: "STRING" },
          },
        },
        required: ["heading", "body"],
        propertyOrdering: ["heading", "body", "formula", "bullets", "steps"],
      },
    },
    terms: {
      type: "ARRAY",
      description:
        "Jargon actually used above, defined in one plain sentence each. At most 4. Omit if no specialized terms were used.",
      items: {
        type: "OBJECT",
        properties: {
          term: { type: "STRING" },
          short: { type: "STRING", description: "One plain sentence defining the term." },
        },
        required: ["term", "short"],
        propertyOrdering: ["term", "short"],
      },
    },
    followUps: {
      type: "ARRAY",
      description: "2 to 3 natural next questions the user might want to ask.",
      items: { type: "STRING" },
    },
    copilotHandoffPrompt: {
      type: "STRING",
      description:
        "Set ONLY when the user wants to execute an on-chain action, check live off-page wallet/margin state via MCP, " +
        "or build a strategy that belongs in Vanna Copilot. Provide the exact prompt to run in Copilot.",
    },
    clientTools: {
      type: "ARRAY",
      description:
        "Set ONLY when the user explicitly asks to navigate to a page, scroll to a section, highlight a control, " +
        "or open the wallet connection modal.",
      items: {
        type: "OBJECT",
        properties: {
          name: {
            type: "STRING",
            enum: ["navigateToRoute", "scrollToSection", "highlightElement", "openConnectWallet"],
          },
          path: {
            type: "STRING",
            description: "For navigateToRoute: app route such as /margin, /earn, /farm, /portfolio, /trade/spot, /copilot, /analytics",
          },
          elementId: {
            type: "STRING",
            description: "For scrollToSection: DOM id from pageContext.sections[].id",
          },
          selector: {
            type: "STRING",
            description: "For highlightElement: CSS selector or data-copilot-id from interactiveHints",
          },
          prefer: {
            type: "STRING",
            description: "For openConnectWallet: 'privy', 'modal', or 'freighter'",
          },
          intent: {
            type: "STRING",
            description: "For openConnectWallet: 'create' or 'connect'",
          },
        },
        required: ["name"],
        propertyOrdering: ["name", "path", "elementId", "selector", "prefer", "intent"],
      },
    },
    unknown: {
      type: "BOOLEAN",
      description:
        "True when the question is outside Vanna Finance / Stellar DeFi or cannot be answered honestly from product knowledge and page context.",
    },
  },
  required: ["question", "summary", "sections"],
  propertyOrdering: [
    "question",
    "summary",
    "highlights",
    "sections",
    "terms",
    "followUps",
    "copilotHandoffPrompt",
    "clientTools",
    "unknown",
  ],
} as const;

export const GUIDE_SYSTEM = `You are Vanna Assist, the in-app DeFi companion for Vanna Finance on Stellar/Soroban.
Never call yourself Vanna Guide or Vanna Assistant - your name is Vanna Assist.
You EXPLAIN, DIAGNOSE, and GUIDE around the interface. You never sign or submit transactions yourself - Vanna Copilot executes on-chain actions.

You return structured JSON matching the schema. The UI renders each field into dedicated typography, metric cards, formula callouts, step badges, and glossary pills. Never write markdown syntax (no **bold**, *italics*, # headings, or bullet symbols) inside string fields.

ADAPTIVE STRUCTURE & TONE
- Lead with a crystal-clear summary (1-3 sentences) that directly answers the user's question.
- Populate highlights (up to 4 cards) when the user's screen has concrete numbers (APY, TVL, Health Factor, Collateral, Debt) or when highlighting critical protocol invariants (such as the 1.10 liquidation floor).
- Keep sections sharp and well-paced:
  - Use formula only when an exact mathematical relation clarifies the concept.
  - Use steps when walking the user through how to do something in the UI.
  - Use bullets when comparing venues, tokens, or key properties.
- Define specialized terms in terms (up to 4) so newcomers and pros alike get instant clarity.
- Suggest 2-3 smart, contextual followUps.
- If the user asks to perform a transaction, build a levered strategy, or run a live account action, explain briefly how it works and populate copilotHandoffPrompt with the exact prompt they can launch in Vanna Copilot.
- If the user asks to go to another page, scroll to a section, highlight a button, or connect/create a wallet, include the appropriate entry in clientTools alongside your explanation.

PAGE CONTEXT & SESSION EVENTS
- You receive the live pageContext (path, title, sections, mainText, selectedText, metrics, tables) from the user's current screen.
- When the user asks about their screen ("what am I looking at?", "explain this page", "what does this metric mean?"), ground your explanation in the exact sections, controls, and figures visible on that page.
- Never invent balances, APYs, or prices that are not present in pageContext.
- When the page context is empty or unrelated to the question, answer from product knowledge and do not pretend to see a page. Never describe a section, control, or figure that is not in the context.
- If SESSION EVENTS are present, use them to diagnose transaction issues accurately (e.g. distinguishing wallet_rejected signature cancellation from simulation or on-chain failures).
- If screenshots are attached, read only what is visibly shown and cross-check with pageContext.

PROTOCOL ACCURACY & DOMAIN BOUNDARY
- Health Factor on Vanna is Gross Collateral / Debt. Hard liquidation occurs at or below HF <= 1.10. There is no collateral threshold haircut.
- Never present a safety floor you were not given as a protocol rule, and never put one into copilotHandoffPrompt. Any safety buffer above the 1.10 protocol liquidation threshold belongs strictly to the user.
- Three-bucket architecture: Spendable Wallet balances, Posted Margin (Smart Account collateral & debt), and Earn Pools are distinct buckets.
- Earn, Farm, and Margin are distinct products:
  - Earn: Vanna's native lending pools where suppliers earn yield.
  - Margin: Vanna's smart account holding collateral and borrowed debt.
  - Farm: External DeFi venues on Stellar/Soroban (Blend lending pools, Aquarius & Soroswap LP pools).
- Three distinct USDC tokens exist on testnet/protocol: BLUSDC (Blend), AQUSDC (Aquarius), and SOUSDC (Soroswap). They are not interchangeable without swapping.
- Stay strictly within Vanna Finance, Stellar/Soroban, and relevant DeFi mechanics. If a user asks an off-domain question (unrelated coding, general trivia, politics, etc.), set unknown: true and politely state that Vanna Assist focuses exclusively on Vanna Finance and Stellar DeFi.`;

const VALID_TONES = new Set(["good", "warn", "bad", "neutral"]);
const VALID_TOOLS = new Set([
  "navigateToRoute",
  "scrollToSection",
  "highlightElement",
  "openConnectWallet",
]);

/** Normalise a model answer, dropping malformed parts rather than trusting them. */
export function normalizeGuideAnswer(raw: unknown, fallbackQuestion: string): GuideAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const summary = str(o.summary);
  if (!summary) return null;

  const highlights: GuideHighlight[] = Array.isArray(o.highlights)
    ? o.highlights
        .map((h) => {
          const e = (h ?? {}) as Record<string, unknown>;
          const label = str(e.label);
          const value = str(e.value);
          if (!label || !value) return null;
          const rawTone = str(e.tone);
          const tone = VALID_TONES.has(rawTone)
            ? (rawTone as GuideHighlight["tone"])
            : undefined;
          return {
            label,
            value,
            ...(tone ? { tone } : {}),
          };
        })
        .filter((h): h is GuideHighlight => h !== null)
        .slice(0, 4)
    : [];

  const sections: GuideSection[] = Array.isArray(o.sections)
    ? o.sections
        .map((s) => {
          const e = (s ?? {}) as Record<string, unknown>;
          const heading = str(e.heading);
          const body = str(e.body);
          if (!heading || !body) return null;
          const formula = str(e.formula);
          const bullets = Array.isArray(e.bullets)
            ? e.bullets.map(str).filter(Boolean).slice(0, 4)
            : [];
          const steps = Array.isArray(e.steps)
            ? e.steps.map(str).filter(Boolean).slice(0, 5)
            : [];
          return {
            heading,
            body,
            ...(formula ? { formula } : {}),
            ...(bullets.length ? { bullets } : {}),
            ...(steps.length ? { steps } : {}),
          };
        })
        .filter((s): s is GuideSection => s !== null)
        .slice(0, 4)
    : [];

  const terms: GuideTerm[] = Array.isArray(o.terms)
    ? o.terms
        .map((t) => {
          const e = (t ?? {}) as Record<string, unknown>;
          const term = str(e.term);
          const short = str(e.short);
          return term && short ? { term, short } : null;
        })
        .filter((t): t is GuideTerm => t !== null)
        .slice(0, 4)
    : [];

  const followUps = Array.isArray(o.followUps)
    ? o.followUps.map(str).filter(Boolean).slice(0, 3)
    : [];

  const copilotHandoffPrompt = str(o.copilotHandoffPrompt) || null;

  const clientTools: GuideClientTool[] = Array.isArray(o.clientTools)
    ? o.clientTools
        .map((t) => {
          const e = (t ?? {}) as Record<string, unknown>;
          const name = str(e.name);
          if (!VALID_TOOLS.has(name)) return null;
          const path = str(e.path);
          const elementId = str(e.elementId);
          const selector = str(e.selector);
          const prefer = str(e.prefer);
          const intent = str(e.intent);
          return {
            name: name as GuideClientTool["name"],
            ...(path ? { path } : {}),
            ...(elementId ? { elementId } : {}),
            ...(selector ? { selector } : {}),
            ...(prefer ? { prefer } : {}),
            ...(intent ? { intent } : {}),
          };
        })
        .filter((t): t is GuideClientTool => t !== null)
        .slice(0, 3)
    : [];

  return {
    question: str(o.question) || fallbackQuestion,
    summary,
    ...(highlights.length ? { highlights } : {}),
    sections,
    terms,
    followUps,
    ...(copilotHandoffPrompt ? { copilotHandoffPrompt } : {}),
    ...(clientTools.length ? { clientTools } : {}),
    pageRef: null,
    ...(o.unknown === true ? { unknown: true } : {}),
  };
}

/** Flatten to plain text for `message`, so a surface without the panel still works. */
export function guideAnswerToText(a: GuideAnswer): string {
  const out: string[] = [a.summary];
  if (a.highlights?.length) {
    out.push("");
    for (const h of a.highlights) out.push(`• ${h.label}: ${h.value}`);
  }
  for (const s of a.sections) {
    out.push("", s.heading, s.body);
    if (s.formula) out.push(s.formula);
    for (const b of s.bullets ?? []) out.push(`• ${b}`);
    for (let i = 0; i < (s.steps ?? []).length; i++) {
      out.push(`${i + 1}. ${s.steps![i]}`);
    }
  }
  if (a.terms.length) {
    out.push("", "Terms used here");
    for (const t of a.terms) out.push(`• ${t.term}: ${t.short}`);
  }
  return out.join("\n");
}
