/**
 * Deterministic ordered-step extraction for long multi-leg user prompts.
 *
 * Industry pattern (LangChain plan-then-execute, Anthropic fixed workflows):
 *   1) Decompose the user goal into an ordered plan (this module)
 *   2) Execute each step with tools (MultiLegAgent + MCP)
 *   3) Observe (HF / status) between steps
 *
 * This is NOT free-form tool roulette — Vanna maps only to known ops.
 */

import type { RoutedIntent } from "./types";
import {
  findBorrowAsset,
  findCollateralAsset,
  isMaxYieldInvestIntent,
  matchMinHealthFactor,
} from "./router";
import {
  accountCoverage,
  isClaimed,
  type ClauseSpan,
  type PlanConstraints,
  type PlanIR,
  type Span,
  type SpanClaim,
} from "./plan-ir";

export type ExtractedStep = {
  kind: "write";
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  args?: Record<string, unknown>;
};

/** An amount+asset pair with the range it was read from. */
type AmtAsset = { amount: number; asset: string; start: number; end: number };

const ASSET = "BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC";
/**
 * Amount + asset, e.g. "50 BLUSDC". Accepts thousands separators.
 *
 * Before this accepted commas, `\\d+` could not match across "1,240", so the scan slid
 * forward and matched the TAIL: "borrow 1,240 XLM" parsed as 240 XLM. That was not a
 * parse failure surfacing as a clarification — it was a silent order-of-magnitude error
 * in a real transaction amount. Commas are stripped before Number().
 */
const NUM = "\\d[\\d,]*(?:\\.\\d+)?";
const AMT_ASSET = new RegExp(`(${NUM})\\s*(${ASSET})\\b`, "i");
const LEVERAGE = /(\d+(?:\.\d+)?)\s*x\b/i;

/** Parse a matched amount, dropping thousands separators. */
function toNum(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * `offset` shifts the reported range into the coordinates of the original message, so a
 * pair matched inside a clause can still be marked consumed against the whole prompt.
 */
function allAmtAssets(text: string, offset = 0): AmtAsset[] {
  const out: AmtAsset[] = [];
  const re = new RegExp(AMT_ASSET.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const amount = toNum(m[1]);
    if (Number.isFinite(amount) && amount > 0) {
      out.push({
        amount,
        asset: m[2].toUpperCase(),
        start: offset + m.index,
        end: offset + m.index + m[0].length,
      });
    }
  }
  return out;
}

function lev(clause: string, globalLev: number | null): number | null {
  const m = clause.match(LEVERAGE);
  if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
  return globalLev;
}

/** Write verbs, used to protect the "deposit and borrow" idiom from the "and" split. */
export const STEP_VERB =
  "deposit|borrow|lend|park|farm|supply|swap|repay|redeem|withdraw|deploy|invest";

/**
 * Separators: "and then" / "then" / "after that" / "afterwards" / "next" / "finally" /
 * "also" / "plus", plus the punctuation people actually use — comma, semicolon,
 * sentence-ending period, newline — and a bare "and". Word separators come first so
 * "and then" wins over bare "and".
 */
const CLAUSE_SEPARATOR =
  /\b(?:and\s+then|then|after\s+that|afterwards|next|finally|also|plus)\b|\band\b|;|,(?!\d{3}\b)|\.\s+|\n+/;

/**
 * Split long prompts into ordered clauses, each carrying its range in the raw message.
 *
 * Three things this must not break, each a real ambiguity rather than a hypothetical:
 *
 *   1. Thousands separators. "borrow 1,240 XLM" must stay one number. A comma is only a
 *      separator when it is NOT followed by a three-digit group, so "1,240" and
 *      "1,240,000" survive while "50 BLUSDC, keep me above 1.4" splits.
 *   2. Decimals. The period rule requires trailing whitespace (`\.\s+`), so "1.4 health"
 *      and "0.5 XLM" are untouched while "Deposit 5 XLM. Borrow XLM." splits.
 *   3. The "deposit and borrow" idiom. `clauseToStep` maps that phrase to the single
 *      `deposit_and_borrow` op, which the executor expands with leverage. Splitting on
 *      the "and" there would produce a bare "deposit" clause with no amount. So verb-
 *      immediately-and-verb pairs are masked before the split —
 *      "deposit and borrow 100 USDC at 2x" stays one clause, while
 *      "deposit 100 USDC and borrow 50 XLM", where each verb owns an amount, splits.
 *
 * The mask is padded to the exact length of the separator it hides, and clause text is
 * sliced from the raw message rather than reassembled from the masked copy. Both details
 * are load-bearing. An earlier version substituted a 1-character sentinel for a
 * 5-character " and " and restored it afterwards, so any offset taken on the masked
 * string was wrong by 4 characters per guard and the clause text was a reconstruction
 * rather than the user's own words. On this particular idiom that is not cosmetic: a
 * split there yields an unlevered deposit plus an unlevered borrow, which executes
 * differently from the single levered op the user approved.
 */
export function splitStrategyClausesWithSpans(message: string): ClauseSpan[] {
  const lead = message.length - message.trimStart().length;
  const tail = message.trimEnd().length;
  if (lead >= tail) return [];

  const GUARD = "\u0001";
  const masked = message.replace(
    new RegExp(`\\b(${STEP_VERB})(\\s+and\\s+)(${STEP_VERB})\\b`, "gi"),
    (_m, a: string, sep: string, b: string) => `${a}${GUARD.repeat(sep.length)}${b}`,
  );

  const out: ClauseSpan[] = [];
  const re = new RegExp(CLAUSE_SEPARATOR.source, "gi");
  let cursor = lead;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    pushClause(out, message, cursor, m.index);
    cursor = m.index + m[0].length;
  }
  pushClause(out, message, cursor, tail);

  return out.length ? out : [{ text: message.slice(lead, tail), start: lead, end: tail }];
}

/** Trim the range to non-whitespace and keep it only if it could carry an instruction. */
function pushClause(out: ClauseSpan[], message: string, start: number, end: number): void {
  let s = Math.max(0, start);
  let e = Math.min(message.length, end);
  while (s < e && /\s/.test(message[s])) s++;
  while (e > s && /\s/.test(message[e - 1])) e--;
  if (e - s <= 2) return;
  out.push({ text: message.slice(s, e), start: s, end: e });
}

export function splitStrategyClauses(message: string): string[] {
  return splitStrategyClausesWithSpans(message).map((c) => c.text);
}

/** Every range in `clause` matched by `re`, in message coordinates. */
function kwSpans(clause: string, re: RegExp, offset: number): Span[] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(clause)) !== null) {
    out.push({ start: offset + m.index, end: offset + m.index + m[0].length });
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

const SPAN_VERB_SWAP = /\bswap\b/i;
const SPAN_VERB_FARM = /\b(?:farm|blend|deploy)\b/i;
const SPAN_VERB_LEND = /\b(?:park|lend|earn\s+yield|for\s+yield|supply\s+to\s+earn)\b/i;
const SPAN_VERB_DEPOSIT = /\bdeposit\b/i;
const SPAN_VERB_BORROW = /\bborrow\b/i;
const SPAN_VERB_REPAY = /\brepay\b/i;
const SPAN_VERB_REDEEM = /\b(?:redeem|withdraw)\b/i;
const SPAN_VERB_SUPPLY = /\b(?:supply|blend)\b/i;

/**
 * One clause to one write op, plus the ranges the matching rule actually read.
 *
 * The spans are what let the coverage check tell "this clause was understood" from "this
 * clause matched a rule that ignored most of it". They report the rule's own vocabulary
 * and the amount pair it used — not the whole clause — so leftover qualifiers show up in
 * the intra-clause diagnostic rather than being quietly counted as understood.
 */
function clauseToStepSpanned(
  clause: string,
  global: { leverage: number | null; minHf: number | null },
  offset = 0,
): { step: ExtractedStep; spans: Span[] } | null {
  const t = clause.toLowerCase();
  const pairs = allAmtAssets(clause, offset);
  const first = pairs[0] ?? null;
  const L = lev(clause, global.leverage);
  const levSpans = LEVERAGE.test(clause) ? kwSpans(clause, LEVERAGE, offset) : [];

  const pairSpan = (p: AmtAsset | null | undefined): Span[] =>
    p ? [{ start: p.start, end: p.end }] : [];

  // Constraints only (HF) — not a write
  if (
    /\b(keep|maintain|hold|above|health|hf|liquidat)\b/i.test(t) &&
    !/\b(lend|park|farm|swap|deposit|borrow|repay|redeem|supply|deploy)\b/i.test(t)
  ) {
    return null;
  }

  // Swap A → B
  if (SPAN_VERB_SWAP.test(t)) {
    const sm = clause.match(
      new RegExp(
        `(\\d+(?:\\.\\d+)?)\\s*(${ASSET})\\b.*?\\b(?:to|for|into)\\s*(${ASSET})\\b`,
        "i",
      ),
    );
    if (sm && sm.index != null) {
      const tokenIn = sm[2].toUpperCase();
      const tokenOut = sm[3].toUpperCase();
      return {
        step: {
          kind: "write",
          op: "swap",
          asset: tokenIn,
          amount: Number(sm[1]),
          args: { token_in: tokenIn, token_out: tokenOut, token_a: tokenIn, token_b: tokenOut },
        },
        spans: [
          ...kwSpans(clause, SPAN_VERB_SWAP, offset),
          { start: offset + sm.index, end: offset + sm.index + sm[0].length },
        ],
      };
    }
    if (first) {
      return {
        step: { kind: "write", op: "swap", asset: first.asset, amount: first.amount },
        spans: [...kwSpans(clause, SPAN_VERB_SWAP, offset), ...pairSpan(first)],
      };
    }
  }

  // Farm / Blend / levered deploy
  if (SPAN_VERB_FARM.test(t) && !/\b(stats|apy|position)\b/i.test(t)) {
    const farmPair = pairs.find((p) => p.asset !== "XLM") || pairs[0] || first;
    return {
      step: {
        kind: "write",
        op: "deploy_to_blend",
        asset: farmPair?.asset || "BLUSDC",
        amount: farmPair?.amount ?? null,
        leverage: L != null && L > 1 ? L : 2,
        args: { leverage: L != null && L > 1 ? L : 2 },
      },
      spans: [...kwSpans(clause, SPAN_VERB_FARM, offset), ...pairSpan(farmPair), ...levSpans],
    };
  }

  // Park / lend / earn
  if (SPAN_VERB_LEND.test(t)) {
    const xlm = pairs.find((p) => p.asset === "XLM") || first;
    return {
      step: {
        kind: "write",
        op: "lend",
        asset: xlm?.asset || "XLM",
        amount: xlm?.amount ?? null,
      },
      spans: [...kwSpans(clause, SPAN_VERB_LEND, offset), ...pairSpan(xlm)],
    };
  }

  // Deposit + borrow in same clause
  if (SPAN_VERB_DEPOSIT.test(t) && SPAN_VERB_BORROW.test(t)) {
    // `first` is the collateral — it carries the amount. The loan may name its own
    // asset ("deposit 500 AQUSDC … borrow XLM"); dropping it here made every levered
    // cross-asset ask come out denominated in the collateral token.
    const borrowAsset = findBorrowAsset(clause);
    return {
      step: {
        kind: "write",
        op: "deposit_and_borrow",
        asset: findCollateralAsset(clause) || first?.asset || "XLM",
        amount: first?.amount ?? null,
        leverage: L != null && L > 1 ? L : 2,
        args: {
          leverage: L != null && L > 1 ? L : 2,
          ...(borrowAsset ? { borrow_asset: borrowAsset } : {}),
        },
      },
      spans: [
        ...kwSpans(clause, SPAN_VERB_DEPOSIT, offset),
        ...kwSpans(clause, SPAN_VERB_BORROW, offset),
        ...pairSpan(first),
        ...levSpans,
      ],
    };
  }

  if (SPAN_VERB_DEPOSIT.test(t) && !/\bpool|earn|vault\b/i.test(t)) {
    return {
      step: {
        kind: "write",
        op: "deposit_collateral",
        asset: first?.asset || "XLM",
        amount: first?.amount ?? null,
      },
      spans: [...kwSpans(clause, SPAN_VERB_DEPOSIT, offset), ...pairSpan(first)],
    };
  }

  if (SPAN_VERB_BORROW.test(t) && !/\bcan\s+i\s+borrow\b/i.test(t)) {
    /**
     * A named asset with no number still names the asset.
     *
     * `first` is an amount+asset PAIR, so "borrow XLM" — no figure, because the size
     * comes from the leverage — left it null and fell straight through to the "USDC"
     * default. That is how a stated XLM borrow arrived as `borrow USDC / amount null`,
     * which then asked "which USDC?" about a token the user never mentioned.
     *
     * The pair still wins when there is one ("borrow 50 XLM"): it is the most specific
     * reading of the clause. `findBorrowAsset` only fills the gap, and it already knows
     * not to read "borrow against my XLM" as borrowing XLM.
     */
    const named = first?.asset || findBorrowAsset(clause);
    return {
      step: {
        kind: "write",
        op: "borrow",
        asset: named || "USDC",
        amount: first?.amount ?? null,
      },
      spans: [
        ...kwSpans(clause, SPAN_VERB_BORROW, offset),
        ...pairSpan(first),
        // Claim the bare asset word too, or coverage reports the token the step was
        // built from as unread text.
        ...(!first && named ? kwSpans(clause, new RegExp(`\\b${named}\\b`, "i"), offset) : []),
      ],
    };
  }

  if (SPAN_VERB_REPAY.test(t)) {
    return {
      step: {
        kind: "write",
        op: "repay",
        asset: first?.asset || "USDC",
        amount: first?.amount ?? null,
      },
      spans: [...kwSpans(clause, SPAN_VERB_REPAY, offset), ...pairSpan(first)],
    };
  }

  if (/\bredeem\b/i.test(t) || (/\bwithdraw\b/i.test(t) && /\b(earn|pool|supply)\b/i.test(t))) {
    return {
      step: {
        kind: "write",
        op: "redeem",
        asset: first?.asset || "XLM",
        amount: first?.amount ?? null,
      },
      spans: [...kwSpans(clause, SPAN_VERB_REDEEM, offset), ...pairSpan(first)],
    };
  }

  if (/\bsupply\b/i.test(t) && /\bblend\b/i.test(t)) {
    return {
      step: {
        kind: "write",
        op: "supply_to_blend",
        asset: first?.asset || "BLUSDC",
        amount: first?.amount ?? null,
      },
      spans: [...kwSpans(clause, SPAN_VERB_SUPPLY, offset), ...pairSpan(first)],
    };
  }

  return null;
}

/**
 * Map one natural-language clause to a single write op when possible.
 */
export function clauseToStep(
  clause: string,
  global: { leverage: number | null; minHf: number | null },
): ExtractedStep | null {
  return clauseToStepSpanned(clause, global)?.step ?? null;
}

const VOLATILE_ASSETS = new Set(["XLM", "AQUA"]);
const STABLE_ASSETS = new Set(["BLUSDC", "AQUSDC", "SOUSDC", "USDC", "EURC"]);

/** A named strategy that matched, with every range of the message it read. */
type StrategyOverlay = {
  id: string;
  label: string;
  steps: ExtractedStep[];
  /** Ops the strategy emitted, used to recognise clauses that only restate them. */
  ops: string[];
  spans: Span[];
};

function reSpan(m: RegExpMatchArray | null): Span | null {
  return m?.index != null ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * The phrase(s) naming a carry strategy, or null.
 *
 * "delta-neutral" and "carry" are returned as two separate spans rather than one range
 * spanning both. A single hull would swallow whatever sits between them, which is exactly
 * the drop this module exists to prevent: in "deposit 50 BLUSDC, farm 10 at 2x, run a
 * delta-neutral XLM carry" the farm clause lies between the deposit amount the strategy
 * reads and the phrase that names it.
 */
function carryPhraseSpans(message: string): Span[] | null {
  const dn = reSpan(message.match(/\bdelta[- ]?neutral\b/i));
  const carry = reSpan(message.match(/\bcarry\b/i));
  if (dn && carry) return [dn, carry];
  for (const re of [/\bcarry[- ]trade\b/i, /\bbasis[- ]trade\b/i, /\bcash[- ]and[- ]carry\b/i]) {
    const s = reSpan(message.match(re));
    if (s) return [s];
  }
  return null;
}

/**
 * Deterministic decomposition of a named delta-neutral / carry-trade strategy.
 *
 * The clause splitter cannot find this on its own. A prompt like "deposit my 50 BLUSDC
 * and run a delta-neutral XLM carry, keep me above 1.4 health" has no rule in
 * `clauseToStep` for "carry" at all, so the first matching rule wins: `/\bdeposit\b/`
 * fires and the sentence collapses to a single `deposit_collateral` write.
 *
 * The LLM planner (llm-planner.ts) already knows this vocabulary, but it is a network
 * call: when Vertex is slow, rate-limited, or returns a malformed plan, the fallback is
 * exactly the single-write collapse above. This makes the common case — one named
 * strategy, one stable deposit, one volatile carry asset — correct with zero network
 * dependency, so the LLM path only has to cover phrasing this does not.
 *
 * Produces: deposit_collateral(stable, amount) → borrow(carry, null) → lend(carry, null).
 * Borrow/lend amount is deliberately left null rather than mirroring the deposit amount —
 * the two assets differ, so "the same amount" from the strategy description means
 * value-equivalent, not numerically equal, and that conversion is not this function's job
 * to invent. A null amount asks the user for it as a `needs_input` leg once the deposit
 * has settled, never guesses it.
 *
 * Unlike the version this replaces, a match no longer suppresses clause extraction for
 * the rest of the message. It reports the ranges it read instead, and the caller runs the
 * splitter over everything left — which is what stops "…carry with 100 BLUSDC then farm
 * 10 BLUSDC at 2x" from losing its Blend leg.
 */
function deltaNeutralCarryOverlay(message: string): StrategyOverlay | null {
  const phrase = carryPhraseSpans(message);
  if (!phrase) return null;
  const pairs = allAmtAssets(message);
  if (!pairs.length) return null;

  const spans: Span[] = [...phrase];

  // Primary signal: the asset named directly before "carry" ("XLM carry").
  const adjacency = message.match(new RegExp(`\\b(${ASSET})\\s+carry\\b`, "i"));
  let carryAsset = adjacency ? adjacency[1].toUpperCase() : null;
  const adjacencySpan = reSpan(adjacency);
  if (adjacencySpan) spans.push(adjacencySpan);

  if (!carryAsset) {
    // "carry trade" / "basis trade" / "cash and carry" without the asset adjacent to the
    // word "carry" — fall back to the domain split: the carry leg is the volatile asset,
    // the deposit is the stable one. Checked first against pairs (asset WITH an amount),
    // then against bare mentions ("lending XLM" names the asset with no number attached,
    // since the carry leg's amount is never given up front).
    const volatilePair = pairs.find((p) => VOLATILE_ASSETS.has(p.asset));
    if (volatilePair) {
      carryAsset = volatilePair.asset;
      spans.push({ start: volatilePair.start, end: volatilePair.end });
    } else {
      for (const a of VOLATILE_ASSETS) {
        const mention = reSpan(message.match(new RegExp(`\\b${a}\\b`, "i")));
        if (mention) {
          carryAsset = a;
          spans.push(mention);
          break;
        }
      }
    }
  }
  if (!carryAsset) return null;

  const depositPair =
    pairs.find((p) => (p.asset === carryAsset ? false : STABLE_ASSETS.has(p.asset))) ||
    pairs.find((p) => p.asset !== carryAsset) ||
    null;
  if (!depositPair || depositPair.asset === carryAsset) return null;
  spans.push({ start: depositPair.start, end: depositPair.end });

  return {
    id: "delta_neutral_carry",
    label: "Delta-neutral carry",
    ops: ["deposit_collateral", "borrow", "lend"],
    steps: [
      {
        kind: "write",
        op: "deposit_collateral",
        asset: depositPair.asset,
        amount: depositPair.amount,
      },
      { kind: "write", op: "borrow", asset: carryAsset, amount: null },
      { kind: "write", op: "lend", asset: carryAsset, amount: null },
    ],
    spans,
  };
}

const OP_VERB_STEMS: Record<string, RegExp> = {
  deposit_collateral: /\bdeposit(?:s|ed|ing)?\b/gi,
  deposit_and_borrow: /\bdeposit(?:s|ed|ing)?\b|\bborrow(?:s|ed|ing)?\b/gi,
  borrow: /\bborrow(?:s|ed|ing)?\b/gi,
  lend: /\blend(?:s|ing)?\b|\blent\b/gi,
  deploy_to_blend: /\bfarm(?:s|ed|ing)?\b|\bdeploy(?:s|ed|ing)?\b/gi,
  supply_to_blend: /\bsuppl(?:y|ies|ied|ying)\b/gi,
};

/** Words that carry no instruction of their own when a clause restates a strategy. */
const ECHO_FILLER =
  /\b(?:it|them|the|then|a|an|and|to|into|on|of|for|with|my|same|amount|value|equivalent|back|again|side|leg|legs|both)\b/gi;

/**
 * True when a clause only restates legs the strategy already emitted — "borrowing and
 * lending XLM" following "run a carry trade".
 *
 * Without this the words would be reported as text nothing claimed, even though the plan
 * does contain those exact ops. It is deliberately narrow: only verbs for ops the
 * strategy actually emitted are removed, so a clause naming a different action
 * ("farm 10 at 2x") still counts as residue and still reaches `clauseToStep`.
 */
function isStrategyEcho(clause: string, overlay: StrategyOverlay): boolean {
  let rest = clause;
  for (const op of overlay.ops) {
    const re = OP_VERB_STEMS[op];
    if (re) rest = rest.replace(new RegExp(re.source, "gi"), " ");
  }
  for (const step of overlay.steps) {
    if (step.asset) rest = rest.replace(new RegExp(`\\b${step.asset}\\b`, "gi"), " ");
  }
  rest = rest.replace(ECHO_FILLER, " ");
  return !/[A-Za-z0-9]/.test(rest);
}

/**
 * Every constraint in the message, parsed once.
 *
 * The point of a struct rather than scattered `parse*` calls is that a constraint read
 * here can be carried on the plan and read downstream, instead of each consumer
 * re-deriving it from the raw text — which is how a floor ends up honoured in one place
 * and ignored in another.
 *
 * The leverage span is deliberately not claimed as a constraint: "farm 10 at 2x" is one
 * instruction, and marking "2x" here would hide it from that step's own accounting.
 */
export function extractConstraints(message: string): PlanConstraints {
  const spans: Span[] = [];
  const hf = matchMinHealthFactor(message);
  if (hf) spans.push({ start: hf.start, end: hf.end });

  const levM = message.match(LEVERAGE);

  return {
    minHf: hf?.value ?? null,
    leverage: levM && Number.isFinite(Number(levM[1])) ? Number(levM[1]) : null,
    preferMaxYield: isMaxYieldInvestIntent(message),
    spans,
  };
}

/**
 * Parse a message into steps, constraints, and an account of what was read.
 *
 * Order matters. Constraints first, so a floor is never mistaken for an amount. Then the
 * named-strategy overlay, which marks what it read without suppressing anything. Then the
 * splitter over every clause the strategy did not claim, so a follow-on leg survives a
 * strategy match instead of disappearing behind it.
 *
 * Steps come out in the order the message states them: the strategy block is anchored at
 * the earliest range it read, and each clause step at its clause. That keeps
 * "deposit … then farm …" in the user's order without inferring a dependency order the
 * user did not ask for.
 */
export function extractPlanIR(message: string): PlanIR {
  const constraints = extractConstraints(message);
  const overlay = deltaNeutralCarryOverlay(message);
  const clauses = splitStrategyClausesWithSpans(message);

  const strategyClaims: SpanClaim[] = (overlay?.spans ?? []).map((span) => ({
    span,
    by: "strategy" as const,
  }));
  const claims: SpanClaim[] = [
    ...constraints.spans.map((span) => ({ span, by: "constraint" as const })),
    ...strategyClaims,
  ];

  const positioned: Array<{ at: number; steps: ExtractedStep[] }> = [];
  if (overlay) {
    positioned.push({
      at: Math.min(...overlay.spans.map((s) => s.start)),
      steps: overlay.steps,
    });
  }

  let clauseSteps = 0;
  for (const clause of clauses) {
    if (overlay && isClaimed(clause, strategyClaims)) continue;
    if (overlay && isStrategyEcho(clause.text, overlay)) {
      claims.push({ span: { start: clause.start, end: clause.end }, by: "strategy" });
      continue;
    }

    const hit = clauseToStepSpanned(clause.text, constraints, clause.start);
    if (!hit) continue;

    // Drop HF-floor-as-amount: "keep HF above 1.4" must not become "borrow 1.4".
    if (
      hit.step.amount != null &&
      constraints.minHf != null &&
      Math.abs(hit.step.amount - constraints.minHf) < 1e-9 &&
      !new RegExp(`${hit.step.amount}\\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)`, "i").test(message)
    ) {
      hit.step.amount = null;
    }

    for (const span of hit.spans) claims.push({ span, by: "step" });
    positioned.push({ at: clause.start, steps: [hit.step] });
    clauseSteps++;
  }

  positioned.sort((a, b) => a.at - b.at);

  // Deduplicate consecutive identical ops
  const deduped = positioned
    .flatMap((p) => p.steps)
    .filter((s, i, arr) => {
      if (i === 0) return true;
      const p = arr[i - 1];
      return !(s.op === p.op && s.asset === p.asset && s.amount === p.amount);
    });

  // Put a split levered deposit+borrow back together before anything downstream can
  // treat the halves as two independent legs. See coalesceLeveragedDepositBorrow.
  const steps = coalesceLeveragedDepositBorrow(deduped, {
    leverage: constraints.leverage,
    message,
  });

  return {
    steps,
    constraints,
    coverage: accountCoverage(message, clauses, claims),
    source: !overlay ? "deterministic" : clauseSteps > 0 ? "merged" : "named_strategy",
    strategyId: overlay?.id ?? null,
  };
}

/** The minimum shape the coalesce pass needs — satisfied by both IR and plan steps. */
interface CoalescibleStep {
  kind?: string;
  op?: string | null;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  args?: Record<string, unknown>;
}

/**
 * Put a levered `deposit … borrow` back together as one `deposit_and_borrow`.
 *
 * ## The bug this exists to close
 *
 * "Deposit 100 BLUSDC at 2x and borrow XLM" is one levered position, and the router
 * reads it as exactly that — `deposit_and_borrow`, collateral BLUSDC 100, leverage 2,
 * borrow_asset XLM. But the message has two verbs and an "and", so `looksLikeMultiGoal`
 * sends it down the plan path, and the clause splitter only keeps "deposit and borrow"
 * whole when the two verbs are ADJACENT. Here they are not — "…BLUSDC at 2x / and /
 * borrow XLM" — so it split, and the halves lost what only the whole had:
 *
 *   deposit_collateral 100 BLUSDC   ← fine
 *   borrow ??? USDC                 ← no size (it was never written down; leverage
 *                                     implies it) and, before this, no asset either
 *
 * A borrow leg with a null amount cannot execute, so the user got "amount to be
 * confirmed", a "which USDC?" chip for a token they never named, and — after the
 * deposit settled — a prompt asking them to type a size the backend already knew how
 * to compute. Meanwhile `runWrite`'s `deposit_and_borrow` branch does compute it, via
 * `planLeverage` and the oracle. The information and the arithmetic were both present;
 * the split is what kept them apart.
 *
 * So rather than teach the plan path to size legs — a second implementation of the
 * same sizing, which is how these two drift apart again — this restores the shape that
 * already routes to the one that works. Merging back to a single write step also drops
 * the extracted plan below the two-step bar in `preferExtractedPlan`, so the router's
 * correct `deposit_and_borrow` survives instead of being replaced.
 *
 * ## When it deliberately does nothing
 *
 * Only the under-determined shape is merged. If the user sized the borrow themselves
 * ("deposit 100 BLUSDC and borrow 50 XLM") both legs are already fully determined and
 * execute correctly as two steps — merging those would rewrite a plan that works, and
 * would let a leverage figure elsewhere in the sentence override a figure the user
 * actually typed. Same for a missing or ≤1 leverage: with no multiplier there is
 * nothing to size from, and the honest outcome is still to ask.
 */
export function coalesceLeveragedDepositBorrow<T extends CoalescibleStep>(
  steps: T[],
  opts: { leverage?: number | null; message?: string },
): T[] {
  if (steps.length < 2) return steps;

  const out: T[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const dep = steps[i];
    const bor = steps[i + 1];
    const depLev = Number(dep?.leverage ?? dep?.args?.leverage ?? NaN);
    const borLev = Number(bor?.leverage ?? bor?.args?.leverage ?? NaN);
    const L = [depLev, borLev, Number(opts.leverage ?? NaN)].find((n) => Number.isFinite(n) && n > 1);

    const mergeable =
      bor != null &&
      dep?.op === "deposit_collateral" &&
      bor.op === "borrow" &&
      dep.amount != null &&
      dep.amount > 0 &&
      !!dep.asset &&
      // An explicit borrow size is the user's own answer — never overwrite it.
      (bor.amount == null || !(bor.amount > 0)) &&
      L != null;

    if (!mergeable) {
      out.push(dep);
      continue;
    }

    /**
     * The user's own words outrank a step field here. The borrow leg's asset may be a
     * default that a producer (the LLM, or this extractor before the fix above) filled
     * in when it could not see the token — and "USDC" is exactly that default. When the
     * message names a borrow asset, that is the answer (product rule B).
     */
    const fromMessage = opts.message ? findBorrowAsset(opts.message) : null;
    const borrowAsset = fromMessage || bor.asset || dep.asset || null;

    out.push({
      ...dep,
      op: "deposit_and_borrow",
      asset: dep.asset,
      amount: dep.amount,
      leverage: L,
      args: {
        ...(dep.args || {}),
        ...(bor.args || {}),
        leverage: L,
        ...(borrowAsset ? { borrow_asset: borrowAsset } : {}),
      },
    } as T);
    i += 1; // the borrow leg is now part of the merged step
  }
  return out;
}

/**
 * Extract an ordered multi-leg plan from free-form English.
 * Returns null if fewer than 2 write steps (not multi-leg).
 */
export function extractOrderedPlan(message: string): Extract<RoutedIntent, { kind: "plan" }> | null {
  const ir = extractPlanIR(message);
  const deduped = ir.steps;

  if (deduped.length < 2) return null;

  const parts = deduped.map((s, i) => {
    const a = s.amount != null ? `${s.amount} ` : "";
    const L = s.leverage != null && s.leverage > 1 ? ` at ${s.leverage}×` : "";
    const to =
      s.op === "swap" && s.args?.token_out ? `→${s.args.token_out}` : s.asset || "";
    return `${i + 1}) ${s.op} ${a}${to}${L}`.trim();
  });

  // A named strategy that also picked up follow-on legs is summarised as the full list
  // rather than the strategy sentence, so the extra legs are visible in the approval text
  // and not just in the step rows.
  const summary =
    ir.strategyId && ir.source === "named_strategy"
      ? `Delta-neutral carry: deposit ${deduped[0].amount ?? "?"} ${deduped[0].asset}, borrow ${deduped[1].asset}, lend ${deduped[1].asset}`
      : ir.strategyId
        ? `Delta-neutral carry, then: ${parts.join(" → ")}`
        : `Multi-step strategy: ${parts.join(" → ")}`;

  return {
    kind: "plan",
    // Distinct from the generic "extracted_multi_goal": handle.ts checks this to skip
    // the LLM-planner override for a carry plan. Once the deterministic decomposition
    // has correctly recognized the strategy, a model call returning a DIFFERENT but
    // equal-length plan must not be allowed to replace it with a wrong one — that
    // "same step count, different content" swap is exactly how this broke before.
    template_id: ir.strategyId ?? "extracted_multi_goal",
    summary,
    steps: deduped.map((s) => ({
      kind: "write" as const,
      op: s.op,
      asset: s.asset ?? null,
      amount: s.amount ?? null,
      args: s.args,
      leverage: s.leverage ?? null,
    })),
    constraints: ir.constraints,
  };
}

/**
 * Merge extracted ordered steps into a routed plan (fill missing amounts/ops).
 * Prefer extracted order when both are multi-step (clause order = user order).
 */
export function preferExtractedPlan(
  routed: RoutedIntent,
  message: string,
): RoutedIntent {
  const extracted = extractOrderedPlan(message);
  if (!extracted || extracted.steps.length < 2) return routed;

  if (routed.kind !== "plan") {
    return extracted;
  }

  const rWrites = routed.steps.filter((s) => s.kind === "write");
  // Prefer extracted when it has more legs or clearer swap token_out
  const hasSwapOut = extracted.steps.some(
    (s) => s.op === "swap" && s.args?.token_out,
  );
  const routedSwapBare =
    rWrites.some((s) => s.op === "swap") &&
    !rWrites.some((s) => s.op === "swap" && s.args?.token_out);

  if (extracted.steps.length >= rWrites.length || (hasSwapOut && routedSwapBare)) {
    return extracted;
  }

  // Fill gaps: for each routed write missing amount, take from extracted same op
  const byOp = new Map(
    extracted.steps.filter((s) => s.op).map((s) => [s.op!, s] as const),
  );
  const steps = routed.steps.map((s) => {
    if (s.kind !== "write" || !s.op) return s;
    const ex = byOp.get(s.op);
    if (!ex) return s;
    return {
      ...s,
      amount: s.amount != null && s.amount > 0 ? s.amount : ex.amount,
      asset: s.asset || ex.asset,
      args: { ...(ex.args || {}), ...(s.args || {}) },
      leverage: s.leverage ?? ex.leverage ?? null,
    };
  });

  return { ...routed, steps };
}
