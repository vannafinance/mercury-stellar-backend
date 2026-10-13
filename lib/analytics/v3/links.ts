/**
 * Links to an account's own page and the breadcrumb trail that leads to it. The trail follows where
 * the visitor came from (`?from=`), so "back" always goes to the screen they were on.
 */
export type From = "overview" | "top" | "liquidations" | "alerts" | "positions" | "whatif";

const FROMS: readonly From[] = ["overview", "top", "liquidations", "alerts", "positions", "whatif"];
export const parseFrom = (v: string | string[] | undefined | null): From => {
  const s = Array.isArray(v) ? v[0] : v;
  return (FROMS as readonly string[]).includes(s ?? "") ? (s as From) : "overview";
};

/** `address` is the margin (smart) account `C…` address; an owner wallet `G…` works too (the page resolves either). */
export const accountHref = (address: string, from: From): string => `/analytics/accounts/${address}?from=${from}`;

export interface Crumb { label: string; href: string }

const TRAILS: Record<From, Crumb[]> = {
  overview: [{ label: "Overview", href: "/analytics" }, { label: "Accounts", href: "/analytics#accounts" }],
  top: [{ label: "Top accounts", href: "/analytics/top-accounts" }, { label: "Largest borrowers", href: "/analytics/top-accounts#borrowers" }],
  liquidations: [{ label: "Liquidations", href: "/analytics/liquidations" }],
  alerts: [{ label: "Alerts", href: "/analytics/alerts" }],
  positions: [{ label: "Positions", href: "/analytics/positions" }, { label: "Look up", href: "/analytics/positions" }],
  whatif: [{ label: "What-if Calculator", href: "/analytics/what-if" }],
};
export const trailFor = (from: From): Crumb[] => TRAILS[from];
