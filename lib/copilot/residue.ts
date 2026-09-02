/**
 * What to do with text no extractor claimed.
 *
 * The control flow here is inverted relative to the cascade that caused the bugs this
 * exists to prevent. That cascade asked "does this look like something I can ignore?" and
 * fell through to ignoring it — so an unmatched fragment was treated as absent, and the
 * one class of input that must never be dropped, a second instruction, was dropped
 * silently whenever no rule happened to recognise it.
 *
 * This asks the opposite question. Leftover text must MATCH a known-safe pattern to be
 * dropped; anything else surfaces. The failure mode becomes asking a question the user
 * did not need, instead of executing a plan the user did not ask for.
 *
 * One discriminator does most of the work. A conditional conjunction is necessary but not
 * sufficient evidence of a condition: "do it if you can" is a politeness hedge with
 * nothing to watch, while "unless XLM drops below 0.10" names a quantity, a comparator,
 * and a threshold. Treating the first as a condition means refusing ordinary requests;
 * treating the second as filler means accepting an order we cannot honour.
 *
 * Phase 1 runs this in shadow: verdicts are computed and logged, never shown. Turning it
 * loud needs an observed over-ask rate to argue from, not an assumed one.
 *
 * Pure and offline.
 */

import type { Coverage, ResidueSpan } from "./plan-ir";
import { STEP_VERB } from "./step-extractor";

export type ResidueClass =
  | "action"
  | "condition"
  | "hedge"
  | "filler"
  | "sentiment"
  | "unknown";

export type ResidueDecision =
  /** Safe to ignore entirely. */
  | "drop"
  /** Record it, do not act on it, do not ask about it. */
  | "note"
  /** A capability we do not have; hand to the automation-gap refusal. */
  | "refuse"
  /** A step we failed to parse; re-parse or ask rather than guess. */
  | "parse_or_ask"
  /** Unrecognised. Show it to the user rather than deciding for them. */
  | "surface";

export type ResidueVerdict = {
  span: ResidueSpan;
  class: ResidueClass;
  decision: ResidueDecision;
  /** The rule that decided, for the shadow log. */
  reason: string;
};

/**
 * Action verbs, stem-tolerant. Sourced from the extractor's own verb list so the two
 * cannot disagree about what counts as an instruction.
 *
 * The suffix set over-matches slightly in the direction of "this is an action" — "invest"
 * also catches "investigate". That asymmetry is deliberate: a false action reading costs a
 * question, a missed one costs a dropped instruction.
 */
const ACTION_VERB = new RegExp(`\\b(?:${STEP_VERB})(?:s|es|ed|d|ing|ping|ning)?\\b`, "i");
const AMOUNT_WITH_UNIT = /\b\d+(?:[.,]\d+)?\s*(?:[A-Z]{3,6}|x)\b/;

const CONDITIONAL = /\b(?:if|unless|when|whenever|once|as\s+soon\s+as|in\s+case|should)\b/i;

/**
 * A comparator against a number. Both halves are required: "below" alone could be
 * "below the fold", and a bare number could be an amount.
 */
const COMPARATOR =
  /\b(?:below|under|above|over|beneath|less\s+than|more\s+than|greater\s+than|reach(?:es)?|hit(?:s)?|cross(?:es)?|drops?|falls?|rises?|goes?|moves?|dips?|pumps?|>=?|<=?)\b/i;

/** Politeness dressed as a condition. Must be a closed list; this class silently drops. */
const HEDGE =
  /\b(?:if\s+(?:you\s+can|possible|convenient|that'?s\s+(?:ok|okay|fine|alright)|it\s+makes\s+sense|need(?:ed)?\s+be|you\s+don'?t\s+mind)|when(?:ever)?\s+you\s+(?:can|get\s+a\s+chance)|if\s+not,?\s*(?:that'?s\s+fine|no\s+worries|never\s+mind))\b/i;

const FILLER_LEXICON =
  /\b(?:please|pls|plz|kindly|thanks|thank\s+you|ty|thx|cheers|ok|okay|sure|yes|yep|no|nope|just|simply|only|also|too|as\s+well|now|right\s+now|today|asap|quickly|fast|soon|go\s+ahead|do\s+it|let'?s|lets|for\s+me|on\s+my\s+behalf|the|a|an|and|or|but|to|into|onto|of|in|on|at|by|with|from|my|me|i|it|that|this|there|some|all|any|be|is|are|can|could|would|will|want|wanna|like|need|make|get|got|use|then|so|well|hey|hi|hello|cool|great|nice|awesome|perfect|sweet|alright)\b/gi;

/**
 * Reassurance-seeking phrasing: a risk posture stated as an instruction it is not.
 *
 * Matched as a whole phrase, and the trailing adjective set is closed, because the bare
 * verb is load-bearing elsewhere. "keep me above 1.4" is a health-factor floor and must
 * reach the constraint extractor intact; "above" is deliberately absent from the set below
 * so that phrase cannot be absorbed here even if constraint extraction ever misses it.
 */
const REASSURANCE =
  /\bkeep\s+(?:it|them|us|me|things?|everything|my\s+\w+)\s+(?:safe|sound|secure|protected|steady|stable|healthy|good|ok|okay)\b/gi;

/**
 * Feelings and risk posture. Noted rather than dropped: it can legitimately inform how a
 * plan is framed, but it must never become a step.
 */
const SENTIMENT_LEXICON =
  /\b(?:bullish|bearish|long|short|scared|nervous|worried|anxious|nervy|confident|greedy|fearful|risky|risk[- ]?on|risk[- ]?off|degen|yolo|ape|moon|moderate|conservative|aggressive|cautious|careful|safe|safely|think|feel|believe|hope|guess|reckon|honestly|tbh|imo|lol|haha)\b/gi;

const PUNCTUATION = /[^\p{L}\p{N}]+/gu;

function isExhaustedBy(text: string, ...lexicons: RegExp[]): boolean {
  let rest = text;
  for (const lex of lexicons) {
    rest = rest.replace(new RegExp(lex.source, lex.flags.includes("g") ? lex.flags : `${lex.flags}g`), " ");
  }
  return !rest.replace(PUNCTUATION, "").length;
}

/** Something concrete enough that we could evaluate it if we had a watcher. */
export function hasWatchablePredicate(text: string): boolean {
  return COMPARATOR.test(text) && /\d/.test(text);
}

/** Remove hedge phrasing so what remains can be judged on its own. */
export function stripHedges(text: string): string {
  return text.replace(new RegExp(HEDGE.source, "gi"), " ").trim();
}

/**
 * Classify one span of unclaimed text.
 *
 * Order is the whole design. Action is tested before every safe class, because a fragment
 * that names an operation is an instruction regardless of how politely it is worded — the
 * previous cascade got this backwards and let a courteous second goal fall through to
 * being ignored. Conditions come next, because they are the class we must refuse rather
 * than attempt. Only then do the drop-eligible classes get their turn, and each must
 * account for every word in the span to claim it.
 */
export function classifyResidueText(text: string): { class: ResidueClass; decision: ResidueDecision; reason: string } {
  const bare = stripHedges(text);

  if (ACTION_VERB.test(bare) || AMOUNT_WITH_UNIT.test(bare)) {
    return {
      class: "action",
      decision: "parse_or_ask",
      reason: ACTION_VERB.test(bare) ? "action_verb" : "amount_with_unit",
    };
  }

  if (CONDITIONAL.test(text)) {
    if (hasWatchablePredicate(text)) {
      return { class: "condition", decision: "refuse", reason: "watchable_predicate" };
    }
    if (HEDGE.test(text) && isExhaustedBy(bare, FILLER_LEXICON)) {
      return { class: "hedge", decision: "drop", reason: "closed_list_hedge" };
    }
    // A conditional with nothing watchable and no recognised hedge phrasing. We cannot
    // honour it and cannot prove it is harmless, so it goes to the user.
    return { class: "unknown", decision: "surface", reason: "conditional_not_watchable" };
  }

  if (isExhaustedBy(text, FILLER_LEXICON)) {
    return { class: "filler", decision: "drop", reason: "filler_lexicon" };
  }

  if (isExhaustedBy(text, REASSURANCE, SENTIMENT_LEXICON, FILLER_LEXICON)) {
    return { class: "sentiment", decision: "note", reason: "sentiment_lexicon" };
  }

  return { class: "unknown", decision: "surface", reason: "no_safe_pattern" };
}

export function classifyResidue(span: ResidueSpan): ResidueVerdict {
  return { span, ...classifyResidueText(span.text) };
}

/** Verdicts for whole clauses nothing claimed. Intra-clause runs are not classified yet. */
export function classifyCoverage(coverage: Coverage): ResidueVerdict[] {
  return coverage.residue.map(classifyResidue);
}

/**
 * Whether any leftover text would change what the copilot should do.
 *
 * This is the number Phase 2 gates on: `drop` and `note` are free, the other three mean
 * the deterministic plan is not the whole request.
 */
export function residueIsMaterial(verdicts: ResidueVerdict[]): boolean {
  return verdicts.some((v) => v.decision !== "drop" && v.decision !== "note");
}
