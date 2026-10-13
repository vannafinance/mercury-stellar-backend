/**
 * Earn V3 formatters (the design's earn.js helpers fT / fQ / fL / fU / fP / fLoc / fXr).
 * Percentages here take a number that is ALREADY in percent (5.2 → "5.20%"); the pool state
 * holds fractions, so callers multiply by 100 first.
 */
import { usd } from "@/components/v3/format";

/** Compact token amount: 0 → "0", 1.25M, 1.25K, tiny values with up to 6 decimals, else 2 decimals. */
export const fT = (n: number): string =>
  !(n > 0)
    ? "0"
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(2)}K`
        : n < 0.01
          ? n.toFixed(6).replace(/\.?0+$/, "")
          : n.toFixed(2);

/** Compact amount with `d` decimals below 1,000 (stats strip). */
export const fQ = (n: number, d = 4): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(d);

/** Compact amount, 2 decimals. */
export const fL = (n: number): string => fQ(n, 2);

/** USD, never negative (share-rounding residue is not a loss). */
export const fU = (n: number): string => usd(Math.max(0, n));

/** Percent number → "5.20%". */
export const fP = (n: number): string => `${(+n || 0).toFixed(2)}%`;

/** Locale number with up to `d` decimals. */
export const fLoc = (n: number, d = 6): string => (+n || 0).toLocaleString("en-US", { maximumFractionDigits: d });

/** Exchange rate with 9 decimals, trailing zeros trimmed. */
export const fXr = (x: number): string => x.toFixed(9).replace(/\.?0+$/, "");

/** "Oct 7, 2026" (chart tooltips). */
export const dLabel = (t: number): string =>
  new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "$x" when the asset has an oracle price, "$0.00" otherwise (never a made-up $1). */
export const usdOr = (amount: number, price: number): string => (price > 0 ? fU(amount * price) : fU(0));

/** Short Stellar address / contract id: "GABCDE…XYZ123". */
export const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
