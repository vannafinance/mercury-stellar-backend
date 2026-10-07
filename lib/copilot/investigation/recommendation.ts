
/** What the recommendation reads: the plan's rate as its card shows it, and whether it borrows. */
export interface RankedPlan {
  borrows: boolean;
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

/** The letter a card gives the plan at this position. */
const planLetter = (index: number) => String.fromCharCode(65 + index);

const shown = (value: number) => `${value.toFixed(2)}%`;

/**
 * Why the first plan is the recommended one, from the same figures its card shows.
 *
 * The plans arrive ranked (plans that do not borrow by expected return, then those that do by net return), so the
 * leader is the recommendation; this says what put it there. It states only what the numbers support: that it pays
 * the most when it does, that it adds no debt when the plans beside it borrow, and, when a borrowing plan pays more,
 * that the leader is recommended for not borrowing rather than for its rate. Null with fewer than two plans.
 */
export function recommendationReason(plans: readonly RankedPlan[]): string | null {
  if (plans.length < 2) return null;
  const [lead, ...others] = plans;
  const leadRate = rateOf(lead);
  const rated = others.map((plan, index) => ({ rate: rateOf(plan), plan, letter: planLetter(index + 1) })).filter((row): row is { rate: number; plan: RankedPlan; letter: string } => row.rate !== null);
  const best = rated.reduce<(typeof rated)[number] | null>((top, row) => (!top || row.rate > top.rate ? row : top), null);
  const noDebtBesideBorrowing = !lead.borrows && others.some((plan) => plan.borrows);
  const higherOnOffer = rated.filter((row) => leadRate !== null && row.rate > leadRate);
  if (leadRate === null || !best) return noDebtBesideBorrowing ? "Recommended because it adds no debt." : null;
  if (!higherOnOffer.length) {
    const margin = `${shown(leadRate)} against ${shown(best.rate)} for Plan ${best.letter}`;
    return lead.borrows
      ? `Recommended: the best return after borrow cost of the plans, ${margin}.`
      : noDebtBesideBorrowing
        ? `Recommended: the highest return of the plans, ${margin}, and it adds no debt.`
        : `Recommended: the highest return of the plans, ${margin}.`;
  }
  const richer = higherOnOffer.sort((a, b) => b.rate - a.rate)[0];
  return noDebtBesideBorrowing && higherOnOffer.every((row) => row.plan.borrows)
    ? `Recommended because it adds no debt; Plan ${richer.letter} pays more (${shown(richer.rate)} against ${shown(leadRate)}) but borrows.`
    : `Recommended as the first of the plans by the ranking; Plan ${richer.letter} shows a higher rate (${shown(richer.rate)} against ${shown(leadRate)}).`;
}
