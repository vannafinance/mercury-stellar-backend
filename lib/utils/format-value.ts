/**
 * Value formatting utility for margin components
 * Easy to extend with new format types
 */

export type FormatType =
  | "percentage"
  | "leverage"
  | "time-minutes"
  | "time-hours"
  | "number"
  | "currency"
  | "health-factor"
  | "points";

export interface FormatOptions {
  type: FormatType;
  decimals?: number;
  showZeroAsDash?: boolean;
  useLargeFormat?: boolean; // K/M formatting for large numbers
}

/**
 * Format a number value based on the specified format type
 */
export function formatValue(
  value: number | null | undefined,
  options: FormatOptions
): string {
  const {
    type,
    decimals = 2,
    showZeroAsDash = false,
    useLargeFormat = false,
  } = options;

  // Handle null, undefined, or zero values
  if (value === null || value === undefined || (value === 0 && showZeroAsDash)) {
    return "0";
  }

  const numValue = value;

  // Format number with specified decimals
  const formatNumber = (num: number, dec: number = decimals) =>
    num.toLocaleString("en-US", {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    });

  // Format large numbers (K/M)
  const formatLarge = (num: number, dec: number = decimals) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(dec)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(dec)}K`;
    return formatNumber(num, dec);
  };

  // Apply formatting based on type
  let formatted: string;
  let suffix: string = "";

  switch (type) {
    case "percentage":
      formatted = formatNumber(numValue);
      suffix = "%";
      break;

    case "leverage":
      formatted = formatNumber(numValue, 1);
      suffix = "x";
      break;

    case "time-minutes":
      // 0 here means "no scheduled liquidation" (no debt or healthy position).
      // Showing "0m" looks like the user is about to be liquidated, which is
      // exactly the opposite. Render "—" instead.
      if (numValue <= 0) {
        return "—";
      }
      formatted = formatNumber(numValue, 0);
      suffix = "m";
      break;

    case "time-hours":
      if (numValue <= 0) {
        return "—";
      }
      formatted = formatNumber(numValue, 0);
      suffix = "h";
      break;

    case "health-factor":
      // The store uses 999 as the "infinite HF" sentinel for zero-debt
      // positions — render it as ∞ instead of a meaningless "999.0".
      // Anything > 100 is also effectively infinite from a risk perspective.
      if (numValue >= 100) {
        formatted = "∞";
      } else {
        formatted = formatNumber(numValue, 2);
      }
      suffix = "";
      break;

    case "points":
      formatted = formatNumber(numValue, 1);
      suffix = "x";
      break;

    case "currency":
      formatted = useLargeFormat
        ? formatLarge(numValue)
        : formatNumber(numValue);
      return `$${formatted}`;

    case "number":
    default:
      formatted = useLargeFormat
        ? formatLarge(numValue)
        : formatNumber(numValue);
      suffix = "";
      break;
  }

  return `${formatted}${suffix}`;
}

/**
 * Pre-configured format helpers for common use cases
 */
export const formatPercentage = (value: number | null | undefined) =>
  formatValue(value, { type: "percentage" });

export const formatLeverage = (value: number | null | undefined) =>
  formatValue(value, { type: "leverage" });

export const formatTimeMinutes = (value: number | null | undefined) =>
  formatValue(value, { type: "time-minutes" });

export const formatHealthFactor = (value: number | null | undefined) =>
  formatValue(value, { type: "health-factor" });

export const formatPoints = (value: number | null | undefined) =>
  formatValue(value, { type: "points" });

/**
 * Format number with optional large format (K/M)
 * Components can add their own currency/unit suffixes
 */
export const formatNumber = (
  value: number | null | undefined,
  decimals: number = 2,
  useLargeFormat: boolean = false,
  showZeroAsDash: boolean = false
) => formatValue(value, {
  type: "number",
  decimals,
  useLargeFormat,
  showZeroAsDash,
});

