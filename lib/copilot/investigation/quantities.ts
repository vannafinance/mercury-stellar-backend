/**
 * Quantity kinds in user text. Not a verb list: the UNIT decides the kind.
 *
 * Site-wide (Margin Dual Borrow, Farm one-click, lite strategies):
 *   Nx / N×  — leverage. Total position is N × equity, so borrowUsd = depositUsd × (N − 1).
 *   N%       — a percent control on that page (not tokens).
 *   N + asset — a token amount.
 *
 * `5xlm` is five XLM (x starts the ticker). `2x` / `2×` / `2 x` is leverage
 * because the multiplier is not the start of an asset id.
 *
 *   Nk       — a SCALE suffix: the same token amount written short. `10k` is 10000.
 *
 * A scale suffix is a unit like the others, so it belongs in this table rather than in
 * the comparison: the span carries the expanded value, and everything that anchors an
 * amount to the user's words compares numbers instead of substrings. 14 Sep, live:
 * "remove 10k xlm from my blend pool" and "withdraw 5k xlm" both compiled the right leg
 * and were then refused because the text said "10k" and the amount said "10000".
 *
 * Only `k` is expanded. `m` is ambiguous (million or milli) and `b` is not something
 * anyone types here; a wrong 1000x on a money path is not a mistake worth risking for
 * the convenience, so those fall through to the ordinary "not in your request" refusal.
 */

export type QuantityKind = "leverage" | "percent" | "tokens";

export type QuantitySpan = {
  kind: QuantityKind;
  /** The number as written. */
  value: string;
  /** What it means once its unit is applied — `10k` carries `10000`. Equals `value` otherwise. */
  amount: string;
  start: number;
  end: number;
};

const LEVERAGE = /\d+(?:\.\d+)?\s*[x×](?![a-z])/gi;
const SCALE = /(\d+(?:\.\d+)?)\s*k(?![a-z0-9])/gi;
const PERCENT = /\d+(?:\.\d+)?\s*%/g;
const NUMBER = /\d+(?:\.\d+)?/g;

export function quantitySpans(text: string): QuantitySpan[] {
  const spans: QuantitySpan[] = [];
  const push = (re: RegExp, kind: QuantityKind) => {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      const value = (raw.match(/\d+(?:\.\d+)?/) ?? [])[0];
      if (!value || match.index == null) continue;
      spans.push({ kind, value, amount: expand(value, kind, raw), start: match.index, end: match.index + raw.length });
    }
  };
  push(LEVERAGE, "leverage");
  push(PERCENT, "percent");
  push(SCALE, "tokens");
  return spans.sort((a, b) => a.start - b.start);
}

/** A scale span means the number times its suffix; every other unit means the number itself. */
function expand(value: string, kind: QuantityKind, raw: string): string {
  if (kind !== "tokens" || !/k$/i.test(raw.trim())) return value;
  const scaled = Number(value) * 1000;
  return Number.isFinite(scaled) ? String(scaled) : value;
}

function coveredBy(spans: readonly QuantitySpan[], start: number, end: number): QuantityKind | null {
  for (const span of spans) {
    if (start >= span.start && end <= span.end) return span.kind;
  }
  return null;
}

/**
 * True when `amount` appears as a token quantity, not as the coefficient of Nx or N%.
 *
 * A span whose unit makes it a token amount (a scale suffix) satisfies this by its
 * EXPANDED value, so "10k" anchors the amount "10000". Comparison is numeric, not
 * textual: "10000" and "10000.0" are the same quantity and a user who writes either
 * has named the same number.
 */
export function isTokenAmountIn(text: string, amount: string): boolean {
  if (!amount) return false;
  const wanted = Number(amount);
  if (!Number.isFinite(wanted)) return false;
  const units = quantitySpans(text);
  for (const span of units) {
    if (span.kind === "tokens" && Number(span.amount) === wanted) return true;
  }
  if (!text.includes(amount)) return false;
  NUMBER.lastIndex = 0;
  for (const match of text.matchAll(NUMBER)) {
    if (match[0] !== amount || match.index == null) continue;
    const kind = coveredBy(units, match.index, match.index + match[0].length);
    if (kind === null) return true;
  }
  return false;
}

export function leverageFrom(text: string): number | null {
  const last = quantitySpans(text).filter((span) => span.kind === "leverage").at(-1);
  if (!last) return null;
  const value = Number(last.value);
  return Number.isFinite(value) && value > 1 ? value : null;
}

export function percentFrom(text: string): number | null {
  const last = quantitySpans(text).filter((span) => span.kind === "percent").at(-1);
  if (!last) return null;
  const value = Number(last.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

import { parseMinHealthFactor } from "../router";

/** The latest explicit floor stated across thread messages, formatted to two decimals. */
export function statedFloorFrom(messages: readonly string[]): string | null {
  let floor: number | null = null;
  for (const message of messages) {
    const parsed = parseMinHealthFactor(message);
    if (parsed !== null) floor = parsed;
  }
  return floor !== null ? floor.toFixed(2) : null;
}

