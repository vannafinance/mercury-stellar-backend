import toast from "react-hot-toast";

const NON_NUMERIC_CHAR_RE = /[^0-9.]/;
// Stellar token amounts carry up to 7 decimals (SCALAR_7). Allow the full
// precision so dust / fractional balances (e.g. 937.3325000) are fully editable
// — capping at 2dp silently truncated real balances and blocked editing.
export const AMOUNT_MAX_DECIMALS = 7;
const VALID_AMOUNT_RE = /^[0-9]*\.?[0-9]{0,7}$/;

/**
 * Format a numeric amount for an editable amount field: FLOOR to Stellar's
 * 7-decimal precision (never round up past the source max, which would trip a
 * "> max" check / on-chain rounding) and return a clean, trailing-zero-free
 * string. Use for "Max" / percentage presets so they carry full precision and
 * stay editable — not `toFixed(2)`, which truncated real balances to 2dp.
 */
export const floorAmountToInput = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "";
  const floored = Math.floor(n * 1e7) / 1e7;
  // toFixed, not String() — String() switches to exponential notation below
  // 1e-6 (e.g. 0.0000008 -> "8e-7"), which then fails to re-parse as a valid
  // amount and renders wrong in the input. toFixed(7) always gives a plain
  // decimal string; strip trailing zeros (and a bare trailing '.') to match
  // this function's existing "clean, no trailing zeros" contract.
  return floored.toFixed(7).replace(/\.?0+$/, "");
};

/**
 * Returns true if `value` is a valid in-progress amount string:
 * empty, or digits with at most one decimal point and at most
 * seven digits after it (Stellar's token precision). No letters, no
 * exponent, no sign, no other characters.
 */
export function isValidAmountInput(value: string): boolean {
  if (value === "") return true;
  return VALID_AMOUNT_RE.test(value);
}

/**
 * Validate an amount-input change. If valid, returns the string
 * so callers can pass it to their setter (KEEP it as a string — converting to a
 * Number on each keystroke turns a partial "." into NaN and drops trailing
 * decimals). If invalid, shows a single deduplicated toast and returns null.
 *
 * The toast message is tailored to the failure mode: "Only numbers allowed" for
 * letters/special chars, and a decimal-cap message past 7 fractional digits.
 */
export function validateAmountChange(raw: string): string | null {
  if (isValidAmountInput(raw)) return raw;
  if (NON_NUMERIC_CHAR_RE.test(raw)) {
    toast.error("Only numbers allowed", { id: "amount-input-validation" });
  } else {
    // Numeric but malformed — multi-dot or >7 fractional digits.
    toast.error(`Max ${AMOUNT_MAX_DECIMALS} decimal places`, { id: "amount-input-validation" });
  }
  return null;
}

/**
 * Convert a validated decimal amount string to 18-decimal WAD exactly.
 * Keeping this string-based avoids floating-point rounding and preserves the
 * seventh Stellar decimal (the repay form previously truncated it to 6dp).
 */
export function decimalAmountToWad(value: string): bigint {
  if (!value || !isValidAmountInput(value) || value === ".") return BigInt(0);
  const [wholeRaw = "0", fractionRaw = ""] = value.split(".");
  const whole = wholeRaw || "0";
  const fraction = fractionRaw.padEnd(18, "0").slice(0, 18);
  return BigInt(whole) * BigInt("1000000000000000000") + BigInt(fraction || "0");
}

/**
 * Precision-safe `number` -> 18-decimal WAD, for call sites that compute an
 * amount as a JS number rather than holding a validated input string.
 * Routes through {@link decimalAmountToWad} via `toFixed(7)` (Stellar's own
 * max precision) — NOT `Math.floor(n * 1_000_000) * 1_000_000_000_000`, which
 * only keeps 6 of Stellar's 7 decimal places and silently truncates the last
 * digit. That truncation is exactly what stranded 0.0000001-0.0000009 of
 * un-transferable dust on every Max/100% deposit, borrow, and withdraw built
 * on that formula (components/margin/transfer-collateral.tsx and others).
 */
export function numberAmountToWad(n: number): bigint {
  if (!Number.isFinite(n) || n <= 0) return BigInt(0);
  return decimalAmountToWad(n.toFixed(AMOUNT_MAX_DECIMALS));
}
