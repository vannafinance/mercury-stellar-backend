/**
 * Identity for a strategy leg, stable across planning and execution.
 *
 * Legs arrive with only a human label, and the planner and the executor word it
 * differently — "Deposit 10 BLUSDC as collateral" becomes "Deposit 10 BLUSDC
 * collateral". Merging on the raw label therefore appended a duplicate instead of
 * updating, which left the original leg frozen at needs_sign while a second copy of it
 * reported done. Keying on the parts that actually identify the action survives the
 * rewording. Venue is only included for supply/deploy, where the same verb, amount and
 * asset can legitimately mean two different legs (earn pool vs Blend); for other verbs
 * it would wrongly split "Lend 20 XLM on Earn" from "Lend 20 XLM".
 *
 * Shared by the session log and the strategy card so they can never disagree again.
 */
export function legKey(label: string): string {
  const s = (label || "").toLowerCase();
  const verb = s.match(/^[a-z_]+/)?.[0] ?? "";
  const nums = (s.match(/\d+(?:\.\d+)?/g) ?? []).join(",");
  const assets = (
    (label || "").match(/\b(?:BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC|USDT)\b/g) ?? []
  ).join(",");
  const ambiguousVerb = verb === "supply" || verb === "deploy";
  const venue = !ambiguousVerb
    ? ""
    : /blend/.test(s)
      ? "blend"
      : /aquarius|soroswap|\blp\b/.test(s)
        ? "lp"
        : /earn|pool/.test(s)
          ? "earn"
          : "";
  return [verb, nums, assets, venue].join("|");
}
