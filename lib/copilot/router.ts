/**
 * Deterministic intent router (keyword + regex).
 * Primary path when no external LLM is configured; always available as fallback.
 *
 * Strips G/C Stellar addresses before parsing amounts so digits inside addresses
 * never become fake quantities.
 */

import type { RoutedIntent } from "./types";
import { findAmountFraction, findBalanceFraction } from "./amount-intent";
import { ASSET_SCAN_ORDER } from "./registry/assets";
import { usdcVariantClarifyMessage } from "./mcp-write";

/**
 * Scan order comes from the asset registry — one membership list, guarded by a test,
 * instead of the six that used to disagree. Still longest-first so BLUSDC wins over
 * the USDC nested inside it.
 */
const ASSETS = ASSET_SCAN_ORDER;
/** The same list as a regex alternation, so the patterns below cannot drift from it. */
const ASSET_ALT = ASSET_SCAN_ORDER.join("|");

/** Known junk / unsupported tickers we should reject, not map to USDC. */
const UNSUPPORTED_ASSETS = [
  "DOGE",
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "ADA",
  "DOT",
  "SHIB",
  "PEPE",
  "MATIC",
  "AVAX",
] as const;

const ADDR_RE = /\b[GC][A-Z0-9]{55,56}\b/g;
const AMOUNT_ASSET_RE = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(${ASSET_ALT})\b`, "i");
const BARE_AMOUNT_RE = /(\d+(?:\.\d+)?)/;
// `×` (U+00D7) needs no trailing \b the way ascii "x" does — it's never a prefix of a
// real word, and the app's OWN summaries/labels render leverage as "2×", not "2x" (see
// step-extractor.ts's PLAN_SUMMARY and plan-approval.ts's labelFor). Matching only ascii
// "x" meant a resent/rendered summary silently lost its leverage on the round trip.
const LEVERAGE_RE = /(\d+(?:\.\d+)?)\s*(?:x\b|×)/i;

function stripAddresses(message: string): string {
  return message.replace(ADDR_RE, " ");
}

/**
 * Resolve a supported asset with word boundaries.
 * Never treat the "USDC" inside "BLUSDC" as bare USDC.
 */
export function findAsset(text: string): string | null {
  const upper = text.toUpperCase();
  for (const a of ASSETS) {
    const re = new RegExp(`(?:^|[^A-Z0-9])${a}(?:[^A-Z0-9]|$)`);
    if (re.test(upper)) return a;
  }
  return null;
}

/**
 * The first asset by POSITION in the sentence, not by table order.
 *
 * `findAsset` scans the ASSETS table longest-first, so "deposit 500 AQUSDC … borrow
 * XLM" returns AQUSDC no matter which side of the sentence it sits on. That is right
 * when a message names one asset and wrong the moment it names two for two different
 * slots — the second one is simply never seen. Alternation is still longest-first so
 * the USDC inside BLUSDC never matches on its own.
 */
export function firstAssetByPosition(text: string): string | null {
  const m = text
    .toUpperCase()
    .match(new RegExp(`(?:^|[^A-Z0-9])(${ASSETS.join("|")})(?:[^A-Z0-9]|$)`));
  return m ? (m[1] as string) : null;
}

/** Words after which the asset named is what backs the loan, not what is borrowed. */
const COLLATERAL_PIVOT = /\b(against|using|backed by|collateral(?:ised|ized)?)\b/i;
const BORROW_VERB = /\bborrow(?:s|ed|ing)?\b/i;
const COLLATERAL_VERB = /\b(deposit|park|put|post|supply|lever(?:age)?d?|with|using)\b/i;

/**
 * The asset the user wants to BORROW, when they named one.
 *
 * Independent of the collateral slot on purpose (product rule B): "deposit AQUSDC …
 * borrow XLM" borrows XLM. Collapsing the two — which every producer did, by passing
 * one `asset` for both legs — is what turned a stated XLM borrow into a "which USDC?"
 * chip prompt.
 *
 * Returns null when the sentence names no borrow asset, which legitimately means "the
 * same asset" and is resolved downstream, not guessed here.
 */
export function findBorrowAsset(text: string): string | null {
  const cleaned = stripAddresses(text);
  const verb = cleaned.match(BORROW_VERB);
  if (!verb || verb.index == null) return null;
  let after = cleaned.slice(verb.index + verb[0].length);
  // "borrow against my XLM" names collateral, not a borrow asset. Cut there so the
  // backing asset is never mistaken for the thing being borrowed.
  const pivot = after.match(COLLATERAL_PIVOT);
  if (pivot && pivot.index != null) after = after.slice(0, pivot.index);
  return firstAssetByPosition(after);
}

/**
 * The asset being posted as COLLATERAL, when the sentence separates the two slots.
 *
 * Falls back to the plain first-asset scan, so single-asset phrasings behave exactly
 * as before.
 */
export function findCollateralAsset(text: string): string | null {
  const cleaned = stripAddresses(text);
  const verb = cleaned.match(COLLATERAL_VERB);
  if (verb && verb.index != null) {
    let after = cleaned.slice(verb.index + verb[0].length);
    // Stop at the borrow clause so "deposit … and borrow XLM" cannot read XLM as
    // the collateral.
    const borrow = after.match(BORROW_VERB);
    if (borrow && borrow.index != null) after = after.slice(0, borrow.index);
    const found = firstAssetByPosition(after);
    if (found) return found;
  }
  // "borrow 20 XLM against my AQUSDC" — collateral follows the pivot instead.
  const pivot = cleaned.match(COLLATERAL_PIVOT);
  if (pivot && pivot.index != null) {
    const found = firstAssetByPosition(cleaned.slice(pivot.index + pivot[0].length));
    if (found) return found;
  }
  return findAsset(cleaned);
}

/**
 * An explicit borrow size, when the user gave one instead of (or beside) a multiple.
 *
 * Leverage is stripped first so "3x" never reads as a quantity — the same trap
 * findAmount guards against for the deposit slot.
 *
 * Bare "borrow 3" (no asset) next to a deposit is leverage, not 3 tokens — see
 * {@link findLeverage}. Returning 3 here is what sized a $3 loan instead of 3×.
 */
export function findBorrowAmount(text: string): number | null {
  const cleaned = stripAddresses(text).replace(LEVERAGE_RE, " ");
  const verb = cleaned.match(BORROW_VERB);
  if (!verb || verb.index == null) return null;
  let after = cleaned.slice(verb.index + verb[0].length);
  const pivot = after.match(COLLATERAL_PIVOT);
  if (pivot && pivot.index != null) after = after.slice(0, pivot.index);
  // Asset-tagged size always wins: "borrow 50 XLM" / "borrow 3 SOUSDC".
  const withAsset = after.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(${ASSET_ALT})\b`, "i"));
  if (withAsset) {
    const n = Number(withAsset[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Bare number after borrow with a deposit in the same prompt is the multiple
  // ("deposit 20 and borrow 3"), not a token quantity.
  if (/\bdeposit\b/i.test(cleaned) && isBorrowBareLeverageShorthand(after)) {
    return null;
  }
  const m = after.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** First unsupported ticker mentioned, if any. */
export function findUnsupportedAsset(text: string): string | null {
  const upper = text.toUpperCase();
  for (const a of UNSUPPORTED_ASSETS) {
    const re = new RegExp(`(?:^|[^A-Z0-9])${a}(?:[^A-Z0-9]|$)`);
    if (re.test(upper)) return a;
  }
  return null;
}

/**
 * "1,000" and "1k" both mean one thousand, but neither `AMOUNT_ASSET_RE` nor
 * `BARE_AMOUNT_RE` read past the comma or the suffix — "1,000 BLUSDC" asked for an
 * amount instead of parsing 1000 (safe, but not what G-07 wants), and "1k BLUSDC" (G-08)
 * silently parsed as 1, then actually borrowed 1 BLUSDC instead of 1000 — the one outcome
 * that spec explicitly rules out. Expanded once, before any amount pattern runs, so both
 * shapes read as a normal bare number from there on.
 */
function normalizeShorthandAmounts(text: string): string {
  return text
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\b(\d+(?:\.\d+)?)\s*k\b/gi, (_m, n) => String(Number(n) * 1000));
}

function findAmount(text: string): number | null {
  const cleaned = stripAddresses(normalizeShorthandAmounts(text));
  // Explicit negative amounts (Sanujit EW8) — return the signed value so
  // validateLendParams can reject them instead of dropping the sign.
  const negWithAsset = cleaned.match(
    new RegExp(String.raw`(-\d+(?:\.\d+)?)\s*(${ASSET_ALT})\b`, "i"),
  );
  if (negWithAsset) {
    const n = Number(negWithAsset[1]);
    return Number.isFinite(n) ? n : null;
  }
  const withAsset = cleaned.match(AMOUNT_ASSET_RE);
  if (withAsset) {
    const n = Number(withAsset[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Avoid treating leverage "5x" or share "25%" as an absolute size — those are
  // leverage / fraction slots. "repay 25% of my XLM" must not become amount=25.
  //
  // Also strip a fabricated price ("pretend the price of XLM is $10 and size my borrow
  // off that" — J-07). No asset sits next to that $10, so it fell through to this bare
  // fallback and became a real borrow of 10 XLM — the number was never a size the user
  // stated, only a hypothetical price. The bare fallback has no way to tell a genuine
  // size from any other digit in the sentence, so the fix is removing the price clause
  // before it ever reaches this pattern.
  const noPretendPrice = cleaned.replace(
    /\b(?:pretend|imagine|assume|suppose|say|treat it as if)\b[^.?!]*?\bprice\b[^.?!]*?\$?\s*\d+(?:\.\d+)?/gi,
    " ",
  );
  const noLev = noPretendPrice.replace(LEVERAGE_RE, " ").replace(/\b\d+(?:\.\d+)?\s*%/g, " ");
  const m = noLev.match(BARE_AMOUNT_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Stated leverage multiple — same meaning as the margin UI slider.
 *
 * Accepts:
 *   - "3x" / "3×" / "at 2 x"
 *   - "leverage 3" / "3 leverage"
 *   - "deposit 20 SOUSDC and borrow 3"  ← bare N after borrow is Nx when no asset
 *     follows (site users type this constantly; requiring the letter "x" made the
 *     plan path split into deposit + "how much to borrow?" after collateral settled).
 *
 * Does NOT treat "borrow 3 SOUSDC" as leverage — that is an explicit 3-token size.
 */
export function findLeverage(text: string): number | null {
  const cleaned = stripAddresses(text);

  const withX = cleaned.match(LEVERAGE_RE);
  if (withX) {
    const n = Number(withX[1]);
    if (Number.isFinite(n) && n > 1) return n;
  }

  const levPhrase =
    cleaned.match(/\bleverage\s*(?:of\s*)?(\d+(?:\.\d+)?)\b/i) ||
    cleaned.match(/\b(\d+(?:\.\d+)?)\s*leverage\b/i);
  if (levPhrase) {
    const n = Number(levPhrase[1]);
    if (Number.isFinite(n) && n > 1) return n;
  }

  // Deposit + bare "borrow N" (optional trailing x already stripped by no-asset check).
  if (/\bdeposit\b/i.test(cleaned) && BORROW_VERB.test(cleaned)) {
    const verb = cleaned.match(BORROW_VERB);
    if (verb && verb.index != null) {
      let after = cleaned.slice(verb.index + verb[0].length);
      const pivot = after.match(COLLATERAL_PIVOT);
      if (pivot && pivot.index != null) after = after.slice(0, pivot.index);
      if (isBorrowBareLeverageShorthand(after)) {
        const m = after.match(/^\s*(\d+(?:\.\d+)?)/);
        if (m) {
          const n = Number(m[1]);
          // Multiples the UI actually offers; 1× is "no leverage", >20 is not a slider.
          if (Number.isFinite(n) && n > 1 && n <= 20) return n;
        }
      }
    }
  }

  return null;
}

/**
 * After the word "borrow", is the next token a bare multiple (3 / 3x) rather than
 * "3 SOUSDC" or "50 XLM"?
 */
function isBorrowBareLeverageShorthand(afterBorrow: string): boolean {
  const s = afterBorrow.trimStart();
  if (!s) return false;
  // Explicit token amount — not leverage.
  if (new RegExp(String.raw`^\d+(?:\.\d+)?\s*(${ASSET_ALT})\b`, "i").test(s)) return false;
  // "3" or "3x" then end / punctuation / keep HF / and then…
  return /^\d+(?:\.\d+)?\s*(?:x|×)?(?:\s*$|[\s,.;]|\band\b|\bkeep\b|\bwith\b|\bat\b|\bthen\b)/i.test(
    s,
  );
}

/**
 * Parse “5 XLM and 1 BLUSDC” / “5 XLM + 1 USDC” dual-leg amounts for LP.
 */
function parseDualAmounts(text: string): {
  amount_a: number;
  token_a: string;
  amount_b: number;
  token_b: string;
} | null {
  const cleaned = stripAddresses(text);
  const re =
    /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC|USDT)\b(?:\s+and\s+|\s*\+\s*|\s*&\s*)(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC|USDT)\b/i;
  const m = cleaned.match(re);
  if (!m) return null;
  const amount_a = Number(m[1]);
  const amount_b = Number(m[3]);
  if (!Number.isFinite(amount_a) || !(amount_a > 0) || !Number.isFinite(amount_b) || !(amount_b > 0)) {
    return null;
  }
  return {
    amount_a,
    token_a: m[2]!.toUpperCase(),
    amount_b,
    token_b: m[4]!.toUpperCase(),
  };
}

function has(text: string, ...words: string[]): boolean {
  return words.every((w) => text.includes(w));
}

/**
 * Phrase/word match. Single tokens use word boundaries so “lend” does **not**
 * match inside “blend” (was breaking swap→farm into a fake lend leg).
 * Multi-word phrases still use substring includes.
 */
function any(text: string, ...words: string[]): boolean {
  return words.some((w) => {
    const needle = w.toLowerCase();
    if (!needle) return false;
    if (/\s/.test(needle)) return text.includes(needle);
    // Escape regex metacharacters in the keyword
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, "i").test(text);
  });
}

/**
 * The floor with the character range it was read from.
 *
 * Span accounting (plan-ir.ts) needs to know which part of the message the floor
 * consumed, so that "keep me above 1.4" is not later reported as text no component
 * claimed. The regexes live here only — `parseMinHealthFactor` reads its value from
 * this, so the two can never disagree about what counts as a floor.
 */
export type MinHealthFactorMatch = { value: number; start: number; end: number };

/** “keep HF above 1.5” / “health factor over 2” / “never liquidate” */
export function matchMinHealthFactor(text: string): MinHealthFactorMatch | null {
  const m =
    text.match(
      /(?:keep|maintain|hold|stay|above|over|min(?:imum)?)\s*(?:my\s+)?(?:hf|health\s*factor)\s*(?:above|over|at\s+least|>=?)\s*(\d+(?:\.\d+)?)/i,
    ) ||
    text.match(/(?:hf|health\s*factor)\s*(?:above|over|at\s+least|>=?)\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(?:above|over|at\s+least)\s*(\d+(?:\.\d+)?)\s*(?:hf|health)/i);
  if (m && m.index != null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 50) {
      return { value: n, start: m.index, end: m.index + m[0].length };
    }
  }
  // Soft floor when user only says avoid liquidation (no number).
  const soft =
    text.match(/\b(?:avoid|prevent|never|no)\s+liquidat\w*/i) ||
    text.match(/\bdon'?t\s+(?:get\s+)?liquidat\w*/i) ||
    text.match(/\bprotect\s+(?:me|my\s+account)\s+from\s+liquidat\w*/i);
  if (soft && soft.index != null) {
    return { value: 1.3, start: soft.index, end: soft.index + soft[0].length };
  }
  return null;
}

export function parseMinHealthFactor(text: string): number | null {
  return matchMinHealthFactor(text)?.value ?? null;
}

/** “invest where max profit” / “best yield” / “earn me something” allocation intent */
export function isMaxYieldInvestIntent(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(what|which|show|list|how much)\b/.test(t) && /\b(apy|apr|yield|pays)\b/.test(t)) {
    return false; // pure read
  }
  return (
    /\b(invest|allocate|put|deploy|park|earn me|make me|grow)\b/.test(t) &&
    /\b(max|maximum|best|highest|most|optimal)\b/.test(t) &&
    /\b(yield|profit|return|apy|earn|pay)\b/.test(t)
  ) || (
    /\b(earn me|make me money|grow my|invest my)\b/.test(t) &&
    /\b(farm|earn|pool|market|blend|wherever)\b/.test(t)
  ) || (
    /\b(where|wherever).*(best|highest|max).*(yield|apy|return|profit)\b/.test(t) &&
    /\b(invest|put|supply|lend|farm|deposit)\b/.test(t)
  ) || (
    // "max yield with my XLM" names no verb at all — just a superlative, an asset, and a
    // possessive. Without this it fell through to clarify_capabilities, the generic
    // catch-all, on a request the other three clauses above already know how to answer.
    /\b(max|maximum|best|highest|most|optimal)\b/.test(t) &&
    /\b(yield|profit|return|apy|earn|pay)\b/.test(t) &&
    /\bmy\b/.test(t)
  );
}

/**
 * Multi-domain narratives → plan (must run *before* single-op deposit/repay/lend
 * so “repay then deposit” is not collapsed to repay alone).
 */
function tryMultiGoalPlan(
  raw: string,
  text: string,
  asset: string | null,
  amount: number | null,
  leverage: number | null,
): RoutedIntent | null {
  /**
   * "post 200 XLM and borrow BLUSDC" executed a bare `borrow 200 BLUSDC` — no deposit
   * leg at all, and "200" attached to the wrong noun. "post" is a plain synonym for
   * "deposit" (the note's own X-02 uses it), and it was in neither this count nor the
   * `any(text, "deposit")` checks below, so the sentence counted as ONE verb ("borrow"),
   * `multiGoalShape` never matched, `tryMultiGoalPlan` returned null, and the message
   * fell through to the single-action borrow branch — which grabbed the only number in
   * the sentence as the borrow amount, regardless of which asset it was next to. Real
   * consequence, not a wording nit: health factor dropped 2.30 → 1.83 borrowing an
   * amount nobody asked for, because the deposit leg that should have run first never
   * did.
   */
  const multiVerbCount = (
    text.match(/\b(lend|borrow|deposit|post|farm|supply|swap|invest|park|repay|redeem|withdraw)\b/gi) || []
  ).length;
  const hasActionWriteIntent =
    multiVerbCount >= 1 ||
    any(text, "park", "allocate", "add liquidity", "remove liquidity");

  // Prefer multi-leg whenever the user stacks actions — heavy production use case.
  const multiGoalShape =
    (any(text, "park", "lend", "earn", "yield") && any(text, "farm", "blend", "deploy")) ||
    (any(text, "deposit", "post") && any(text, "borrow") && any(text, "blend", "farm", "supply")) ||
    (any(text, "repay") && any(text, "deposit", "lend", "borrow", "farm")) ||
    (any(text, "swap") && any(text, "lend", "farm", "deposit", "supply", "borrow")) ||
    (any(text, "farm", "blend") && any(text, "lend", "park", "swap", "repay", "deposit")) ||
    (/\b(then|and then|after that|;)\b/i.test(text) && multiVerbCount >= 2) ||
    (/\band\b/i.test(text) &&
      multiVerbCount >= 2 &&
      any(text, "health", "hf", "liquidat", "farm", "yield", "swap", "borrow")) ||
    // Explicit multi-step language even with one verb family
    /\b(multi[- ]?step|multi[- ]?leg|in order|step by step|sequentially)\b/i.test(text);

  if (!hasActionWriteIntent || !multiGoalShape) {
    return null;
  }

  const minHf = parseMinHealthFactor(raw);
  const steps: Array<{
    kind: "read" | "write";
    op?: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    args?: Record<string, unknown>;
  }> = [];

  if (any(text, "open account", "create account", "new margin", "open margin")) {
    steps.push({ kind: "write", op: "create_account", asset: null, amount: null });
  }

  if (any(text, "repay") && multiVerbCount >= 2 && /\brepay\b/i.test(raw)) {
    const repayM = raw.match(/(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b/i);
    steps.push({
      kind: "write",
      op: "repay",
      asset: repayM?.[2]?.toUpperCase() ?? asset ?? "USDC",
      amount: repayM ? Number(repayM[1]) : null,
    });
  }

  if (any(text, "park", "lend", "earn", "yield") && !any(text, "farm blend only")) {
    const earnAsset = /\bxlm\b/i.test(raw) ? "XLM" : asset;
    const xlmAmtM = raw.match(/(\d+(?:\.\d+)?)\s*xlm\b/i);
    const earnAmtM =
      xlmAmtM ||
      raw.match(/(\d+(?:\.\d+)?)\s*(?:on\s+)?(?:earn|vanna)\b/i) ||
      (/\bxlm\b/i.test(raw) ? raw.match(/(?:lend|park|supply)\s+(\d+(?:\.\d+)?)/i) : null);
    const earnAmt = earnAmtM ? Number(earnAmtM[1]) : null;
    if (
      any(text, "park", "lend", "earn yield", "for yield", "supply to earn") ||
      (any(text, "yield") && any(text, "xlm"))
    ) {
      steps.push({
        kind: "write",
        op: "lend",
        asset: earnAsset ?? "XLM",
        amount: earnAmt != null && Number.isFinite(earnAmt) && earnAmt > 0 ? earnAmt : null,
      });
    }
  }

  if (any(text, "swap") && multiVerbCount >= 2) {
    const swapM = raw.match(
      /(\d+(?:\.\d+)?)\s*(XLM|BLUSDC|AQUSDC|SOUSDC|USDC)\b.*?\b(?:to|for|into)\s*(XLM|BLUSDC|AQUSDC|SOUSDC|USDC)\b/i,
    );
    if (swapM) {
      const tokenIn = swapM[2].toUpperCase();
      const tokenOut = swapM[3].toUpperCase();
      steps.push({
        kind: "write",
        op: "swap",
        asset: tokenIn,
        amount: Number(swapM[1]),
        args: { token_in: tokenIn, token_out: tokenOut, token_a: tokenIn, token_b: tokenOut },
      });
    }
  }

  if (
    any(text, "deposit") &&
    !any(text, "borrow") &&
    multiVerbCount >= 2 &&
    !steps.some((s) => s.op === "deposit_collateral")
  ) {
    // Prefer the amount next to the deposit verb / second asset mention
    const afterThen = raw.split(/\bthen\b/i)[1] || raw;
    const depM =
      afterThen.match(/(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b/i) ||
      raw.match(/(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b/i);
    let depAmt = depM ? Number(depM[1]) : amount;
    if (depAmt != null && minHf != null && Math.abs(depAmt - minHf) < 1e-9) depAmt = null;
    if (/\bdeposit\b/i.test(raw)) {
      steps.push({
        kind: "write",
        op: "deposit_collateral",
        asset: depM?.[2]?.toUpperCase() ?? asset ?? "XLM",
        amount: depAmt,
      });
    }
  }

  if (any(text, "farm", "blend", "deploy")) {
    /**
     * Scoped to the clause introducing the farm leg, not the whole message.
     *
     * "swap 10 XLM to AQUSDC then farm Blend with 5 BLUSDC" names AQUSDC for the swap
     * and BLUSDC for the farm leg — two different clauses, two different tokens. Scanning
     * `raw` let whichever variant matched first in the (blusdc, aqusdc, sousdc) checklist
     * win regardless of which clause it actually appeared in, so a swap destination could
     * silently become the farm leg's asset too. Same pattern the deposit branch above
     * already uses (`afterThen`): the farm leg is usually the LAST clause in these
     * prompts, so the text after the last "then" is what it should read from.
     */
    const farmClause = raw.split(/\bthen\b/i).pop() || raw;
    const farmAsset =
      (/\bblusdc\b/i.test(farmClause) && "BLUSDC") ||
      (/\baqusdc\b/i.test(farmClause) && "AQUSDC") ||
      (/\bsousdc\b/i.test(farmClause) && "SOUSDC") ||
      (asset && asset !== "XLM" ? asset : null) ||
      "BLUSDC";
    const farmAmtM = farmClause.match(/(\d+(?:\.\d+)?)\s*(?:blusdc|aqusdc|sousdc|usdc)\b/i);
    const farmAmt = farmAmtM ? Number(farmAmtM[1]) : null;
    steps.push({
      kind: "write",
      op: "deploy_to_blend",
      asset: farmAsset,
      amount: farmAmt != null && Number.isFinite(farmAmt) && farmAmt > 0 ? farmAmt : null,
      /**
       * NEVER invent leverage on a plain farm.
       *
       * This was `leverage ?? 2`, so "swap 10 XLM to BLUSDC then farm it on Blend" —
       * which asks to borrow nothing — came back as a plan to "Supply BLUSDC into Blend
       * at 2× leverage", i.e. deposit as collateral, TAKE A LOAN against it, and supply
       * the proceeds. Three transactions and a debt position, from a prompt that
       * mentioned neither. Unlevered supply is the honest reading of "farm it"; a user
       * who wants leverage says a multiple, and `findLeverage` already reads it.
       */
      leverage: leverage ?? null,
    });
  }

  if (
    any(text, "deposit", "post") &&
    any(text, "borrow") &&
    !steps.some((s) => s.op === "deploy_to_blend")
  ) {
    let depAmt = amount;
    const depM = raw.match(/(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b/i);
    if (depM) depAmt = Number(depM[1]);
    if (depAmt != null && minHf != null && Math.abs(depAmt - minHf) < 1e-9) depAmt = null;
    steps.push({
      kind: "write",
      op: "deposit_and_borrow",
      asset: findCollateralAsset(raw) ?? asset ?? "XLM",
      amount: depAmt,
      leverage: leverage ?? 2,
      args: {
        leverage: leverage ?? 2,
        // Carried in args because a plan step is replayed verbatim after approval —
        // a borrow asset dropped here cannot be recovered downstream.
        borrow_asset: findBorrowAsset(raw),
      },
    });
  }

  if (any(text, "redeem", "withdraw from earn", "unstake") && multiVerbCount >= 2) {
    const redM = raw.match(/(\d+(?:\.\d+)?)\s*(XLM|BLUSDC|AQUSDC|SOUSDC|USDC)\b/i);
    steps.unshift({
      kind: "write",
      op: "redeem",
      asset: redM?.[2]?.toUpperCase() ?? "XLM",
      amount: redM ? Number(redM[1]) : null,
    });
  }

  const deduped = steps.filter((s, i, arr) => {
    if (i === 0) return true;
    const p = arr[i - 1];
    return !(s.op === p.op && s.asset === p.asset && s.amount === p.amount);
  });

  if (deduped.length < 2) return null;

  const parts = deduped.map((s, i) => {
    const a = s.amount != null ? `${s.amount} ` : "";
    const L = s.leverage != null && s.leverage > 1 ? ` at ${s.leverage}×` : "";
    return `${i + 1}) ${s.op} ${a}${s.asset ?? ""}${L}`.trim();
  });
  return {
    kind: "plan",
    template_id: "multi_goal_strategy",
    summary: `Multi-step strategy: ${parts.join(" → ")}`,
    // "keep HF above 1.4" was read into `minHf` above only to keep it from being
    // misparsed as a deposit amount, then thrown away — approval sends back
    // `message: "approve plan"`, not this text, so runPlan's fallback parse found
    // nothing and the user's stated floor was silently dropped. Carrying it on the
    // plan is what makes it survive the round-trip.
    constraints:
      minHf != null ? { minHf, leverage: null, preferMaxYield: false, spans: [] } : undefined,
    steps: deduped.map((s) => {
      // Preserve swap token_in/out etc. — do not replace args with only leverage.
      const args: Record<string, unknown> = {
        ...((s as { args?: Record<string, unknown> }).args || {}),
      };
      if (s.leverage != null) args.leverage = s.leverage;
      return {
        kind: "write" as const,
        op: s.op,
        asset: s.asset ?? null,
        amount: s.amount ?? null,
        args: Object.keys(args).length ? args : undefined,
        leverage: s.leverage ?? null,
      };
    }),
  };
}

/**
 * Route a natural-language message to a read tool, write action, restricted op, or clarify.
 */
export function routeMessage(message: string): RoutedIntent {
  const raw = message.trim();
  if (!raw) {
    return { kind: "clarify", message: "Please type a question or action." };
  }
  // Collapsed once, here, so every exact-phrase `any(text, "...")` check below benefits —
  // "how   much    do i owe" (G-04) has the same words as "how much do i owe" but none of
  // the phrase lists match irregular whitespace, so it fell through to the generic
  // clarify_capabilities blurb instead of answering.
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  const asset = findAsset(raw);
  const amount = findAmount(raw);
  const leverage = findLeverage(raw);

  /**
   * A bare asset name with no verb at all — "SOUSDC", "XLM" — named a real token in our
   * domain but said nothing about what to do with it, so it fell through everything to
   * the generic capabilities blurb. Reported live: answering a swap's "which token did
   * you mean?" with just the token name landed here. Recognized in-domain input should
   * always ask what to do with it, never read as gibberish — the blurb is for genuinely
   * out-of-domain input only.
   */
  if (new RegExp(`^(${ASSET_ALT})$`, "i").test(text)) {
    const sym = text.toUpperCase();
    return {
      kind: "clarify",
      message:
        `What do you want to do with ${sym}? e.g. “lend 10 ${sym}”, “deposit 10 ${sym} as collateral”, ` +
        `“swap 10 ${sym} to XLM”, “farm Blend with 10 ${sym}”.`,
      template_id: "bare_asset_clarify",
    };
  }

  // ── restricted ──────────────────────────────────────────────────────────
  /**
   * "What is Collateral Left Before Liquidation of my margin account?" was refused
   * outright as a restricted keeper action — it contains "liquidation of", which the
   * old bare-substring check could not tell apart from an actual command. A genuine
   * liquidate instruction ("liquidate my account", "liquidate G...") does not open
   * with a question word; a question about the user's OWN liquidation threshold
   * always does. This is a read the margin snapshot already answers
   * (`collateralLeftBeforeLiquidation`), not a keeper action to refuse.
   */
  const asksAboutOwnLiquidationThreshold =
    /\b(what|how much|how many|show me)\b[\s\S]{0,40}\bliquidat/i.test(text) ||
    /\b(before|until|left before|distance to|buffer before)\b[\s\S]{0,10}\bliquidat/i.test(text);
  if (!asksAboutOwnLiquidationThreshold && any(text, "liquidate", "liquidation of")) {
    return {
      kind: "restricted",
      template_id: "liquidate",
      reason: "Liquidation of other accounts is a restricted keeper/protocol action — the copilot won't run it.",
    };
  }

  /**
   * "I have to Faucet AQUSDC" (also matches the "Fucet" typo, a plausible dropped-letter
   * slip) fell through to the generic capabilities blurb — testnet funding is a client-side
   * action (the "Faucet" button in the top nav), not an MCP tool, so no read/write branch
   * below ever recognised the word at all.
   */
  if (/\bfa?ucet\b/i.test(text)) {
    return {
      kind: "clarify",
      message:
        "Testnet funding is the Faucet button in the top nav, next to your wallet address — " +
        "it isn't something I can trigger from here. Click it to fund your wallet with testnet XLM.",
      template_id: "faucet_guidance",
    };
  }

  // ── G-wallet create/connect (client-side Privy/Freighter — NOT MCP) ──────
  // Must run before multi-goal / create_account so "create a wallet" never
  // becomes open-margin-account (C-address). MCP has no create_wallet tool.
  if (
    any(
      text,
      "create wallet",
      "create a wallet",
      "create vanna wallet",
      // Bare "vanna wallet" so "create a vanna wallet" matches too — the phrases here
      // are substrings, so an article between the verb and the noun defeated them.
      // "what is a vanna wallet?" never reaches here: it is a concept question.
      "vanna wallet",
      "create my wallet",
      "create g-wallet",
      "create g wallet",
      "new vanna wallet",
      "new g-wallet",
      "new wallet",
      "make a wallet",
      "make me a wallet",
      "set up a wallet",
      "setup a wallet",
      "setup wallet",
      "get a wallet",
      "get me a wallet",
    ) &&
    // These phrases are substring matches, so "new wallet" also fired on
    // "what's in my new wallet?" — a balance question that opened the create dialog.
    // Exclude possessive/interrogative framings rather than dropping the phrase, so a
    // plain "create a new wallet" still works.
    !any(text, "smart account", "margin account", "c-account", "c account") &&
    !any(text, "my new wallet", "what's in", "whats in", "what is in", "how much is in")
  ) {
    return {
      kind: "client",
      tool: "openConnectWallet",
      args: { prefer: "privy", intent: "create" },
      template_id: "create_g_wallet",
      message:
        "Opening Create Vanna wallet…\n\n" +
        "1. Choose Create Vanna wallet (email or Google) — Privy creates an embedded Stellar G-wallet for you.\n" +
        "2. Or connect Freighter if you already have an extension wallet.\n\n" +
        "Keys stay in your browser (Privy/Freighter). MCP never creates G-wallets — only opens margin C-accounts after you connect.",
    };
  }

  if (
    any(
      text,
      "connect wallet",
      "connect my wallet",
      "connect a wallet",
      "link wallet",
      "link my wallet",
    ) &&
    !any(text, "smart account", "margin account")
  ) {
    return {
      kind: "client",
      tool: "openConnectWallet",
      args: { prefer: "modal", intent: "connect" },
      template_id: "connect_g_wallet",
      message:
        "Opening wallet connect…\n\n" +
        "Pick Freighter (existing extension) or Create Vanna wallet (email/Google via Privy).",
    };
  }

  // Multi-goal BEFORE single-op writes (repay/deposit/lend/swap alone)
  const multiGoal = tryMultiGoalPlan(raw, text, asset, amount, leverage);
  if (multiGoal) return multiGoal;

  // ── writes (checked before reads that share words like "borrow") ────────
  // C-account / margin smart account only — not G-wallet create (see client path above).
  if (
    any(
      text,
      "create smart account",
      "create margin account",
      "open a margin account",
      "open margin account",
      "create my smart account",
      "open a smart account",
      "open margin c-account",
      "open a c-account",
    )
  ) {
    return {
      kind: "write",
      op: "create_account",
      template_id: "create_account",
      requires_account: false,
      requires_amount: false,
    };
  }

  /**
   * A token that does not exist on this network is not a sizing question.
   *
   * This gate used to sit below the LP / swap / Blend branches, so it only ever saw the
   * writes that had already failed to match one of them. "Add liquidity to the XLM/BTC
   * pool" returned from the LP branch three checks earlier and was answered with "how
   * much of each token?" — inviting the user to size a BTC leg that can never execute.
   * Ahead of every write branch it cannot be reached around, and no supported asset is
   * affected because the guard only fires when an unsupported ticker is actually named.
   *
   * "what's the XLM/BTC pool" named no write verb at all — a plain read-style question —
   * so it missed every word above and fell through to the generic capabilities blurb
   * instead of this same specific refusal. "pool"/"price"/"rate"/"apy"/"stats"/"worth"
   * cover that shape without widening the gate to fire on a bad ticker mentioned only
   * in passing.
   */
  {
    const bad = findUnsupportedAsset(raw);
    if (
      bad &&
      any(
        text,
        "lend",
        "supply",
        "earn",
        "deposit",
        "borrow",
        "repay",
        "swap",
        "farm",
        "add",
        "provide",
        "remove",
        "park",
        "invest",
        "deploy",
        "redeem",
        "withdraw",
        "to earn",
        "liquidity",
        "pool",
        "price",
        "rate",
        "apy",
        "apr",
        "stats",
        "worth",
      )
    ) {
      return {
        kind: "clarify",
        message:
          `“${bad}” is not a Vanna asset on this testnet. Supported: XLM, BLUSDC, AQUSDC, SOUSDC. ` +
          `Example: “lend 10 XLM” or “supply 25 BLUSDC”.`,
        template_id: "unsupported_asset",
      };
    }
  }

  // DEX swap (margin account free balance) — website Trade: XLM ↔ USDC via Aquarius or Soroswap.
  // “swap 10 XLM to USDC via aquarius” / “swap 5 USDC to XLM on soroswap”
  const swapMatch = raw.match(
    /\bswap\s+(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA)\b(?:\s*(?:to|for|into|->|→)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA))?/i,
  );
  /**
   * A SHARE is a size, so it must open the swap branch too.
   *
   * Both entry conditions required a number — the regex wants digits right after "swap",
   * and the fallback wants `amount != null` — so "swap half my XLM to USDC" matched
   * neither and fell through to the generic clarify, even though Trade/Spot offers exactly
   * that as its 25 / 50 / 75 / Max meter.
   */
  const swapShare = findBalanceFraction(raw);
  /** "X to Y" when no amount preceded it — the sized regex above cannot see this pair. */
  const swapPair = raw.match(
    /\b(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA)\b\s*(?:to|for|into|->|→)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA)\b/i,
  );
  /**
   * "Now Can you Perform Swap From XLM to SoUSDC in Soroswap" named both tokens and a venue
   * but no size at all, so it matched neither `swapMatch` (needs a number right after
   * "swap") nor the old fallback below (which also required `amount != null ||
   * swapShare != null`) and fell through everything to the generic capabilities blurb —
   * a real swap instruction answered as though it were gibberish. The write branch below
   * already handles a null amount gracefully (`requires_amount: true`, same as every other
   * op in this router), so naming the pair is enough to recognise the instruction; the size
   * is asked for afterward, not required up front to know what was meant.
   */
  if (
    swapMatch ||
    (any(text, "swap") &&
      !any(text, "liquidity") &&
      !any(text, "can i swap", "is swap", "swap available", "swap fee", "swap rate") &&
      (asset || swapPair))
  ) {
    const amountIn = swapMatch ? Number(swapMatch[1]) : amount;
    const tokenIn = (swapMatch?.[2] || swapPair?.[1] || asset || "XLM").toUpperCase();
    const tokenOut = (
      swapMatch?.[3] ||
      swapPair?.[2] ||
      (tokenIn === "XLM" ? "USDC" : "XLM")
    ).toUpperCase();
    /**
     * Null when the user named no venue — do NOT default it here.
     *
     * Defaulting to "aquarius" at the router made the venue indistinguishable from one the
     * user actually asked for, so "swap 10 XLM to SOUSDC" looked like an explicit request
     * for SOUSDC *on Aquarius* and was refused as contradictory. The executor picks the
     * venue that matches a named token, and falls back to Aquarius only when nothing
     * constrains it.
     */
    const venue = any(text, "soroswap", "soro swap", "on soroswap", "via soroswap")
      ? "soroswap"
      : any(text, "aquarius", "on aquarius", "via aquarius")
        ? "aquarius"
        : null;

    /**
     * "swap 10 XLM to USDC" EXECUTED a real swap. No variant was ever asked for.
     *
     * `usdcOps` (in handle.ts) is the generic bare-USDC gate every other write goes
     * through, and swap is deliberately excluded from it — on purpose, per the comment
     * there, so a swap that already names a concrete variant (AQUSDC/BLUSDC/SOUSDC) is
     * never asked a redundant question. But that gate only ever looks at `action.asset`
     * and `action.borrow_asset`; a swap's destination lives in `token_b`, a field the
     * shared gate has never seen. So a swap landing on bare "USDC" here — because the
     * user typed it, or because the tokenIn/tokenOut fallback above chose it — passed
     * straight through with no ambiguity check at all and settled on-chain.
     *
     * Handled here rather than by teaching the shared gate a third field: `token_b` only
     * exists on this one action shape, and this is the one place that already knows
     * whether it is genuinely unresolved. Returned as `kind: "clarify"` — the same router
     * result the unsupported-asset case above uses — so nothing downstream builds a
     * transaction for a token nobody named.
     */
    if (tokenOut === "USDC") {
      return {
        kind: "clarify",
        message: usdcVariantClarifyMessage("the swap"),
        template_id: "clarify_usdc_variant",
      };
    }

    return {
      kind: "write",
      op: "swap",
      template_id: "swap",
      asset: tokenIn,
      amount: amountIn != null && Number.isFinite(amountIn) ? amountIn : null,
      token_a: tokenIn,
      token_b: tokenOut,
      amount_a: amountIn != null && Number.isFinite(amountIn) ? amountIn : null,
      // "swap half my XLM to USDC" — the Trade/Spot page's 25/50/75/Max meter as language.
      // Sized against the smart account's free balance, which is what that page reads.
      fraction: amountIn == null ? swapShare : null,
      venue,
      requires_account: true,
      requires_amount: amountIn == null && swapShare == null,
    };
  }

  // Soft NL: “earn me yield from farm / invest for max profit” — handled in runWrite ranking.
  if (isMaxYieldInvestIntent(text) || any(text, "earn me something", "earn me yield from farm", "invest in market pools")) {
    const minHf = parseMinHealthFactor(raw);
    return {
      kind: "write",
      op: "lend",
      template_id: "invest_max_yield",
      asset: asset ?? "USDC",
      amount,
      requires_account: false,
      requires_amount: true,
      prefer_max_yield: true,
      min_hf: minHf,
    };
  }

  // Farm Blend with leverage MUST win over margin deposit_and_borrow.
  // Old guard `(leverage && blend)` routed "Farm Blend at 3x with 10 BLUSDC"
  // into deposit_and_borrow, which then asked for USDC chips or stuck after deposit.
  // "5x Blend on 10 BLUSDC" names no verb at all — the leverage multiple plus "Blend"
  // is the only signal. Without this clause it fell through everything to
  // clarify_capabilities, silently dropping a valid leverage request.
  /**
   * "Can You Remove 50 BLUSDC fom Farm's Blend Pool" matched `isBlendFarmWrite` (the
   * literal substring "blend pool") AND the supply verb allowlist below (the possessive
   * "farm's" contains "farm" as a whole word, since `any()`'s boundary treats the
   * apostrophe as a word edge) — with no check anywhere for which DIRECTION the money was
   * supposed to move, it staged "Supply 50 BLUSDC to Blend" for a message asking to take
   * money OUT. A removal verb here always means withdraw, whatever else the sentence
   * shares with a supply — checked first so it can never fall through to the supply route.
   * Declared before `isBlendFarmWrite` so its own venue detection can recognise a bare
   * "withdraw ... Blend" (no "to"/"into"/"on" preposition a supply would use) too —
   * "withdraw 20 XLM from Blend" named no supply verb at all and matched neither the
   * phrase list nor the supply-verb alternative below it, so it fell through everything.
   */
  const blendRemoveVerb = /\b(remove|withdraw|take out|takeout|pull out|unwind|redeem)\b/i.test(text);
  const isBlendFarmWrite =
    any(
      text,
      "farm blend",
      "blend at",
      "to blend",
      "into blend",
      "on blend",
      "from blend",
      "blend reserve",
      "blend pool",
    ) ||
    (any(text, "blend") &&
      (any(text, "farm", "deploy", "supply", "deposit") || blendRemoveVerb) &&
      !any(text, "position", "stats", "apy")) ||
    (any(text, "blend") && leverage != null && leverage > 1 && !any(text, "position", "stats", "apy"));
  if (isBlendFarmWrite && blendRemoveVerb && !any(text, "position", "stats", "apy", "btoken", "which reserve")) {
    return {
      kind: "write",
      op: "withdraw_from_blend",
      template_id: "withdraw_from_blend",
      asset: asset ?? "XLM",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }
  if (
    isBlendFarmWrite &&
    !blendRemoveVerb &&
    (any(text, "supply", "deposit", "deploy", "farm", "leverage", "lever") || (leverage != null && leverage > 1)) &&
    !any(text, "supply apy", "borrow apy", "position", "btoken", "pays more", "which reserve")
  ) {
    return {
      kind: "write",
      op: "deploy_to_blend",
      template_id: "deploy_to_blend",
      asset: asset ?? "XLM",
      amount,
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
      leverage: leverage ?? null,
    };
  }

  // Aquarius / Soroswap LP — add liquidity (must beat bare deposit / lend).
  const dual = parseDualAmounts(raw);
  if (
    any(text, "add liquidity", "provide liquidity", "add lp") ||
    (any(text, "add") && any(text, "aquarius", "soroswap", "to aquarius", "lp")) ||
    (any(text, "add") && dual && any(text, "xlm") && any(text, "usdc", "blusdc", "aqusdc", "sousdc"))
  ) {
    const token_a = dual?.token_a ?? "XLM";
    const token_b = dual?.token_b ?? (asset && asset !== "XLM" ? asset : "BLUSDC");
    return {
      kind: "write",
      op: "add_liquidity",
      template_id: "add_liquidity",
      asset: token_b,
      amount: dual?.amount_a ?? amount,
      token_a,
      token_b,
      amount_a: dual?.amount_a ?? amount,
      amount_b: dual?.amount_b ?? null,
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
    };
  }

  /**
   * Remove LP (half or explicit amount).
   *
   * "remove 50% of my LP" reached Vertex instead of this branch — non-deterministically,
   * since the SAME exact message answered differently on different turns ("which pool?"
   * once, the generic capability blurb another time). The outer gate only recognised the
   * word "half" as a fraction phrase; a few lines down, `half` itself already checks for
   * "50%"/"50 %" too — the outer gate and the value it gates were never kept in sync, so
   * the more common phrasing ("50%") never got past the gate to reach the check that
   * already understood it.
   */
  if (
    any(text, "remove liquidity", "remove my liquidity", "withdraw liquidity", "withdraw lp") ||
    (any(text, "remove half", "remove 50%", "remove 50 %") &&
      any(text, "liquidity", "lp", "xlm/usdc", "pool")) ||
    /**
     * "Can you remove 10 LP from farm Aquarius XLM and USDC Pool" named an amount, not
     * "half"/"50%", and its verb+noun were never adjacent ("remove liquidity") — so this
     * gate missed it entirely and it fell through everything to an LLM free-generating a
     * confused "collateral or check your position?" clarify with no deterministic route
     * to anchor it. `add_liquidity`'s own gate already accepts a bare `"add" + venue/"lp"`
     * shape for exactly this reason; this mirrors it for the removal verb.
     */
    (any(text, "remove", "withdraw", "take out", "pull out") &&
      any(text, "lp", "liquidity", "aquarius", "soroswap") &&
      !any(text, "collateral"))
  ) {
    const half = any(text, "half", "50%", "50 %");
    /**
     * Pair default XLM / USDC family from message. A named venue outranks a bare "USDC"
     * — "remove 10 LP from Aquarius XLM and USDC Pool" says "USDC", not "AQUSDC", but
     * naming the venue explicitly already answers which USDC it means, same as `farm
     * Blend`/`add_liquidity`'s own venue-aware asset resolution elsewhere in this file.
     */
    const token_b =
      (/\baqusdc\b/i.test(raw) && "AQUSDC") ||
      (/\bsousdc\b/i.test(raw) && "SOUSDC") ||
      (/\bblusdc\b/i.test(raw) && "BLUSDC") ||
      (any(text, "aquarius") && "AQUSDC") ||
      (any(text, "soroswap") && "SOUSDC") ||
      (/\busdc\b/i.test(raw) && "USDC") ||
      "USDC";
    return {
      kind: "write",
      op: "remove_liquidity",
      template_id: "remove_liquidity",
      asset: token_b,
      amount: half ? null : amount,
      token_a: "XLM",
      token_b,
      fraction: half ? 0.5 : null,
      requires_account: true,
      requires_amount: !half,
    };
  }

  // Margin multi-leg only — never steal Blend farm or Aquarius LP.
  if (
    ((has(text, "deposit") && any(text, "borrow")) ||
      any(text, "deposit and borrow", "deposit + borrow", "lever up", "leveraged position") ||
      (leverage != null &&
        leverage > 1 &&
        // "open an 11x position on BLUSDC" names no "leverage"/"lever" word at all — just
        // a multiple plus "position". Without this it fell through to asksAboutHoldings
        // below (word "position" alone matches that), answering with a positions summary
        // instead of ever reaching the leverage-cap refusal in handle.ts.
        (any(text, "leverage", "lever") || any(text, "position")) &&
        !any(text, "blend", "farm", "aquarius", "lp"))) &&
    !any(text, "blend", "farm blend", "aquarius")
  ) {
    // Two slots, read independently. `asset ?? "USDC"` used to answer both, which
    // both lost a stated borrow asset AND defaulted it to the one symbol that then
    // demanded a variant chip.
    return {
      kind: "write",
      op: "deposit_and_borrow",
      template_id: "deposit_and_borrow",
      asset: findCollateralAsset(raw) ?? asset ?? "USDC",
      amount,
      borrow_asset: findBorrowAsset(raw),
      borrow_amount: leverage != null && leverage > 1 ? null : findBorrowAmount(raw),
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
      leverage,
    };
  }

  if (any(text, "repay", "pay back", "payback", "clear my loan", "pay off")) {
    // "all" / "100%" / "half" are sizes, not missing amounts — same rungs as Margin's
    // 10/25/50/100% chips. A bare "repay my XLM" keeps amount null so the executor
    // can offer those chips instead of a blank "how much?".
    const fraction = amount == null ? findAmountFraction(raw) : null;
    return {
      kind: "write",
      op: "repay",
      template_id: "repay",
      // Prefer the named debt asset (XLM). Do not default to USDC when they named one —
      // that is what turned "repay all my XLM" into a confused USDC path.
      asset: asset ?? null,
      amount,
      fraction,
      requires_account: true,
      requires_amount: amount == null && fraction == null,
    };
  }

  /**
   * "is a 500 BLUSDC borrow safe" EXECUTED a real borrow.
   *
   * That sentence contains the word "borrow" and matched none of the exclusions below,
   * so it fell into the write branch, built op:"borrow" asset:"BLUSDC" amount:500, and —
   * with auto-sign on and this being a single-leg write — signed and submitted on testnet
   * from what was a question, not an instruction. This is the one class of bug worse than
   * a wrong answer: real state changed because a question was misread as a command.
   *
   * A fixed phrase list cannot cover this — "is X safe", "would X be safe", "is it safe to
   * X" all vary the words around "safe". A regex on the shape of the sentence is what these
   * three have in common: the word "safe" sitting near a question opener ("is"/"would"/
   * "will"/"should"), not a fixed string.
   */
  const asksIfSafe = /\b(is|would|will|should)\b[\s\S]{0,60}\bsafe\b/i.test(text);
  if (asksIfSafe && any(text, "borrow")) {
    return {
      kind: "read",
      tool: "vanna_can_borrow",
      args: {
        symbol: asset ?? "USDC",
        ...(amount != null ? { amount: String(amount) } : {}),
      },
      requires_account: true,
      template_id: "query_can_borrow",
    };
  }

  // "available to borrow" / "liquidity … to borrow" are pool-liquidity READS. Without
  // these exclusions the bare "borrow" match turned "how much liquidity is available to
  // borrow from the XLM pool?" into a borrow write that then asked "how much do you want
  // to borrow?" — a question answered with a question.
  if (
    any(text, "borrow") &&
    !asksIfSafe &&
    !any(
      text,
      "can i borrow",
      "how much can i borrow",
      "borrow apr",
      // Reported live: "What is Borrow APY of XLM Lending Pool?" matched none of these
      // (only "borrow apr" was excluded, not "borrow apy") and fell into the borrow
      // write branch, which then asked "how much do you want to borrow?" — a market-data
      // question about the pool's rate, answered as if it were an instruction to borrow.
      "borrow apy",
      "borrow rate",
      "available to borrow",
      "left to borrow",
      "liquidity",
      // Capacity questions, not instructions. "How much borrow power do I have" is
      // answered by the credit read below; without these it became a borrow write that
      // replied "how much do you want to borrow?" — a question answered with a question.
      "borrow power",
      "buying power",
      "credit",
    )
  ) {
    /**
     * "borrow the max I can safely" names no asset word at all, yet `asset ?? "USDC"`
     * below turned that into a literal USDC borrow — which then hit the bare-USDC
     * ambiguity gate in handle.ts and asked which USDC variant *before* ever asking
     * a size, since that gate runs on the manufactured default with no way to tell
     * it apart from a genuine "USDC". When nothing was named, ask for both amount
     * and asset together instead of inventing an asset the user never said.
     */
    if (asset == null) {
      return {
        kind: "clarify",
        message:
          amount != null
            ? `Borrow ${amount} of which asset? e.g. "borrow ${amount} XLM" or "borrow ${amount} BLUSDC".`
            : `How much do you want to borrow, and in which asset? e.g. "borrow 50 XLM" or "borrow 20 BLUSDC".`,
        template_id: "borrow_amount_and_asset",
      };
    }
    return {
      kind: "write",
      op: "borrow",
      template_id: "borrow",
      asset: asset ?? "USDC",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }

  // "as collateral" on its own is not an instruction — "what can I use as collateral?"
  // is asking for the accepted-collateral list, and it was becoming a deposit write
  // that then asked which USDC variant to deposit. Questions are excluded so they fall
  // through to the collateral-config read below.
  const asksWhichAssets = any(
    text,
    "what can",
    "which can",
    "what assets",
    "which assets",
    "what tokens",
    "which tokens",
    "allowed collateral",
    "collateral config",
    "accepted",
  );
  if (
    !asksWhichAssets &&
    ((any(text, "deposit") && any(text, "collateral")) ||
      any(text, "add collateral", "post collateral", "as collateral"))
  ) {
    const fraction = amount == null ? findBalanceFraction(raw) : null;
    return {
      kind: "write",
      op: "deposit_collateral",
      template_id: "deposit_collateral",
      asset: asset ?? "USDC",
      amount,
      fraction,
      requires_account: true,
      requires_amount: amount == null && fraction == null,
    };
  }

  /**
   * "can I withdraw my collateral" executed a write. Unlike the borrow branch a few
   * hundred lines up, this one had no "can i …" exclusion at all, so a bare capability
   * question with no amount fell straight into `op: "withdraw_collateral"`, hit the
   * bare-USDC ambiguity gate meant for an actual withdrawal, and asked the user to pick a
   * USDC variant for an action they never asked to take. There IS a read for this
   * (`vanna_can_borrow`'s sibling, matched a little further down at "can i withdraw" /
   * "can i pull out"), but it can never be reached while this branch matches first.
   *
   * "Transfer Collateral Margin to Wallet 20 XLM" is the same instruction as "withdraw
   * 20 XLM collateral" — moving margin collateral back to the wallet is what withdrawing
   * it means — but named none of "withdraw"/"take out"/"pull", so it fell through
   * everything to the generic capabilities blurb. "transfer"/"move"/"send" are everyday
   * synonyms for the same verb here, not a new op.
   */
  if (
    !any(text, "can i withdraw", "can i pull out", "withdraw allowed") &&
    ((any(text, "withdraw", "transfer", "move", "send") && any(text, "collateral")) ||
      any(text, "take out collateral", "pull collateral"))
  ) {
    const fraction = amount == null ? findBalanceFraction(raw) : null;
    return {
      kind: "write",
      op: "withdraw_collateral",
      template_id: "withdraw_collateral",
      asset: asset ?? "USDC",
      amount,
      fraction,
      requires_account: true,
      requires_amount: amount == null && fraction == null,
    };
  }

  // Farm — supply / deploy / "farm Blend at Nx …".
  // Write needs a real verb; rate questions stay reads.
  // "farm Blend at 3x with 10 BLUSDC" has no "to blend" but is still a write.
  const blendVenueNamed = any(
    text,
    "to blend",
    "into blend",
    "on blend",
    "from blend",
    "blend reserve",
    "blend pool",
    "farm blend",
    "blend at",
  );
  const blendRateRead = any(
    text,
    "supply apy",
    "supply apr",
    "borrow apy",
    "borrow apr",
    "stats",
    "utilization",
    "pays more",
    "pays better",
    "which reserve",
    "which blend",
    "compare",
    "position",
    "btoken",
    "b-token",
    "how much do i",
    "how much have i",
    "better than",
  );
  const blendWriteVerb = any(
    text,
    "supply",
    "deposit",
    "deploy",
    "farm",
    "add liquidity",
    "move my",
    "leverage",
    "lever",
  );
  if (blendVenueNamed && blendRemoveVerb && !blendRateRead) {
    return {
      kind: "write",
      op: "withdraw_from_blend",
      template_id: "withdraw_from_blend",
      asset: asset ?? "XLM",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }
  if (
    (blendVenueNamed || (any(text, "blend") && leverage != null && leverage > 1)) &&
    blendWriteVerb &&
    !blendRateRead &&
    // Same removal-verb carve-out as the earlier Blend-write block — a second gate here
    // since this block is reachable independently for phrasing the first one misses.
    !blendRemoveVerb
  ) {
    return {
      kind: "write",
      op: "deploy_to_blend",
      template_id: "deploy_to_blend",
      asset: asset ?? "XLM",
      amount,
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
      leverage: leverage ?? null,
    };
  }

  // Align with zip brain (direct.py): bare "deposit" → margin collateral.
  // Earn supply uses lend/supply/earn/pool phrasing (incl. "earn yield on my XLM").
  // Do NOT match "supply APY" / "supply APR" — those are pool-stat reads.
  // Do NOT steal Blend/Farm writes ("supply 10 XLM to Blend").
  const isSupplyApyRead = any(text, "supply apy", "supply apr", "borrow apy", "borrow apr");
  const isBlendOrFarmVenue = any(text, "blend", "farm", "aquarius", "soroswap", "bToken", "btoken", "lp ");
  // Word-boundary "lend" so "lending pool" (a READ) does not become a write.
  const hasLendVerb = /\blend\b/.test(text);
  const wantsHighestPool =
    /highest[\s-]*yielding|best[\s-]*yielding|highest[\s-]*apy|best[\s-]*apy|max(?:imum)?\s*yield|best\s*return/i.test(
      text,
    ) && any(text, "supply", "lend", "deposit", "invest", "put", "earn", "farm");
  /**
   * "what is my total supply in earn section" executed a lend write asking which
   * USDC variant, when it was a plain question about the user's own position.
   * The old exclusion list matched fixed phrases ("my supply", "total supplied")
   * as exact substrings, so an adjective sitting between the words — "my TOTAL
   * supply" — broke the match and the message fell straight into isLendWrite.
   * A shape-based regex ("what"/"how much" near "supply", or "my" near "supply")
   * survives whatever sits in between.
   */
  const asksAboutOwnSupply =
    /\b(what|how much)\b[\s\S]{0,30}\bsupply\b|\bmy\b[\s\S]{0,20}\bsupply\b|\bsupplied\b/i.test(
      text,
    );
  const isLendWrite =
    !isSupplyApyRead &&
    !isBlendOrFarmVenue &&
    (hasLendVerb ||
      any(text, "earn yield", "yield on my", "want to earn", "earn me") ||
      wantsHighestPool ||
      (any(text, "supply") && !asksAboutOwnSupply) ||
      (any(text, "deposit") &&
        any(text, "pool", "earn", "vault", "to the pool", "into the pool", "to earn")));
  if (isLendWrite) {
    const minHf = parseMinHealthFactor(raw);
    // "supply 50% of the XLM in my wallet" states a size. Carried as a fraction and
    // sized off the live wallet balance in handle.ts — same rungs as the Earn form.
    const fraction = amount == null ? findBalanceFraction(raw) : null;
    return {
      kind: "write",
      op: "lend",
      template_id: wantsHighestPool || isMaxYieldInvestIntent(text) ? "lend_highest" : "lend",
      asset: asset ?? "USDC",
      amount,
      fraction,
      requires_account: false,
      requires_amount: amount == null && fraction == null,
      prefer_max_yield: wantsHighestPool || isMaxYieldInvestIntent(text) || null,
      min_hf: minHf,
    };
  }

  // Bare "deposit 5 XLM" (no "collateral" word) still means deposit_collateral in the
  // production brain router — same as zip direct.py `_ROUTES`.
  if (any(text, "deposit")) {
    const fraction = amount == null ? findBalanceFraction(raw) : null;
    return {
      kind: "write",
      op: "deposit_collateral",
      template_id: "deposit_collateral",
      asset: asset ?? "XLM",
      amount,
      fraction,
      requires_account: true,
      requires_amount: amount == null && fraction == null,
    };
  }

  if (
    any(text, "redeem") ||
    (any(text, "withdraw") && any(text, "pool", "supply", "earn", "from the pool", "my supply"))
  ) {
    return {
      kind: "write",
      op: "redeem",
      template_id: "redeem",
      asset: asset ?? "USDC",
      amount,
      requires_account: false,
      requires_amount: true,
    };
  }

  // ── reads ───────────────────────────────────────────────────────────────
  // Health as a *constraint* ("keep HF above 1.4") with a real write intent must
  // not steal multi-goal prompts into a pure health read.
  const hasActionWriteIntent =
    any(
      text,
      "lend",
      "borrow",
      "deposit",
      "repay",
      "swap",
      "farm",
      "deploy",
      "supply",
      "invest",
      "park",
      "allocate",
      "redeem",
      "withdraw",
      "add liquidity",
      "remove liquidity",
    ) ||
    /\b(then|and)\s+(also\s+)?(farm|lend|borrow|deposit|supply|swap|invest)\b/i.test(text);

  // "What am I holding?" — the single most common question this surface gets, and the
  // one that had no deterministic route at all. It reached an answer only through
  // Vertex, so on any machine whose `gcloud auth login` had lapsed it fell all the way
  // through to the closing `clarify` and replied with the capability blurb — which is
  // exactly the "hardcoded response" that got reported.
  //
  // Matched with a regex over the whole message rather than a keyword list because the
  // phrasing is never fixed: "tell me all my current open position" and "tell me my all
  // current open position" are the same question, and an `any()` phrase list gets one of
  // them and misses the other. Position/holding words are checked independently of the
  // possessive so word order cannot matter.
  const asksAboutHoldings =
    /\b(position|positions|portfolio|holdings?|exposure)\b/i.test(text) ||
    /\bwhat\s+(?:am\s+i|do\s+i)\s+(?:hold|have|own|farm(?:ing)?)\b/i.test(text) ||
    // "what's in my earn account" broke the old exact-adjacency version of this
    // pattern ("my" then immediately "account") the same way "my total supply"
    // broke the exclusion list below — "earn" sits in between. Widened to a span.
    /\bwhat'?s\s+in\s+my\b[\s\S]{0,20}\b(?:account|portfolio|wallet)\b/i.test(text) ||
    // "what is my total supply in earn section" / "how much have I supplied" name
    // no "position"/"holdings" word at all, so this branch never saw them — they
    // fell through everything to the generic capabilities blurb (or, before the
    // isLendWrite fix above, into a live lend write). Same question, phrased with
    // "supply" instead of "position". Excludes `isSupplyApyRead` — "what's the
    // supply APY on XLM" is a pool-stat question, not a "what do I hold" one, and
    // matches the same "what ... supply" shape.
    (asksAboutOwnSupply && !isSupplyApyRead) ||
    /**
     * "how much do I have in farm", "show me my earn balance", "what's my total
     * in farm", "how much am I earning in the earn section" — none of these name
     * "position"/"holdings"/"supply" at all, just some other everyday word for
     * "how much is there". A fixed phrase list is whack-a-mole against this — the
     * shape is a personal-quantity question word, a first-person marker, a
     * quantity noun, and a named venue, in any order, with anything in between.
     */
    (/\b(how much|what'?s|show me)\b/i.test(text) &&
      /\b(my|i)\b/i.test(text) &&
      /\b(balance|total|earned|earning|have)\b/i.test(text) &&
      any(text, "earn", "farm", "blend", "aquarius", "soroswap")) ||
    // "what's my net worth" / "what's my net value" / "what is my net asset value" name
    // no "position"/"holdings"/"supply" word either — same underlying question (equity),
    // a third everyday phrasing for it.
    /\bnet\s+(worth|value|assets?|asset\s+value)\b/i.test(text) ||
    // "What is my TVL in Farm Section" — names none of position/holdings/supply/balance
    // either. TVL is the Farm page's own label for this exact figure (`lib/constants/
    // farm/index.ts`'s "Your Deposit TVL" stat, computed from the same Blend + Soroswap-LP
    // + Aquarius-LP gross total `farmPositionAnswer` already answers with) — a fourth
    // everyday name for "how much is there", not a new question.
    /\btvl\b|\btotal\s+value\s+locked\b/i.test(text) ||
    // "tell me my margin account details" names none of "position"/"holdings"/"supply"
    // either and fell through everything to the generic capabilities blurb — the whole
    // point of the ask ("account details") is the full picture this fan-out already
    // answers (HF, collateral, debt, net value, per-asset breakdown), not one figure.
    /\b(margin\s+)?account\s+details?\b/i.test(text);
  /**
   * "Close my position" is an instruction, not a question, and must not be answered with a
   * summary as though it had been carried out. Every unambiguous write phrasing has already
   * returned above this point, so this only has to catch the verbs that act on a position
   * *as a whole* — the ones no earlier branch looks for. Not `hasActionWriteIntent`: that
   * list contains "farm", which would swallow "what am I farming".
   */
  const actsOnPosition = /\b(close|exit|unwind|reduce|increase|hedge|liquidate|rebalance)\b/i.test(
    text,
  );

  /**
   * Named single-figure margin questions ask for ONE specific number, not the whole
   * positions card — "if a user wants to see the gross amount of anything it should
   * return only that, not extra info" (reported live, alongside the fixes below).
   *
   * "Net Available Collateral & Net amount Borrowed of my margin account" matched
   * neither the debt question above (its word-distance window is too short for a
   * second clause) nor the "net worth/value" pattern (the word after "net" here is
   * "available"/"amount", not "worth"/"value") and fell all the way to the generic
   * capabilities blurb. Each figure is checked independently against the whole
   * message — not proximity to one leading question word — so an "X & Y" compound
   * question matches every figure it names, in whichever order.
   *
   * "Collateral Left Before Liquidation" reuses the same threshold check the
   * restricted-liquidate gate above already computed, so a question phrased either
   * way ("collateral left before liquidation" or "how much before liquidation")
   * resolves to the same figure instead of one of them going unanswered.
   */
  if (!hasActionWriteIntent && !actsOnPosition) {
    const namedMarginFigures: string[] = [];
    if (
      asksAboutOwnLiquidationThreshold ||
      /\bcollateral\s+left\s+before\s+liquidation\b/i.test(text) ||
      /\b(liquidation\s+buffer|buffer\s+before\s+liquidation|distance\s+to\s+liquidation)\b/i.test(text)
    ) {
      namedMarginFigures.push("collateralLeftBeforeLiquidation");
    }
    if (/\bnet\s+available\s+collateral\b/i.test(text)) {
      namedMarginFigures.push("netAvailableCollateral");
    }
    if (/\b(gross\s+collateral|total\s+collateral(?:\s+value)?)\b/i.test(text)) {
      namedMarginFigures.push("grossCollateralValue");
    }
    if (/\bnet\s+(?:amount\s+)?borrowed\b/i.test(text) || /\btotal\s+(?:amount\s+)?borrowed\b/i.test(text)) {
      namedMarginFigures.push("totalBorrowedValue");
    }
    if (namedMarginFigures.length > 0) {
      return {
        kind: "read",
        // Nominal tool — runRead resolves the real margin snapshot for query_margin_figure
        // and reads only the requested field(s) off it, same as query_all_positions does.
        tool: "vanna_get_account_health",
        args: { figures: namedMarginFigures },
        requires_account: true,
        template_id: "query_margin_figure",
      };
    }
  }

  /**
   * "My Blend position" names one venue and already has a route below that answers it with
   * that venue's own numbers. Only the unqualified question — "what are my positions" — wants
   * the whole-account fan-out, so a named venue defers to the specific read.
   *
   * "earn" and "farm" both belong in this list, for the same reason "blend"/"aquarius"/
   * "soroswap" do — each names a specific thing with its own answer, not the general
   * "everything I own" question. "farm" used to be treated as the general fan-out's synonym
   * (the whole account, not one venue), on the theory that the fan-out's farm-overview call
   * covered it — but that call only ever contributes a best-effort PROSE sentence, never
   * structured facts, so "my farm position" answered with a MARGIN ACCOUNT card and a note
   * admitting "Blend supplies and Aquarius LP shares stay on Farm" — the same class of bug
   * "my Earn positions" had before it got this same treatment.
   */
  const namesOneVenue = any(text, "blend", "aquarius", "soroswap", "btoken", "b-token", "vtoken", "earn", "farm");
  /**
   * "Can you provide my Earn positions" / "what's my earn position" — same "named one
   * venue" shape as Blend/Aquarius, so it must be checked before the generic fan-out below
   * (which `namesOneVenue` now defers on) or the question goes unanswered. Earn has no
   * per-asset breakdown tool the way Blend does, so this reports the vToken (Earn-supplied)
   * balance for every asset Earn supports, not the margin account's collateral — a
   * different pool, even when the underlying token is the same.
   */
  if (asksAboutHoldings && !actsOnPosition && any(text, "earn") && !any(text, "blend", "aquarius", "soroswap")) {
    return {
      kind: "read",
      tool: "vanna_get_vtoken_balance",
      args: {},
      requires_account: true,
      template_id: "query_earn_position",
    };
  }
  /**
   * "My farm position" / "what am I farming" — see farmPositionAnswer's own doc comment
   * for why this reads on-chain Blend + Aquarius + Soroswap LP state directly instead of
   * the margin/farm fan-out's best-effort prose sentence.
   *
   * "Give my Soroswap Farm Position Details" / "...Aquarius Farm Position Details" used
   * to be EXCLUDED here on the theory that a named venue "already has its own more precise
   * answer" — it didn't; no such per-venue route exists, so naming a venue just fell
   * through everything to the generic capabilities blurb. A named venue now narrows the
   * SAME farm-overview read to that one venue instead of deferring to a route that isn't
   * there. Only "earn" still defers — it has its own vToken-based route above.
   */
  const farmVenue: "blend" | "aquarius" | "soroswap" | null = any(text, "blend")
    ? "blend"
    : any(text, "aquarius")
      ? "aquarius"
      : any(text, "soroswap")
        ? "soroswap"
        : null;
  if (asksAboutHoldings && !actsOnPosition && any(text, "farm") && !any(text, "earn")) {
    return {
      kind: "read",
      tool: "vanna_get_farm_overview",
      args: farmVenue ? { venue: farmVenue } : {},
      requires_account: true,
      template_id: "query_farm_position",
    };
  }
  if (asksAboutHoldings && !actsOnPosition && !namesOneVenue) {
    return {
      kind: "read",
      // Nominal tool for arg-building and smart-account resolution. `runRead` recognises
      // the template and fans out to the margin snapshot as well, because "all my
      // positions" spans margin collateral/debt AND the farm venues — one tool answers
      // half the question.
      tool: "vanna_get_farm_overview",
      args: {},
      requires_account: true,
      template_id: "query_all_positions",
    };
  }

  // "whats my helth factr" (G-06) — a loose enough match to survive the common drop of a
  // vowel in either word ("helth", "factr") without turning into a real fuzzy matcher.
  const asksHealthFactorTypo = /\bh\w*lth\s+fact\w*\b/i.test(text);
  if (
    (any(text, "health factor", "am i safe", "close to liquidation", "at risk", "my health", "account health") ||
      asksHealthFactorTypo) &&
    !hasActionWriteIntent
  ) {
    return {
      kind: "read",
      tool: "vanna_get_account_health",
      args: {},
      requires_account: true,
      template_id: "query_account_health",
    };
  }

  // (multi-goal handled early via tryMultiGoalPlan)

  /**
   * "How much Interest accrued till date in BLUSDC" fell through everything to the
   * generic capabilities blurb — it names neither "debt"/"owe"/"borrowed" (so
   * `asksAboutOwnDebt` below never saw it) nor any other recognised shape. No tool
   * in this deployment tracks accrued interest separately from principal — the
   * debt balance itself is the compounding figure — so this is answered honestly
   * with the current owed amount and a note, not fabricated.
   */
  if (/\b(accrued\s+interest|interest\s+accrued)\b/i.test(text)) {
    return {
      kind: "read",
      tool: "vanna_get_debt",
      args: { symbol: asset },
      requires_account: true,
      template_id: "query_accrued_interest",
    };
  }

  /**
   * "how much debt do I have" fell through everything to the generic capabilities
   * blurb — the fixed phrase list below matched "my debt" and "how much have i
   * borrowed" but not this word order. Same shape-based fix as the supply/holdings
   * questions above: a quantity-question word or "my"/"i" near "debt"/"owe"/
   * "borrowed", not an exact phrase. `any(text, "borrow")` elsewhere in this
   * function is word-boundaried and never matches "borrowed", so this cannot
   * steal a real borrow instruction.
   */
  const asksAboutOwnDebt =
    /\b(how much|what'?s|what)\b[\s\S]{0,30}\b(debt|owe|owed|borrowed)\b|\bmy\b[\s\S]{0,20}\b(debt|owed?)\b/i.test(
      text,
    );
  if (asksAboutOwnDebt) {
    return {
      kind: "read",
      tool: "vanna_get_debt",
      args: {},
      requires_account: true,
      template_id: "query_debt",
    };
  }

  /**
   * "How much collateral do I have?" — one of the product's own suggested prompts —
   * matched none of "my collateral"/"collateral value"/"how much have i deposited": no
   * "my", no "deposited", no "value". Same shape-based fix as debt/supply above: a
   * quantity-question word or "my" near "collateral", not a fixed phrase.
   *
   * "What is my XLM Balance in Margin account?" names no "collateral" at all — it's the
   * same question in "balance" clothing, scoped to the margin account specifically (not
   * Earn/Farm, which the generic holdings "balance" shape below already covers). Without
   * this, "<asset> balance ... margin account" fell through to `query_resolve` below,
   * whose "what is my" + "margin account" match is broad enough to swallow it.
   */
  const asksAboutOwnCollateral =
    /\b(how much|what'?s|what)\b[\s\S]{0,30}\bcollateral\b|\bmy\b[\s\S]{0,20}\bcollateral\b/i.test(text) ||
    (/\bbalance\b/i.test(text) && /\bmargin\s+account\b/i.test(text));
  if (
    asksAboutOwnCollateral ||
    any(text, "how much have i deposited", "collateral value", "what have i deposited")
  ) {
    return {
      kind: "read",
      tool: "vanna_get_collateral",
      args: {},
      requires_account: true,
      template_id: "query_collateral",
    };
  }

  if (any(text, "vtoken", "supply balance", "my supply balance")) {
    return {
      kind: "read",
      tool: "vanna_get_vtoken_balance",
      args: { symbol: asset ?? "USDC" },
      requires_account: true,
      template_id: "query_vtoken",
    };
  }

  /**
   * "How much credit do I have?" — the headline product question.
   *
   * Undercollateralised credit is what Vanna sells, and there was no deterministic route
   * for asking about it: the phrasing people use ("available credit", "borrowing power",
   * "how much can I take out") shares no keyword with the `can i borrow` list below, so
   * it depended entirely on Vertex guessing right. `max_borrow` is the read that answers
   * it. Kept above `can i borrow` so the more specific credit phrasing wins.
   */
  if (
    any(
      text,
      "available credit",
      "how much credit",
      "credit available",
      "credit limit",
      "borrowing power",
      "borrow power",
      "buying power",
      "credit line",
      "my credit",
    ) ||
    (any(text, "credit") && any(text, "how much", "what is", "what's", "do i have", "left"))
  ) {
    return {
      kind: "read",
      tool: "vanna_get_max_borrow",
      args: { symbol: asset ?? "USDC" },
      requires_account: true,
      template_id: "query_available_credit",
    };
  }

  if (any(text, "can i borrow", "how much can i borrow", "max borrow", "borrow allowed")) {
    return {
      kind: "read",
      tool: "vanna_can_borrow",
      args: {
        symbol: asset ?? "USDC",
        ...(amount != null ? { amount: String(amount) } : {}),
      },
      requires_account: true,
      template_id: "query_can_borrow",
    };
  }

  if (any(text, "can i withdraw", "can i pull out", "withdraw allowed")) {
    return {
      kind: "read",
      tool: "vanna_can_withdraw",
      args: {
        symbol: asset ?? "USDC",
        ...(amount != null ? { amount: String(amount) } : {}),
      },
      requires_account: true,
      template_id: "query_can_withdraw",
    };
  }

  if (any(text, "inactive account", "dead account", "closed account", "dormant")) {
    return {
      kind: "read",
      tool: "vanna_get_inactive_accounts",
      args: {},
      requires_account: true,
      template_id: "query_inactive",
    };
  }

  if (any(text, "resolve", "smart account", "margin account") && any(text, "look up", "resolve", "find my", "what is my")) {
    return {
      kind: "read",
      tool: "vanna_resolve_account",
      args: {},
      requires_account: false,
      template_id: "query_resolve",
    };
  }

  if (any(text, "contract address", "protocol address", "list addresses", "protocol addresses")) {
    return {
      kind: "read",
      tool: "vanna_list_protocol_addresses",
      args: {},
      template_id: "query_addresses",
    };
  }

  if (any(text, "collateral config", "allowed collateral", "what can i use as collateral")) {
    return {
      kind: "read",
      tool: "vanna_get_collateral_config",
      args: {},
      template_id: "query_collateral_config",
    };
  }

  /**
   * "What is Current Rate of bXLM?" names no "blend" word at all — bXLM/bUSDC ARE Blend's
   * own bToken symbols (a supplied position, Blend's own notation), so naming one already
   * means "about Blend" without needing the word. `\bxlm\b` alone can never match inside
   * "bXLM" either (no word-boundary between "b" and "X"), so the symbol has to be read
   * from the composite token directly, not the plain XLM/USDC check below.
   */
  const blendBTokenNamed = /\bbxlm\b/i.test(text) ? "XLM" : /\bbusdc\b/i.test(text) ? "USDC" : null;
  if (
    any(text, "blend reserve", "blend apy", "blend pool") ||
    (any(text, "blend") && any(text, "stats", "apr", "apy")) ||
    blendBTokenNamed
  ) {
    // "XLM vs USDC" / "XLM or USDC" is a comparison — list both, never pick one symbol.
    const namedBlend = [
      /\bxlm\b/i.test(raw) || blendBTokenNamed === "XLM" ? "XLM" : null,
      /\busdc\b/i.test(raw) || blendBTokenNamed === "USDC" ? "USDC" : null,
    ].filter(Boolean) as string[];
    const compare = namedBlend.length > 1 || any(text, "vs", " versus ", " or ", "compare", "pays more", "better");
    const sym = !compare && namedBlend.length === 1 ? namedBlend[0]! : asset && !compare ? asset : null;
    return {
      kind: "read",
      tool: sym ? "vanna_get_blend_reserve_stats" : "vanna_list_blend_reserves",
      args: sym ? { symbol: sym === "BLUSDC" ? "USDC" : sym } : {},
      template_id: "query_blend",
    };
  }

  /**
   * "What is XLM to SoUSDC Ratio in farm Soroswap pool?" fell through to the generic
   * capabilities blurb — no route asked an AMM pool's live reserve ratio directly
   * (the only existing ratio math, `handle.ts`'s Aquarius pool-ratio hint, is Aquarius-
   * only and reachable only as a side note on an add_liquidity clarify, not from a plain
   * question). Answered live from the same reserve reads that hint and the LP pool pages
   * themselves use — `SoroswapService.getPoolStats` / `AquariusService.getAquariusPoolStats`
   * — never a guessed number.
   */
  if (any(text, "ratio") && any(text, "soroswap", "aquarius")) {
    return {
      kind: "read",
      tool: "vanna_get_pool_ratio",
      args: { venue: any(text, "soroswap") ? "soroswap" : "aquarius" },
      template_id: "query_pool_ratio",
    };
  }

  if (any(text, "exchange rate", "vtoken rate")) {
    return {
      kind: "read",
      tool: "vanna_get_vtoken_exchange_rate",
      args: { symbol: asset ?? "USDC" },
      template_id: "query_exchange_rate",
    };
  }

  // List / rank all Vanna earn pools (not Blend) — fan-out in runRead.
  if (
    any(text, "all earn pools", "list all vanna earn", "earn pools with", "list earn pools") ||
    (any(text, "earn pool") && any(text, "list", "all", "every")) ||
    (any(text, "highest supply apy", "best supply apy", "highest apy") &&
      !any(text, "blend", "farm", "aquarius"))
  ) {
    return {
      kind: "read",
      tool: "vanna_get_pool_stats",
      args: { symbol: "__ALL_EARN__" },
      template_id: "query_all_earn_pools",
    };
  }

  if (
    any(text, "pool stats", "pool apr", "pool apy", "utilization", "how is the", "pool doing", "borrow apr", "supply apy", "yield on") ||
    (any(text, "pool") && any(text, "stat", "apr", "apy", "liquidity", "tvl"))
  ) {
    /**
     * "USDC pool stats" names bare "USDC" — on this platform that is genuinely
     * ambiguous among three separate deployments (BLUSDC/AQUSDC/SOUSDC, this session's
     * recurring "which USDC variant" theme for writes, via `ambiguousUsdcSlot`), yet the
     * read path picked one silently (the Vanna Earn pool's own wire symbol happens to be
     * bare "USDC") with no indication three other pools exist. Reported live: "it can
     * show all the states or it should ask specific which one" — showing every Earn
     * pool (the same answer `query_all_earn_pools` already gives) is the friendlier of
     * the two and requires no new backend call.
     */
    if (asset === "USDC") {
      return {
        kind: "read",
        tool: "vanna_get_pool_stats",
        args: { symbol: "__ALL_EARN__" },
        template_id: "query_all_earn_pools",
      };
    }
    return {
      kind: "read",
      tool: "vanna_get_pool_stats",
      args: { symbol: asset ?? "USDC" },
      template_id: "query_pool_stats",
    };
  }

  if (any(text, "prices of", "all prices", "show me prices", "prices for")) {
    const symbols = ASSETS.filter((a) => raw.toUpperCase().includes(a));
    return {
      kind: "read",
      tool: "vanna_get_prices_batch",
      args: { symbols: symbols.length ? symbols : ["XLM", "USDC", "AQUA"] },
      template_id: "query_prices_batch",
    };
  }

  /**
   * "What's my liquidation price?" is a question about a POSITION, not the oracle.
   *
   * The word "price" sent it to `vanna_get_price`, which answered with the XLM spot rate
   * and then said a liquidation price was unavailable "as no position data was provided"
   * — to a user whose account holds collateral and debt. The position was never fetched
   * because the route had already decided this was an oracle question.
   *
   * Checked before the price branch, and requires a possessive ("my"/"our") or an explicit
   * liquidation-price phrase, so "what is the price of XLM" still reaches the oracle.
   */
  if (
    /\bliquidat\w*/i.test(text) &&
    (/\b(my|our|i)\b/i.test(text) || /\bliquidation\s+price\b/i.test(text))
  ) {
    return {
      kind: "read",
      tool: "vanna_get_account_health",
      args: {},
      requires_account: true,
      template_id: "query_account_health",
    };
  }

  // “price of XLM and USDC” / dual-oracle asks — always batch when 2+ assets named
  if (any(text, "price", "trading at", "how much is", "rate", "oracle")) {
    const named: string[] = [];
    if (/\bxlm\b/i.test(raw)) named.push("XLM");
    if (/\baqusdc\b/i.test(raw)) named.push("AQUSDC");
    else if (/\bsousdc\b/i.test(raw)) named.push("SOUSDC");
    else if (/\bblusdc\b/i.test(raw)) named.push("USDC");
    else if (/\busdc\b/i.test(raw)) named.push("USDC");
    if (/\baqua\b/i.test(raw) && !/\baqusdc\b/i.test(raw)) named.push("AQUA");
    // de-dupe
    const symbols = [...new Set(named)];
    if (symbols.length >= 2 || (any(text, "and", "vs", "versus", ",") && symbols.length >= 1)) {
      const batch =
        symbols.length >= 2
          ? symbols
          : symbols[0] === "XLM"
            ? ["XLM", "USDC"]
            : ["USDC", "XLM"];
      return {
        kind: "read",
        tool: "vanna_get_prices_batch",
        args: { symbols: batch },
        template_id: "query_prices_batch",
      };
    }
    return {
      kind: "read",
      tool: "vanna_get_price",
      args: { symbol: asset ?? symbols[0] ?? "XLM" },
      template_id: "query_price",
    };
  }

  // bare asset mention + "stats" style
  if (asset && any(text, "stats", "status", "info")) {
    return {
      kind: "read",
      tool: "vanna_get_pool_stats",
      args: { symbol: asset },
      template_id: "query_pool_stats",
    };
  }

  // Standing risk preference without a write verb — still answer with guidance.
  const minHfOnly = parseMinHealthFactor(raw);
  if (minHfOnly != null && any(text, "health", "liquidat", "safe", "risk", "hf")) {
    return {
      kind: "read",
      tool: "vanna_get_account_health",
      args: {},
      requires_account: true,
      template_id: "query_health_with_floor",
    };
  }

  // Nothing matched. Tagged so `handleChat` can tell this apart from a clarification the
  // router chose deliberately: when the model was ALSO unreachable, replying with the
  // capability list is misleading — it reads as "I understood you and this is my answer"
  // when the truth is that the only component that could have understood never ran.
  return {
    kind: "clarify",
    template_id: "clarify_capabilities",
    message:
      "I can help with market data (prices, pool stats), your account (health, debt, collateral), " +
      "and actions (lend, deposit, borrow, repay, farm Blend, Aquarius LP, swap). " +
      "Examples: “lend 10 XLM”, “farm Blend at 2x with 20 BLUSDC”, “swap 10 XLM to AQUSDC”, " +
      "“invest 50 XLM where yield is highest”, “keep my health factor above 1.5”.",
  };
}
