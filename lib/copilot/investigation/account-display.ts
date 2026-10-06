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
    // Balances are shown gross, with debt as its own figure (above). Subtracting a token's debt from
    // that token's balance is wrong once a borrow has been swapped: the proceeds then sit in another
    // token and read as a deposit, while the borrowed token's row disappears.
    const rows = Object.entries(snapshot.collateralBalances).flatMap(([symbol, balance]) => {
      if (isTrackingSymbol(symbol)) return [];
      const amount = Number(balance.amount);
      const value = Number(balance.usdValue);
      if (!Number.isFinite(amount) || !Number.isFinite(value) || amount <= 0) return [];
      return [{ symbol, balance: balance.amount, value_usd: balance.usdValue, balance_basis: "gross_balance_before_debt" }];
    });
    return { ...observation, id: `margin-display:${observation.id}`, observedAt, data: {
      balances_before_debt: rows,
      total_balances_before_debt_usd: String(rows.reduce((sum, row) => sum + Number(row.value_usd), 0)),
    } };
  });
}
