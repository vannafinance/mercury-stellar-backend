import type { MarginSnapshot } from "./capacity";
import type { Observation } from "./types";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";

/** Display only. The original MCP observations remain the sizing/execution evidence. */
export function accountDisplayObservations(observations: readonly Observation[], snapshot: MarginSnapshot | null, observedAt: number): Observation[] {
  if (!snapshot || snapshot.debtDataIncomplete) return observations.map((observation) => {
    if (observation.status !== "ok" || observation.capability !== "account_collateral" || !Array.isArray(observation.data?.collateral)) return observation;
    const { collateral, ...data } = observation.data;
    return { ...observation, data: { ...data, posted_storage_collateral: collateral } };
  });
  return observations.map((observation) => {
    if (observation.status !== "ok") return observation;
    if (observation.capability === "account_debt") {
      return { ...observation, id: `margin-display:${observation.id}`, observedAt, data: {
        debt: Object.entries(snapshot.borrowedBalances).map(([symbol, balance]) => ({ symbol, balance: balance.amount, value_usd: balance.usdValue })),
        total_debt_usd: String(snapshot.totalBorrowedValue),
      } };
    }
    if (observation.capability !== "account_collateral") return observation;
    // "Collateral deposited" is the Margin page's own figure and heading: each token's balance minus
    // the debt in that same token. The copilot shows what the page shows (owner ruling), with debt
    // as its own list above. Farm receipts are left out, as the page leaves them out.
    const rows = Object.entries(snapshot.collateralBalances).flatMap(([symbol, balance]) => {
      if (isTrackingSymbol(symbol)) return [];
      const debt = snapshot.borrowedBalances[symbol];
      const amount = Math.max(0, Number(balance.amount) - Number(debt?.amount ?? 0));
      const value = Math.max(0, Number(balance.usdValue) - Number(debt?.usdValue ?? 0));
      if (!Number.isFinite(amount) || !Number.isFinite(value)) return [];
      return amount > 0 ? [{ symbol, balance: String(amount), value_usd: String(value), balance_basis: "collateral_deposited" }] : [];
    });
    return { ...observation, id: `margin-display:${observation.id}`, observedAt, data: {
      collateral_deposited: rows,
      total_collateral_deposited_usd: String(rows.reduce((sum, row) => sum + Number(row.value_usd), 0)),
    } };
  });
}
