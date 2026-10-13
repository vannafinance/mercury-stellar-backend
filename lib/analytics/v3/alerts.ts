/**
 * Alerts derived live from data the dashboard already has (accounts snapshot, lending pools, Reflector
 * prices, the connected wallet's own account) - nothing stored, nothing simulated, and no notification
 * channels (there is no delivery integration, so none is claimed).
 *
 * Priorities: P0 act now · P1 critical · P2 warning · P3 for information.
 */
import { DISPLAY_BANDS, LIQUIDATION_LINE, type AccountRow, type AccountsSummary } from "./model";
import type { PoolRow } from "./pools";
import { usd } from "./format";
import { accountHref } from "./links";

export type Priority = "P0" | "P1" | "P2" | "P3";
export interface Alert { id: string; priority: Priority; title: string; detail: string; metric: string; link?: string; yours?: boolean }

export const UTILIZATION_WARN = 0.85;
export const UTILIZATION_CRITICAL = 0.95;

export function deriveAlerts(input: {
  summary: AccountsSummary | null;
  pools: PoolRow[];
  /** Assets the Reflector oracle returned no usable price for on the latest read. */
  missingPrices: string[];
  you: AccountRow | null;
  serviceError: string | null;
}): Alert[] {
  const out: Alert[] = [];
  const { summary: s, pools, you } = input;

  if (input.serviceError) out.push({ id: "service", priority: "P1", title: "Soroban RPC or the analytics service can't be reached", detail: `Numbers on this page may be out of date until it is back. (${input.serviceError})`, metric: "Service" });

  if (you) {
    if (you.liquidatable) out.push({ id: "you-liq", priority: "P0", yours: true, title: "Your account can be liquidated now", detail: `Health ${you.healthFactor?.toFixed(2)} is at or below the liquidation line (${LIQUIDATION_LINE.toFixed(2)}).`, metric: "Health", link: accountHref(you.address, "alerts") });
    else if (you.healthFactor !== null && you.healthFactor <= DISPLAY_BANDS.critical) out.push({ id: "you-crit", priority: "P1", yours: true, title: "Your account is close to liquidation", detail: `Health ${you.healthFactor.toFixed(2)} - the liquidation line is ${LIQUIDATION_LINE.toFixed(2)}.`, metric: "Health", link: accountHref(you.address, "alerts") });
    else if (you.healthFactor !== null && you.healthFactor < DISPLAY_BANDS.warning) out.push({ id: "you-warn", priority: "P2", yours: true, title: "Your account health is getting low", detail: `Health ${you.healthFactor.toFixed(2)} (below ${DISPLAY_BANDS.warning.toFixed(2)}).`, metric: "Health", link: accountHref(you.address, "alerts") });
  }

  if (s && s.total > 0) {
    if (s.liquidatableCount > 0) out.push({ id: "liq", priority: "P1", title: `${s.liquidatableCount} account${s.liquidatableCount === 1 ? "" : "s"} can be liquidated now`, detail: `${usd(s.liquidatableDebtUsd)} of debt is backed by ${usd(s.liquidatableCollateralUsd)} of collateral.`, metric: "Liquidations", link: "/analytics?filter=liquidatable#accounts" });
    if (s.badDebtUsd > 0) out.push({ id: "bad", priority: "P1", title: "Some debt is no longer covered by collateral", detail: `${usd(s.badDebtUsd)} estimated across ${s.underwaterCount} account${s.underwaterCount === 1 ? "" : "s"}.`, metric: "Bad debt", link: "/analytics/liquidations" });
    const warnOnly = s.atRiskCount - s.liquidatableCount;
    if (warnOnly > 0) out.push({ id: "risk", priority: "P2", title: `${warnOnly} of ${s.total} account${s.total === 1 ? " is" : "s are"} close to the liquidation line`, detail: `Health is under ${DISPLAY_BANDS.warning.toFixed(2)} (liquidation at ${LIQUIDATION_LINE.toFixed(2)}); ${usd(s.atRiskCollateralUsd - s.liquidatableCollateralUsd)} of collateral. View lists them.`, metric: "Accounts at risk", link: "/analytics?filter=atrisk#accounts" });
  }

  if (input.missingPrices.length) {
    const lending = pools.map((p) => p.symbol);
    const lend = input.missingPrices.filter((sym) => lending.includes(sym));
    const rest = input.missingPrices.filter((sym) => !lending.includes(sym));
    if (lend.length) out.push({ id: "prices-lend", priority: "P1", title: `No live price: ${lend.join(", ")}`, detail: "The Reflector feed did not return a usable price. The Risk Engine blocks borrows and withdrawals that need it.", metric: "Prices", link: "/analytics/prices" });
    if (rest.length) out.push({ id: "prices-other", priority: "P2", title: `No live price: ${rest.join(", ")}`, detail: "The Reflector feed did not return a usable price for these assets on the latest read.", metric: "Prices", link: "/analytics/prices" });
  }
  for (const pool of pools) {
    if (pool.utilization >= UTILIZATION_CRITICAL) out.push({ id: `util-${pool.symbol}`, priority: "P1", title: `${pool.symbol} pool is almost fully borrowed`, detail: `${(pool.utilization * 100).toFixed(1)}% utilization - little cash is left to withdraw and the borrow rate is near its top.`, metric: "Utilization", link: "/analytics/pools" });
    else if (pool.utilization >= UTILIZATION_WARN) out.push({ id: `util-${pool.symbol}`, priority: "P2", title: `${pool.symbol} pool utilization is high`, detail: `${(pool.utilization * 100).toFixed(1)}% of the pool is borrowed.`, metric: "Utilization", link: "/analytics/pools" });
  }

  const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}
