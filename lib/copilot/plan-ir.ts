/**
 * Span accounting for deterministic plan extraction.
 *
 * The failure this exists to catch: every silent-drop bug in this pipeline has the same
 * shape — a fragment of the user's sentence that no component claimed, and no component
 * noticed was missing. A first-match-wins cascade cannot notice, because a missing rule
 * is not a no-op; it silently promotes whatever rule happens to match first. So instead
 * of trusting each producer to have read the whole message, every producer records the
 * character ranges it consumed, and what is left over becomes a value the system can
 * check.
 *
 * Two examples this module turns from silent into visible:
 *   - "Deposit 50 BLUSDC, run a delta-neutral XLM carry, and also lend 20 XLM on Earn"
 *     used to emit the carry's three legs and discard the Earn lend entirely.
 *   - "run a delta-neutral XLM carry with 100 BLUSDC then farm 10 BLUSDC at 2x" used to
 *     emit the carry and drop the Blend leg — no error, no clarification.
 *
 * Pure and offline: no network, no model, no imports from the orchestrator.
 */

import type { ExtractedStep } from "./step-extractor";

export interface Span {
  start: number;
  end: number;
}

/** A clause from the splitter, with its range in the *raw* message. */
export interface ClauseSpan extends Span {
  text: string;
}

/**
 * Who claimed a range of the message.
 *
 * `strategy` is separate from `step` because a named strategy reads text that is not
 * contiguous — the phrase "delta-neutral XLM carry" can sit in one clause while the
 * deposit amount it consumed sits in another — so its claim cannot be attributed to any
 * single clause's step.
 */
export interface SpanClaim {
  span: Span;
  by: "constraint" | "strategy" | "step";
}

export interface ResidueSpan extends Span {
  text: string;
  /**
   * `failed_clause` — the splitter produced a clause and nothing claimed any of it.
   * `intra_clause` — a claimed clause with words left over around what was matched.
   */
  source: "failed_clause" | "intra_clause";
}

export interface Coverage {
  consumed: Span[];
  /**
   * Whole clauses nothing claimed. This is the number Phase 1 asserts on, because both
   * verified drops above are of this kind.
   */
  residue: ResidueSpan[];
  /**
   * Leftover words inside clauses that *did* produce something. Computed and logged from
   * day one but deliberately never asserted: the raw runs include ordinary connective and
   * qualifier text ("for yield", "on Earn", "my"), and suppressing those needs a lexicon
   * tuned against observed traffic rather than one guessed up front. Phase 2 tightens the
   * verdict using these numbers.
   */
  intraClause: ResidueSpan[];
  verdict: "complete" | "partial";
}

/**
 * Constraints extracted once from the raw message and carried, not re-parsed downstream.
 *
 * Unwatchable conditions are deliberately absent. Two components already detect them —
 * `detectAutomationGap` at the routing gate, and the class-C branch of the residue
 * classifier — and a third copy of that judgment is exactly the kind of duplicated
 * vocabulary that drifts. Conditions surface through `Coverage.residue` instead.
 */
export interface PlanConstraints {
  minHf: number | null;
  /** A global "2x" applied to levered ops, not a cap. */
  leverage: number | null;
  /** No span: the phrasing is disjoint enough that the router matches it as a whole. */
  preferMaxYield: boolean;
  spans: Span[];
}

export interface PlanIR {
  steps: ExtractedStep[];
  constraints: PlanConstraints;
  coverage: Coverage;
  source: "deterministic" | "named_strategy" | "merged";
  /** Named strategy id when one matched, so callers need not re-derive it. */
  strategyId: string | null;
}

export function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when any claim covers part of `span`. */
export function isClaimed(span: Span, claims: SpanClaim[]): boolean {
  return claims.some((c) => spansOverlap(span, c.span));
}

function hasMeaningfulToken(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

/**
 * Account for every clause of the message against what the extractors claimed.
 *
 * A clause that produced a step, or that overlaps a constraint or named-strategy claim,
 * is accounted for in full. Clause granularity is deliberate: it is what makes
 * `residue.length === 0` a meaningful assertion on prompts that behave correctly, while
 * still catching every drop of the form "one step, but comparable text left over".
 */
export function accountCoverage(
  message: string,
  clauses: ClauseSpan[],
  claims: SpanClaim[],
): Coverage {
  const residue: ResidueSpan[] = [];
  const consumed: Span[] = [];

  for (const clause of clauses) {
    if (isClaimed(clause, claims)) {
      consumed.push({ start: clause.start, end: clause.end });
    } else {
      residue.push({
        text: clause.text,
        start: clause.start,
        end: clause.end,
        source: "failed_clause",
      });
    }
  }

  return {
    consumed,
    residue,
    intraClause: intraClauseRuns(message, clauses, claims, residue),
    verdict: residue.length ? "partial" : "complete",
  };
}

/** Maximal runs of unclaimed, non-structural characters inside otherwise-claimed clauses. */
function intraClauseRuns(
  message: string,
  clauses: ClauseSpan[],
  claims: SpanClaim[],
  residue: ResidueSpan[],
): ResidueSpan[] {
  const claimedChar = new Array<boolean>(message.length).fill(false);
  for (const claim of claims) {
    const start = Math.max(0, claim.span.start);
    const end = Math.min(message.length, claim.span.end);
    for (let i = start; i < end; i++) claimedChar[i] = true;
  }
  // A wholly-unclaimed clause is already reported as failed_clause; do not count it twice.
  for (const r of residue) {
    for (let i = r.start; i < r.end; i++) claimedChar[i] = true;
  }

  // Runs break on claimed characters only, not on whitespace, so "for yield" is reported
  // as one leftover phrase rather than two words. Runs that trim down to punctuation carry
  // no instruction and are dropped.
  const runs: ResidueSpan[] = [];
  for (const clause of clauses) {
    let runStart: number | null = null;
    for (let i = clause.start; i <= clause.end; i++) {
      const live = i < clause.end && !claimedChar[i];
      if (live && runStart == null) runStart = i;
      if (!live && runStart != null) {
        const raw = message.slice(runStart, i);
        const text = raw.trim();
        if (hasMeaningfulToken(text)) {
          runs.push({
            text,
            start: runStart + raw.indexOf(text),
            end: runStart + raw.indexOf(text) + text.length,
            source: "intra_clause",
          });
        }
        runStart = null;
      }
    }
  }
  return runs;
}
