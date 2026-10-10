/**
 * The yield a plan shows, in the convention each venue's own page uses.
 *
 * The sizer judges carry in simple APR, and that stays. What the user READS must match the
 * app: the Earn page labels its rate "Supply APY" and shows the protocol's figure as it is;
 * the Farm page compounds Blend's supply APR weekly (`blendSupplyApyFromApr`). 23 Sep, owner:
 * every plan card said "APR" while the pages say "APY", so the same position read two ways.
 *
 * A plan that mixes venues is converted leg by leg and then weighted by what each leg
 * deploys. Converting the blended APR once would compound Earn's share as if it were Blend.
 */
import { blendSupplyApyFromApr } from "../../rate-display";

export type RateKind = "earn_supply" | "blend_supply" | "earn_borrow";

/** One leg's annual rate, as the percentage its venue's page shows. */
export function shownApyPct(kind: RateKind, aprPct: string | number): number {
  const apr = Number(aprPct);
  return kind === "blend_supply" ? blendSupplyApyFromApr(apr / 100) * 100 : apr;
}

/**
 * The plan's supply APY (weighted over supply legs) and net APY (supply earned minus borrow
 * paid, over the amount deployed). Null where the APR figure beside it would also be null.
 */
export function planApy(
  legs: readonly { kind: RateKind; usd: number; aprPct: string | number }[],
  deployedUsd: number,
): { supplyApyPct: number | null; netApyPct: number | null } {
  let supplied = 0, earned = 0, paid = 0;
  for (const leg of legs) {
    const apy = shownApyPct(leg.kind, leg.aprPct) * leg.usd;
    if (leg.kind === "earn_borrow") paid += apy;
    else { supplied += leg.usd; earned += apy; }
  }
  return {
    supplyApyPct: supplied > 0 ? earned / supplied : null,
    netApyPct: deployedUsd > 0 ? (earned - paid) / deployedUsd : null,
  };
}

/** Two decimals, the precision every rate on the card uses. */
export function pct(value: number): string {
  return value.toFixed(2);
}
