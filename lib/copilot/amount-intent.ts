/**
 * Size language the margin UI already exposes as chips (10% / 25% / 50% / 100%).
 *
 * "Repay all my XLM" is not a missing amount — it is fraction=1 against live debt.
 * Asking "how much?" after that is the same class of bug as asking for a borrow size
 * when leverage already implied it.
 */

/** Explicit numeric size wins; this only fires when the user named a share of a balance. */
export function findAmountFraction(text: string): number | null {
  const t = text.toLowerCase();

  // Percentages first so "repay 25% of my XLM" is not flattened into "all".
  const pct = t.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const n = Number(pct[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n / 100;
  }

  if (/\b(half|one\s*half)\b/.test(t)) return 0.5;
  if (/\b(quarter|one\s*quarter)\b/.test(t)) return 0.25;

  // Full / max / clear — the Margin "100%" chip.
  if (
    /\b(all|entire|full|everything|max(?:imum)?)\b/.test(t) ||
    /\b(pay\s*off|payoff|clear(?:\s+my)?(?:\s+loan|\s+debt)?|wipe)\b/.test(t) ||
    /\b100\s*%\b/.test(t)
  ) {
    return 1;
  }

  return null;
}

/**
 * A share of a BALANCE — for supply / deposit / withdraw, where the pot being divided is
 * a live balance rather than a debt.
 *
 * Stricter than {@link findAmountFraction} on purpose. Repay can read a bare "all" as
 * "all of it", because the only quantity in scope is the debt. For an earn supply the
 * same word sits next to yield-seeking language the router already understands —
 * "invest for max yield", "earn me the best return" — and reading THAT "max" as a size
 * would silently move a whole wallet into a pool. So the full-balance rungs only fire
 * when the sentence names the balance the share is taken from.
 *
 * "max" is disqualified only when it is the superlative itself ("max yield"). A sentence
 * that says both — "invest all my USDC for max profit" — is still sized off "all my USDC",
 * because the size and the ranking preference are two separate instructions.
 */
export function findBalanceFraction(text: string): number | null {
  const t = (text || "").toLowerCase();

  // An explicit share is unambiguous, so it is read before anything else.
  const pct = t.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const n = Number(pct[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n / 100;
  }
  if (/\b(?:one\s*)?half\b/.test(t)) return 0.5;
  if (/\b(?:a\s+)?quarter\b/.test(t)) return 0.25;

  // Which balance is this a share OF? Without an answer, "all" is not a size.
  const namesBalance =
    /\b(?:wallet|balance|holdings?|collateral|i\s+have|i've\s+got)\b/.test(t) ||
    /\b(?:all|entire|everything|max(?:imum)?)\b[^.]{0,24}?\bmy\s+[a-z]+/.test(t) ||
    /\bmy\s+(?:whole|entire|full)\b/.test(t);
  if (!namesBalance) return null;

  const saysAll = /\b(?:all|entire|everything)\b/.test(t);
  const saysMax = /\bmax(?:imum)?\b/.test(t);
  const maxIsSuperlative =
    /\bmax(?:imum)?\s+(?:yield|profit|apy|apr|return|returns|interest|rate)\b/.test(t);
  if (saysAll || (saysMax && !maxIsSuperlative)) return 1;

  return null;
}

/**
 * Size a fraction against a balance, FLOORED to Stellar's 7 decimals.
 *
 * Floor, never round: rounding up past the balance is what turns a "100%" chip into an
 * on-chain "insufficient balance". Same rule as `floorAmountToInput`, which is what the
 * Margin and Earn percentage chips use.
 */
export function applyFraction(balance: number, fraction: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.floor(balance * Math.min(1, fraction) * 1e7) / 1e7;
}

/**
 * Balance-share chips — the same 10/25/50/100 rungs as `DEPOSIT_PERCENTAGES`, which is
 * what the Margin collateral box and the Earn supply form both render.
 */
export const BALANCE_FRACTION_OPTIONS: Array<{
  id: string;
  fraction: number;
  label: string;
}> = [
  { id: "0.1", fraction: 0.1, label: "10%" },
  { id: "0.25", fraction: 0.25, label: "25%" },
  { id: "0.5", fraction: 0.5, label: "50%" },
  { id: "1", fraction: 1, label: "100% / max" },
];

/** Margin repay chips — same rungs the website shows. */
export const REPAY_FRACTION_OPTIONS: Array<{
  id: string;
  fraction: number;
  label: string;
  description: string;
}> = [
  { id: "0.1", fraction: 0.1, label: "10%", description: "Repay a tenth of this debt" },
  { id: "0.25", fraction: 0.25, label: "25%", description: "Repay a quarter of this debt" },
  { id: "0.5", fraction: 0.5, label: "50%", description: "Repay half of this debt" },
  { id: "1", fraction: 1, label: "100% / all", description: "Repay the full outstanding balance" },
];
