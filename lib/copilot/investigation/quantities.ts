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
 */

export type QuantityKind = "leverage" | "percent" | "tokens";

export type QuantitySpan = {
  kind: QuantityKind;
  value: string;
  start: number;
  end: number;
};

const LEVERAGE = /\d+(?:\.\d+)?\s*[x×](?![a-z])/gi;
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
      spans.push({ kind, value, start: match.index, end: match.index + raw.length });
    }
  };
  push(LEVERAGE, "leverage");
  push(PERCENT, "percent");
  return spans.sort((a, b) => a.start - b.start);
}

function coveredBy(spans: readonly QuantitySpan[], start: number, end: number): QuantityKind | null {
  for (const span of spans) {
    if (start >= span.start && end <= span.end) return span.kind;
  }
  return null;
}

/** True when `amount` appears as a token quantity, not as the coefficient of Nx or N%. */
export function isTokenAmountIn(text: string, amount: string): boolean {
  if (!amount || !text.includes(amount)) return false;
  const units = quantitySpans(text);
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

