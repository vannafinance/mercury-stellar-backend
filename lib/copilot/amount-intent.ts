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
