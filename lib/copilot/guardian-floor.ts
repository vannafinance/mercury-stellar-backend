/**
 * Parse a health-factor floor the user states in a prompt, and decide what to do with it.
 *
 * Vanna liquidates at HF 1.1 — the same threshold gates borrow, withdraw and liquidation
 * (RiskEngine BALANCE_TO_BORROW_THRESHOLD = 1.1 × WAD). A "floor" at or under that line
 * is not a safety margin, it is the cliff edge, so it is never stored; the user is told
 * why and what to say instead. Anything above the line is honoured — the user's number
 * is the user's number — but a thin buffer comes with a warning that names the risk.
 *
 * Previously the workspace stored any `n >= 1` it could regex out of the prompt, which
 * (a) missed "My HF will stay above the 1.1" (abbreviation + "the"), so the default 1.3
 * silently stayed while the constraint chip said 1.1, and (b) would have stored 1.0 from
 * "keep health factor above 1.0" and auto-repaid at the liquidation line.
 */

export const LIQUIDATION_HF = 1.1;
/** Up to this, the floor is accepted but the user is warned how thin it is. */
export const THIN_FLOOR_MAX = 1.2;
export const DEFAULT_GUARDIAN_FLOOR = 1.3;
/** Above this the number is not a health factor; ignore it. */
const MAX_PLAUSIBLE_FLOOR = 20;

export type FloorVerdict =
  | { verdict: "ok"; value: number; message: null }
  | { verdict: "warn"; value: number; message: string }
  | { verdict: "reject"; value: number; message: string };

const MENTIONS_HF = /\b(?:hf|health\s*factor)\b/i;

/** "above the 1.15", "over 1.2", "at least 1.5", ">= 1.3" — the word "the" is optional. */
const FLOOR_AFTER_KEYWORD = /(?:above|over|at\s+least|>=?)\s*(?:the\s+)?(\d+(?:\.\d+)?)/i;
/** "health factor of 1.5", "hf 1.4" — number directly after the noun. */
const FLOOR_AFTER_NOUN = /\b(?:hf|health\s*factor)\b[^\d]{0,24}(\d+(?:\.\d+)?)/i;

/** Extract the stated floor, or null when the prompt does not state one. */
export function extractStatedFloor(text: string): number | null {
  if (!text || !MENTIONS_HF.test(text)) return null;
  const m = text.match(FLOOR_AFTER_KEYWORD) || text.match(FLOOR_AFTER_NOUN);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n >= MAX_PLAUSIBLE_FLOOR) return null;
  return n;
}

function pct(a: number, b: number): string {
  return ((a / b - 1) * 100).toFixed(1).replace(/\.0$/, "");
}

/**
 * Decide what to do with a stated floor. `current` is the floor that stays in force on
 * a reject, so the message can say which number is actually being used.
 */
export function judgeFloor(value: number, current: number = DEFAULT_GUARDIAN_FLOOR): FloorVerdict {
  if (value <= LIQUIDATION_HF) {
    return {
      verdict: "reject",
      value,
      message:
        `${value} is the liquidation line on Vanna, not a safety floor — a position there ` +
        `can be liquidated on the next price tick. Keeping your floor at ${current.toFixed(2)}. ` +
        `Say a number above ${LIQUIDATION_HF} (for example 1.15) if you want it thinner.`,
    };
  }
  if (value <= THIN_FLOOR_MAX) {
    return {
      verdict: "warn",
      value,
      message:
        `Floor set to ${value}. That is a ${pct(value, LIQUIDATION_HF)}% buffer above liquidation ` +
        `(${LIQUIDATION_HF}) — XLM moves that much in a day. The guardian will auto-repay at ${value}.`,
    };
  }
  return { verdict: "ok", value, message: null };
}

/** One call for the workspace: parse the prompt, judge it, or null if no floor was stated. */
export function parseStatedFloor(text: string, current: number = DEFAULT_GUARDIAN_FLOOR): FloorVerdict | null {
  const value = extractStatedFloor(text);
  return value == null ? null : judgeFloor(value, current);
}
