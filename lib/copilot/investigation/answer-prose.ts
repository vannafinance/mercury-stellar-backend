import type { ResearchFact } from "./view";

/**
 * Let the model write the sentence; let code write every number in it.
 *
 * ## Why this exists
 *
 * Answers were composed by hand — `rowSentences` produces `"Blend: XLM 122.6934092,
 * USDC 0."` from a fixed template. The data in it is derived, but the shape of the
 * sentence is written in code, so every new case needs another template and the prose
 * stays robotic. Handing the whole answer to the model instead is the obvious fix and the
 * wrong one: it can then state a number nobody read, or attach a real number to the wrong
 * label, which is exactly the failure the Blend answer had when it printed a b-rate as an
 * XLM balance.
 *
 * So neither side gets both jobs. The model receives the audited facts and writes prose
 * that refers to each figure as `{{factId}}` — it never types a digit. Code substitutes
 * the values. A template that names a fact nobody read, or that contains a number the
 * model wrote itself, is refused outright and the caller keeps its deterministic sentence.
 *
 * This is a contract, not a list of phrases: it constrains what the model may ASSERT
 * without constraining how it may say it, so a new venue or asset needs no change here.
 *
 * ## What counts as a violation
 *
 * - `{{id}}` naming a fact that is not in the audited set — the model invented a source.
 * - Any digit outside a placeholder — the model wrote a figure itself. Ordinals and years
 *   would be caught too; that is deliberate, because an answer about balances has no
 *   business containing a number code did not supply.
 */

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export interface BoundProse {
  ok: boolean;
  /** The finished sentence, when `ok`. */
  text?: string;
  /** Why the template was refused, for the log. Never shown to the user. */
  reason?: string;
}

/** A fact's value as the user should read it — the same formatting the deterministic path uses. */
export function formatFactValue(fact: ResearchFact): string {
  const n = Number(fact.value);
  const usd = fact.unit === "USD";
  const value = Number.isFinite(n)
    ? n.toLocaleString("en-US", {
        minimumFractionDigits: usd ? 2 : 0,
        maximumFractionDigits: usd ? 2 : 7,
      })
    : fact.value;
  return usd ? `$${value}` : `${value} ${fact.unit}`.trim();
}

/**
 * Substitute `{{factId}}` against the audited facts, refusing anything the facts do not
 * support. Returns the finished sentence, or a reason the caller should fall back.
 */
export function bindProse(template: string, facts: readonly ResearchFact[]): BoundProse {
  const trimmed = template.trim();
  if (!trimmed) return { ok: false, reason: "empty template" };

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const unknown: string[] = [];
  const text = trimmed.replace(PLACEHOLDER, (_match, id: string) => {
    const fact = byId.get(id);
    if (!fact) {
      unknown.push(id);
      return "";
    }
    return formatFactValue(fact);
  });
  if (unknown.length) {
    return { ok: false, reason: `template cites facts that were not read: ${unknown.slice(0, 4).join(", ")}` };
  }

  /**
   * Checked on the template, not the result: the substituted values are full of digits by
   * design, and the question is only whether the MODEL typed any.
   */
  const withoutPlaceholders = trimmed.replace(PLACEHOLDER, "");
  const invented = withoutPlaceholders.match(/\d/);
  if (invented) {
    return { ok: false, reason: "template contains a figure the model wrote itself" };
  }

  return { ok: true, text };
}
