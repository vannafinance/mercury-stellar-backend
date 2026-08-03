/**
 * Structured Guide answers.
 *
 * The Guide explains; the Copilot acts. It answers "what is a health factor?", "what am
 * I looking at on this page?" — long-form prose where the *structure* is the value:
 * a summary, then sections, some with a formula, some with a list, a glossary of terms
 * it used, and follow-up questions.
 *
 * runPageAgent returned one flat prose blob, so none of that structure survived: a
 * formula was a line of text in a paragraph, and the terms it leaned on went undefined.
 * The Claude Design Guide panel binds to fields (sections, formula, terms, followUps),
 * which is why this contract exists — same reasoning as answer-schema.ts, applied to a
 * reading surface rather than a figure surface.
 */

export interface GuideSection {
  heading: string;
  body: string;
  /** Rendered as its own monospace block — formulas are what people re-read. */
  formula?: string;
  bullets?: string[];
}

export interface GuideTerm {
  term: string;
  short: string;
}

export interface GuideAnswer {
  /** The question, echoed so the panel can title itself. */
  question: string;
  /** Two or three sentences that answer it before any section. */
  summary: string;
  sections: GuideSection[];
  /** Jargon used above, defined inline so the reader never has to leave. */
  terms: GuideTerm[];
  /** Follow-up questions offered as chips. */
  followUps: string[];
  /**
   * An on-screen element this answer refers to, for the "show me on this page"
   * affordance. Null when there was no page context or nothing relevant on it.
   */
  pageRef?: { label: string; elementId: string } | null;
  /** True when the Guide genuinely does not know — rendered as an honest state. */
  unknown?: boolean;
}

export const GUIDE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    question: { type: "STRING", description: "The user's question, lightly tidied." },
    summary: {
      type: "STRING",
      description:
        "Two or three sentences answering the question directly. Plain text. No markdown.",
    },
    sections: {
      type: "ARRAY",
      description: "At most 4 sections, each a distinct aspect of the answer.",
      items: {
        type: "OBJECT",
        properties: {
          heading: { type: "STRING", description: "Short sentence-case heading." },
          body: { type: "STRING", description: "One or two paragraphs of plain prose." },
          formula: {
            type: "STRING",
            description:
              "A formula in plain text if one genuinely clarifies this section, e.g. " +
              "'health factor = collateral / debt'. Omit otherwise — do not invent one.",
          },
          bullets: {
            type: "ARRAY",
            description: "Up to 4 short points, only when a list beats a sentence.",
            items: { type: "STRING" },
          },
        },
        required: ["heading", "body"],
        propertyOrdering: ["heading", "body", "formula", "bullets"],
      },
    },
    terms: {
      type: "ARRAY",
      description:
        "Jargon actually used above, defined in one sentence each. At most 4. Omit terms " +
        "the answer never mentions.",
      items: {
        type: "OBJECT",
        properties: {
          term: { type: "STRING" },
          short: { type: "STRING", description: "One sentence, no jargon of its own." },
        },
        required: ["term", "short"],
        propertyOrdering: ["term", "short"],
      },
    },
    followUps: {
      type: "ARRAY",
      description: "Up to 3 questions a reader would naturally ask next.",
      items: { type: "STRING" },
    },
    unknown: {
      type: "BOOLEAN",
      description:
        "True when you cannot answer from Vanna product knowledge or the page context. " +
        "Say so rather than guessing — a confident wrong explanation of a risk mechanic " +
        "is worse than admitting the gap.",
    },
  },
  required: ["question", "summary", "sections"],
  propertyOrdering: ["question", "summary", "sections", "terms", "followUps", "unknown"],
} as const;

export const GUIDE_SYSTEM = `You are Vanna Guide. You EXPLAIN Vanna Finance on Stellar/Soroban. You never transact — the Copilot does that, and you must never imply you have acted or can act.

You return DATA, not prose layout. The interface renders your fields. Never write markdown, asterisks, bullet characters or headings inside a field; they are shown literally and read as a bug.

summary
- Answer the question in two or three sentences before any section. A reader who stops here should still have their answer.

sections
- Each covers one distinct aspect. Order them so the most useful comes first.
- Add a formula only when it genuinely clarifies, and only one you are certain of. Never invent notation.
- Use bullets only when the content is genuinely a list.

terms
- Define only jargon you actually used, one plain sentence each. No term whose definition needs another term.

followUps
- Questions this answer naturally raises, phrased as the user would ask them.

Accuracy rules that override everything above:
- Health factor on Vanna is gross collateral divided by debt. Liquidation happens at or below 1.10. There is no threshold haircut on the collateral side.
- Earn, Farm and Margin are different products. Never blur them: Earn is Vanna's own lending pools, Farm is external venues (Blend, Aquarius/Soroswap LP), Margin is the smart account that holds collateral and debt.
- There are three distinct USDC tokens (BLUSDC, AQUSDC, SOUSDC) and they are not interchangeable.
- Never quote a live figure — a balance, an APY, a health factor — unless the page context contains it. You explain mechanics; the Copilot reports numbers.
- If the question is outside Vanna, or you are not confident, set unknown true and say what you would need. Do not fill the gap with plausible-sounding detail.`;

/** Normalise a model answer, dropping malformed parts rather than trusting them. */
export function normalizeGuideAnswer(raw: unknown, fallbackQuestion: string): GuideAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const summary = str(o.summary);
  if (!summary) return null;

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
          return {
            heading,
            body,
            ...(formula ? { formula } : {}),
            ...(bullets.length ? { bullets } : {}),
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

  return {
    question: str(o.question) || fallbackQuestion,
    summary,
    sections,
    terms,
    followUps,
    pageRef: null,
    ...(o.unknown === true ? { unknown: true } : {}),
  };
}

/** Flatten to plain text for `message`, so a surface without the panel still works. */
export function guideAnswerToText(a: GuideAnswer): string {
  const out: string[] = [a.summary];
  for (const s of a.sections) {
    out.push("", s.heading, s.body);
    if (s.formula) out.push(s.formula);
    for (const b of s.bullets ?? []) out.push(`• ${b}`);
  }
  if (a.terms.length) {
    out.push("", "Terms used here");
    for (const t of a.terms) out.push(`• ${t.term}: ${t.short}`);
  }
  return out.join("\n");
}
