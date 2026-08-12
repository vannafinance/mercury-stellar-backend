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
const LEVERAGE_RE = /(\d+(?:\.\d+)?)\s*x\b/i;

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

function findAmount(text: string): number | null {
  const cleaned = stripAddresses(text);
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
  const noLev = cleaned.replace(LEVERAGE_RE, " ").replace(/\b\d+(?:\.\d+)?\s*%/g, " ");
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
    const farmAsset =
      (/\bblusdc\b/i.test(raw) && "BLUSDC") ||
      (/\baqusdc\b/i.test(raw) && "AQUSDC") ||
      (/\bsousdc\b/i.test(raw) && "SOUSDC") ||
      (asset && asset !== "XLM" ? asset : null) ||
      "BLUSDC";
    const farmAmtM = raw.match(/(\d+(?:\.\d+)?)\s*(?:blusdc|aqusdc|sousdc|usdc)\b/i);
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
  const text = raw.toLowerCase();
  const asset = findAsset(raw);
  const amount = findAmount(raw);
  const leverage = findLeverage(raw);

  // ── restricted ──────────────────────────────────────────────────────────
  if (any(text, "liquidate", "liquidation of")) {
    return {
      kind: "restricted",
      template_id: "liquidate",
      reason: "Liquidation of other accounts is a restricted keeper/protocol action — the copilot won't run it.",
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
  if (
    swapMatch ||
    (any(text, "swap") &&
      !any(text, "liquidity") &&
      (asset || swapPair) &&
      (amount != null || swapShare != null))
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
  const isBlendFarmWrite =
    any(text, "farm blend", "blend at", "to blend", "into blend", "on blend", "blend reserve", "blend pool") ||
    (any(text, "blend") && any(text, "farm", "deploy", "supply", "deposit") && !any(text, "position", "stats", "apy")) ||
    (any(text, "blend") && leverage != null && leverage > 1 && !any(text, "position", "stats", "apy"));
  if (
    isBlendFarmWrite &&
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
      any(text, "liquidity", "lp", "xlm/usdc", "pool"))
  ) {
    const half = any(text, "half", "50%", "50 %");
    // Pair default XLM / USDC family from message.
    const token_b =
      (/\baqusdc\b/i.test(raw) && "AQUSDC") ||
      (/\bsousdc\b/i.test(raw) && "SOUSDC") ||
      (/\bblusdc\b/i.test(raw) && "BLUSDC") ||
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
        any(text, "leverage", "lever") &&
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
   */
  if (
    !any(text, "can i withdraw", "can i pull out", "withdraw allowed") &&
    ((any(text, "withdraw") && any(text, "collateral")) ||
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
  if ((blendVenueNamed || (any(text, "blend") && leverage != null && leverage > 1)) && blendWriteVerb && !blendRateRead) {
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
  const isLendWrite =
    !isSupplyApyRead &&
    !isBlendOrFarmVenue &&
    (hasLendVerb ||
      any(text, "earn yield", "yield on my", "want to earn", "earn me") ||
      wantsHighestPool ||
      (any(text, "supply") &&
        !any(text, "supplied", "have i supplied", "my supply", "total supplied")) ||
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
    /\bwhat'?s\s+in\s+my\s+(?:account|portfolio|wallet)\b/i.test(text);
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
   * "My Blend position" names one venue and already has a route below that answers it with
   * that venue's own numbers. Only the unqualified question — "what are my positions" — wants
   * the whole-account fan-out, so a named venue defers to the specific read.
   */
  const namesOneVenue = any(text, "blend", "aquarius", "soroswap", "btoken", "b-token", "vtoken");
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

  if (
    any(text, "health factor", "am i safe", "close to liquidation", "at risk", "my health", "account health") &&
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

  if (any(text, "how much do i owe", "my debt", "how much have i borrowed", "what do i owe")) {
    return {
      kind: "read",
      tool: "vanna_get_debt",
      args: {},
      requires_account: true,
      template_id: "query_debt",
    };
  }

  if (
    any(text, "how much have i deposited", "my collateral", "collateral value", "what have i deposited")
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

  if (any(text, "blend reserve", "blend apy", "blend pool") || (any(text, "blend") && any(text, "stats", "apr", "apy"))) {
    // "XLM vs USDC" / "XLM or USDC" is a comparison — list both, never pick one symbol.
    const namedBlend = [
      /\bxlm\b/i.test(raw) ? "XLM" : null,
      /\busdc\b/i.test(raw) ? "USDC" : null,
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
