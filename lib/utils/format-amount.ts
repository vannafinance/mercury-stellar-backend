// Adaptive number formatting for token amounts + USD — the DeFi-standard approach
// (Uniswap/Aave-style): magnitude-based precision so small balances stay visible
// instead of rounding to a misleading "0.00", while large balances stay readable.
//
// Use these everywhere amounts/USD are shown so every panel is consistent.

const STELLAR_MAX_DECIMALS = 7; // Stellar/Soroban token precision

/**
 * Token amount:
 *   |x| >= 1   → 2 decimals, grouped         e.g. 1,234.57
 *   0 < |x| < 1 → up to 7 decimals, trailing zeros trimmed (reveals dust)
 *                                            e.g. 0.0123, 0.0000012
 *   x === 0    → "0"
 */
const SMALL_DISPLAY_FLOOR = 0.0001; // below this, show "<0.0001" rather than noise

export function formatTokenAmount(value: number, maxSmallDecimals = STELLAR_MAX_DECIMALS): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1) {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Sub-display micro-dust (e.g. a single stroop) → "<0.0001" instead of a long
  // 7-decimal string or scientific notation like "1e-7".
  if (abs < SMALL_DISPLAY_FLOOR) return "<0.0001";
  // Otherwise reveal the value in DECIMAL notation, trailing zeros trimmed.
  // (Build the string from toFixed — never parseFloat().toString(), which emits
  // scientific notation for small numbers.)
  return value.toFixed(maxSmallDecimals).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * USD value:
 *   x <= 0       → "$0.00"
 *   0 < x < 0.01 → "<$0.01"   (tiny but non-zero — don't claim it's $0.00)
 *   x >= 0.01    → "$1,234.57"
 */
export function formatUsdValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format any numeric magnitude into clean decimal notation.
 * GUARANTEE: Never emits exponent / scientific notation (e.g. "7e-7", "1e-8", "1e21").
 * Trailing zeros and trailing dot are trimmed.
 * If value rounds to 0 within maxDecimals, returns "0".
 */
export function formatExactDecimalAmount(value: number, maxDecimals = STELLAR_MAX_DECIMALS): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  let s = value.toFixed(maxDecimals);
  if (s.includes("e") || s.includes("E")) {
    const [coeff, expStr] = s.split(/[eE]/);
    const exp = parseInt(expStr, 10);
    const isNeg = coeff.startsWith("-");
    const cleanCoeff = isNeg ? coeff.slice(1) : coeff;
    const [intPart, fracPart = ""] = cleanCoeff.split(".");
    if (exp > 0) {
      const allDigits = intPart + fracPart;
      if (exp >= fracPart.length) {
        s = allDigits + "0".repeat(exp - fracPart.length);
      } else {
        s = allDigits.slice(0, intPart.length + exp) + "." + allDigits.slice(intPart.length + exp);
      }
    } else {
      const absExp = Math.abs(exp);
      s = "0." + "0".repeat(absExp - 1) + intPart + fracPart;
    }
    if (isNeg) s = "-" + s;
  }
  const trimmed = s.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "");
  if (trimmed === "-0" || trimmed === "" || trimmed === "0") return "0";
  return trimmed;
}
