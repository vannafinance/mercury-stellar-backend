import toast from "react-hot-toast";

const NON_NUMERIC_CHAR_RE = /[^0-9.]/;
const VALID_AMOUNT_RE = /^[0-9]*\.?[0-9]{0,2}$/;

/**
 * Returns true if `value` is a valid in-progress amount string:
 * empty, or digits with at most one decimal point and at most
 * two digits after it. No letters, no exponent, no sign, no other
 * characters.
 */
export function isValidAmountInput(value: string): boolean {
  if (value === "") return true;
  return VALID_AMOUNT_RE.test(value);
}

/**
 * Validate an amount-input change. If valid, returns the string
 * so callers can pass it to their setter. If invalid, shows a single
 * deduplicated toast warning and returns null — callers should bail.
 *
 * The toast message is tailored to the failure mode: "Only numbers
 * allowed" for letters/special chars, and "Max 2 decimal places" when
 * the user tries to type a third digit after the decimal point.
 */
export function validateAmountChange(raw: string): string | null {
  if (isValidAmountInput(raw)) return raw;
  if (NON_NUMERIC_CHAR_RE.test(raw)) {
    toast.error("Only numbers allowed", { id: "amount-input-validation" });
  } else {
    // Numeric but too many decimals — multi-dot or >2 fractional digits.
    toast.error("Max 2 decimal places", { id: "amount-input-validation" });
  }
  return null;
}
