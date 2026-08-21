/**
 * Structured answers — the prose equivalent of native function calling.
 *
 * The read path asked Gemini for free text and then tried to police its shape from the
 * prompt: lead with the number, use "• Label: value" for three or more figures, never
 * emit markdown, never exceed 4 decimals, name the venue. Every one of those is a
 * formatting rule enforced by persuasion, and each failure showed up in the UI — literal
 * `**BLUSDC**` (we strip it with a regex), 18-decimal wad strings, bullets that
 * sometimes appeared as "-" and sometimes as "*", venue left unstated.
 *
 * Asking for DATA instead moves all of that to the renderer, where it is deterministic:
 *
 *   - Markdown cannot leak, because no field is ever interpreted as markup.
 *   - Figures render in one place, so tabular alignment and precision are uniform.
 *   - The venue is a field, so the UI can badge it with the same colours the plan card
 *     uses — the Earn/Blend confusion class becomes visible rather than narrated.
 *   - A missing field is detectable. Prose that quietly omits the answer looks fine.
 *
 * The model still writes the words; it no longer decides the layout.
 */

export type AnswerVenue =
  | "earn"
  | "blend"
  | "aquarius"
  | "margin"
  | "wallet"
  | "oracle"
  | "none";

export type FactTone = "neutral" | "good" | "warn" | "bad";

export interface AnswerFact {
  label: string;
  value: string;
  tone?: FactTone;
  /**
   * Renders in its own box, separate from the plain figures grid. Reported live: a margin
   * account's real collateral (XLM, BLUSDC) and its farm-venue LP/receipt positions
   * (BLEND_USDC, an Aquarius LP share) were rendered as one undifferentiated list, reading
   * as duplicate or confusing entries. Set only by this app's own deterministic builders —
   * Gemini's structured-answer schema never emits it, so an LLM-authored fact always lands
   * in the plain figures box.
   *
   * "earn" added so "what are all my positions" can fold in Earn (vToken) supply as its
   * own section — a third, genuinely different pool from margin collateral and farm/LP,
   * previously left out of this answer entirely (user asked for it explicitly).
   */
  group?: "lp" | "earn";
}

export interface StructuredAnswer {
  /** One sentence that answers the question, leading with the figure asked for. */
  headline: string;
  /** Supporting figures. Empty is valid — not every answer has a table in it. */
  facts: AnswerFact[];
  /** At most two sentences of context. Optional. */
  note?: string;
  /** Which product the numbers came from, so the UI can label it. */
  venue?: AnswerVenue;
  /**
   * Optional per-pool (or per-clause) blocks. Each is a sentence plus a compact
   * supplied/available strip — not one big facts card for the whole answer.
   */
  sections?: Array<{ body: string; facts: AnswerFact[] }>;
  /** Farm Positions-style table. Prefer this over a facts dump for holdings. */
  table?: { columns: string[]; rows: string[][] };
}

/**
 * Gemini `responseSchema`. Constrains generation rather than requesting a shape, so a
 * malformed answer is unrepresentable instead of merely discouraged.
 *
 * `propertyOrdering` matters: Gemini generates fields in the order given, and putting
 * `headline` first means the direct answer is produced before the supporting detail,
 * which is also the order we want it written in.
 */
export const ANSWER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: {
      type: "STRING",
      description:
        "One sentence answering the question, leading with the figure asked for. Plain text.",
    },
    facts: {
      type: "ARRAY",
      description:
        "Supporting figures, at most 6 — UNLESS the user asked for a set that DATA contains " +
        "in full (every protocol address, every pool, every position), in which case return " +
        "the complete set, up to 16. Omit anything not present in DATA. Values must be " +
        "copied at the precision DATA gives — never lengthened.",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING", description: "Short lowercase label, e.g. 'supply APY'." },
          value: {
            type: "STRING",
            description:
              "The formatted figure, e.g. '6.41%', '$1,146.03', '6,800.5721 XLM', '2.14'.",
          },
          tone: {
            type: "STRING",
            enum: ["neutral", "good", "warn", "bad"],
            description:
              "Use 'bad' only for a figure that signals danger (health factor near " +
              "liquidation, a failure). Default 'neutral'.",
          },
        },
        required: ["label", "value"],
        propertyOrdering: ["label", "value", "tone"],
      },
    },
    note: {
      type: "STRING",
      description: "At most two sentences of context. Omit if the headline stands alone.",
    },
    venue: {
      type: "STRING",
      enum: ["earn", "blend", "aquarius", "margin", "wallet", "oracle", "none"],
      description:
        "Which product these numbers came from. 'earn' for Vanna lending pools, 'blend' " +
        "for Blend reserves, 'aquarius' for LP, 'margin' for the smart account, 'oracle' " +
        "for prices. Never guess — use 'none' if DATA does not say.",
    },
  },
  required: ["headline", "facts"],
  propertyOrdering: ["headline", "facts", "note", "venue"],
} as const;

export const ANSWER_SYSTEM = `You turn Vanna Finance MCP read results into a structured answer for a DeFi user who may be new to lending and margin.

You return DATA, not prose layout. The interface renders it, so never write markdown, bullet characters, or headings — an asterisk in your output is shown literally to the user and reads as a bug.

headline
- One sentence. Lead with the figure the user asked for.
- Name the venue in the sentence when it matters ("the Vanna earn pool", "the Blend reserve") so the user is never unsure which product a number describes.

facts
- Only figures that are present in DATA. Never invent, never infer, never restate a number at higher precision than DATA gives.
- Prefer human-readable fields (*_pct, *_usd, *_human, price_usd, exchange_rate) over raw wad integers. If a value exists only as a wad integer, omit it.
- Format: percentages 2 decimals with the sign ("6.41%"); USD with $ and thousands separators ("$1,146.03"); token amounts at most 4 decimals with trailing zeros dropped ("6,800.5721 XLM"); a health factor as a bare ratio to 2 decimals ("2.14") or "∞" when there is no debt.
- At most 6 facts when the answer is a set of figures. Fewer is better than padded.
- BUT when the user asked to see a SET and DATA holds all of it — every protocol contract address, every pool, every open position — return the COMPLETE set, up to 16 facts. Six of fifteen addresses is not an answer to "show me the protocol contract addresses", and the interface counts and groups a long list, so length is not a layout problem here. One fact per item, the item's name as the label.

note
- Only if it adds something the headline does not. Two sentences maximum.

If DATA carries an error or an unavailable venue, say plainly in the headline what failed and that no figure is available, set facts to an empty list, and do not substitute a number from elsewhere.`;

/**
 * A fact label as a person would write it.
 *
 * The MCP registry names its entries `optional_lending_pool_aqusdc`, and "optional" is a
 * deployment note for whoever maintains the registry — it says the contract need not exist,
 * not anything about the address you are looking at. Rendered into the card it read as part
 * of the contract's name ("OPTIONAL AQUARIUS ROUTER"), which is both noise and slightly
 * wrong. Dropping it also lets the card group properly: without it, four lending pools
 * share the words "lending pool" and collapse under one heading instead of scattering.
 */
export function cleanFactLabel(label: string): string {
  return label
    .replace(/_/g, " ")
    .replace(/^\s*optional\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Stellar contract/account address, or a 64-char tx hash — the same test the card uses. */
function isIdentifierValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return /^[GC][A-Z2-7]{55}$/.test(s) || /^[0-9a-f]{64}$/i.test(s);
}

/**
 * Give the answer every address the read actually returned.
 *
 * "Show me the protocol contract addresses" returns fifteen. The model was told at most six
 * facts and obeyed, so the card rendered six and the remaining nine fell through to the raw
 * facts grid below it — the same answer in two different presentations, one of them the
 * generic key/value dump. The prompt now allows a complete set, but a prompt is a request:
 * asking a model for fifteen items is not the same as getting them, and a partial list of
 * addresses is the one case where partial is indistinguishable from wrong.
 *
 * So the set is completed here from DATA, which already holds all of it. Deliberately narrow:
 *
 *   - identifiers only, never figures. A figure answer omits numbers on purpose ("prefer
 *     human-readable fields", "omit wad integers") and padding it back out would undo that.
 *   - only when the model already returned at least one identifier, so this extends an
 *     enumeration and never turns a one-number answer into a list of contracts.
 *   - existing facts keep their order and labels; additions follow in DATA order.
 *
 * `MAX` matches the card's design brief, which was drawn for sixteen facts.
 */
export function completeIdentifierFacts(
  answer: StructuredAnswer,
  data: Record<string, unknown>,
): StructuredAnswer {
  const MAX = 16;
  const already = new Set(answer.facts.map((f) => f.value.trim()));
  if (!answer.facts.some((f) => isIdentifierValue(f.value))) return answer;

  const missing: AnswerFact[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (answer.facts.length + missing.length >= MAX) break;
    if (!isIdentifierValue(value) || already.has(value.trim())) continue;
    missing.push({ label: cleanFactLabel(key), value: value.trim(), tone: "neutral" });
  }
  if (!missing.length) return answer;
  return { ...answer, facts: [...answer.facts, ...missing] };
}

/**
 * A headline that repeats a raw identifier the facts card already shows duplicates the
 * one thing that card exists for. "The account manager address is CAZLR6E… and the
 * oracle address is CAYHPE4…" put both 56-character values inline in a prose sentence
 * AND in their own copyable rows two inches below — the same fact rendered twice, once
 * as unreadable prose. Reported live, once for a single address and again for two.
 *
 * Rewritten to name WHAT was found rather than repeat its value, since the value only
 * needs to live in the one place built to show it in full and let it be copied.
 * Deliberately general: any headline embedding a value that also appears as an
 * identifier fact gets this treatment, not just an address-lookup answer specifically.
 */
export function dedupeInlineIdentifiers(answer: StructuredAnswer): StructuredAnswer {
  const named: string[] = [];
  for (const fact of answer.facts) {
    if (isIdentifierValue(fact.value) && answer.headline.includes(fact.value)) {
      // The model's own fact label sometimes already ends in "address" (e.g. "xlm
      // lending pool address") — stripped here so the noun this function appends below
      // is never duplicated into "... address address."
      named.push(fact.label.replace(/\s+address(es)?$/i, "").trim());
    }
  }
  if (!named.length) return answer;
  const noun = named.length === 1 ? "address" : "addresses";
  const list =
    named.length <= 2
      ? named.join(" and ")
      : `${named.slice(0, -1).join(", ")}, and ${named[named.length - 1]}`;
  return { ...answer, headline: `Here is the ${list} ${noun}.` };
}

/** Normalise a model answer, dropping anything malformed rather than trusting it. */
export function normalizeAnswer(raw: unknown): StructuredAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const headline = typeof o.headline === "string" ? o.headline.trim() : "";
  if (!headline) return null;

  const tones: FactTone[] = ["neutral", "good", "warn", "bad"];
  const facts: AnswerFact[] = Array.isArray(o.facts)
    ? o.facts
        .map((f) => {
          const e = (f ?? {}) as Record<string, unknown>;
          const label = typeof e.label === "string" ? e.label.trim() : "";
          const value = typeof e.value === "string" ? e.value.trim() : "";
          if (!label || !value) return null;
          const tone = tones.includes(e.tone as FactTone) ? (e.tone as FactTone) : undefined;
          return { label: cleanFactLabel(label), value, ...(tone ? { tone } : {}) };
        })
        .filter((f): f is AnswerFact => f !== null)
        // 16, not 6, and this is the line that actually decided it.
        //
        // The card was designed for sixteen facts — "15 identifiers, the case that currently
        // breaks" is one of its stated payloads — but every answer was truncated to six here,
        // so "show me the protocol contract addresses" put six of fifteen in the card and the
        // rest fell through to the generic facts dump underneath. The model was blamed and
        // the prompt rewritten; the prompt was never the ceiling.
        //
        // "At most 6" still holds for a figure answer and still belongs in ANSWER_SYSTEM,
        // where it is a judgement about what is worth showing. A hard limit here cannot make
        // that judgement — all it can do is cut an enumeration in half.
        .slice(0, 16)
    : [];

  const venues: AnswerVenue[] = [
    "earn",
    "blend",
    "aquarius",
    "margin",
    "wallet",
    "oracle",
    "none",
  ];
  const venue = venues.includes(o.venue as AnswerVenue) ? (o.venue as AnswerVenue) : undefined;
  const note = typeof o.note === "string" && o.note.trim() ? o.note.trim() : undefined;

  return { headline, facts, ...(note ? { note } : {}), ...(venue ? { venue } : {}) };
}

/** Flatten to plain text — the message field, and any surface without the renderer. */
export function answerToText(a: StructuredAnswer): string {
  const lines = [a.headline];
  if (a.sections?.length) {
    for (const s of a.sections) {
      lines.push("");
      lines.push(s.body);
      for (const f of s.facts) lines.push(`${f.label}  ${f.value}`);
    }
  }
  if (a.facts.length) {
    lines.push("");
    for (const f of a.facts) lines.push(`• ${f.label}: ${f.value}`);
  }
  if (a.table?.rows.length) {
    lines.push("");
    lines.push(a.table.columns.join(" | "));
    for (const row of a.table.rows) lines.push(row.join(" | "));
  }
  if (a.note) {
    lines.push("");
    lines.push(a.note);
  }
  return lines.join("\n");
}
