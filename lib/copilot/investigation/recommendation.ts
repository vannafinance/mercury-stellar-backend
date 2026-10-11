/** What the recommendation reads: the figures a plan's card shows, and whether it borrows. */
export interface RankedPlan {
  borrows: boolean;
  amountUsd?: string | null;
  netApyPct?: string | null;
  netAprPct?: string | null;
  supplyApyPct?: string | null;
  supplyAprPct?: string | null;
}

const rateOf = (plan: RankedPlan): number | null => {
  const raw = plan.borrows ? plan.netApyPct ?? plan.netAprPct : plan.supplyApyPct ?? plan.supplyAprPct;
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
};

/** What the plan earns over a year: the money it puts to work at its rate. This is what the ranking orders by. */
const earningsOf = (plan: RankedPlan): number | null => {
  const rate = rateOf(plan);
  const amount = plan.amountUsd == null ? NaN : Number(plan.amountUsd);
  return rate !== null && Number.isFinite(amount) ? (amount * rate) / 100 : null;
};

/** The letter a card gives the plan at this position. */
const planLetter = (index: number) => String.fromCharCode(65 + index);

const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const pct = (value: number) => `${value.toFixed(2)}%`;

/**
 * Why the first plan is the recommended one, from the figures its card shows.
 *
 * The plans arrive ranked: those that do not borrow by what they earn over a year (money put to work times rate),
 * then those that do. So the leader is the recommendation, and the reason is the same quantity the ranking used. A
 * rival with a higher rate is named as such, because a larger rate on less money is the usual reason it is not first.
 * Null with fewer than two plans, or when nothing in the figures supports a reason.
 */
export function recommendationReason(plans: readonly RankedPlan[]): string | null {
  if (plans.length < 2) return null;
  const [lead, ...others] = plans;
  const rivals = others.map((plan, index) => ({ plan, letter: planLetter(index + 1), earns: earningsOf(plan), rate: rateOf(plan) }));
  const leadEarns = earningsOf(lead);
  const noDebtBesideBorrowing = !lead.borrows && others.some((plan) => plan.borrows);
  const withEarnings = rivals.filter((row): row is typeof row & { earns: number } => row.earns !== null);
  const best = withEarnings.reduce<(typeof withEarnings)[number] | null>((top, row) => (!top || row.earns > top.earns ? row : top), null);
  if (leadEarns === null || !best) return noDebtBesideBorrowing ? "Recommended because it adds no debt." : null;
  if (best.earns > leadEarns) {
    return noDebtBesideBorrowing && withEarnings.filter((row) => row.earns > leadEarns).every((row) => row.plan.borrows)
      ? `Recommended because it adds no debt; Plan ${best.letter} earns more (about ${money(best.earns)} a year against ${money(leadEarns)}) but borrows.`
      : null;
  }
  const leadRate = rateOf(lead);
  const higherRate = leadRate === null ? null : rivals.filter((row) => row.rate !== null && row.rate > leadRate).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0] ?? null;
  const caveat = higherRate ? ` (Plan ${higherRate.letter} has the higher rate, ${pct(higherRate.rate!)}, but puts less money to work)` : "";
  return `Recommended: earns the most over a year, about ${money(leadEarns)} against ${money(best.earns)} for Plan ${best.letter}${caveat}${noDebtBesideBorrowing ? ", and it adds no debt" : ""}.`;
}
