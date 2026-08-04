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
function parts(label: string) {
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
  return { verb, nums, assets, venue };
}

export function legKey(label: string): string {
  const { verb, nums, assets, venue } = parts(label);
  return [verb, nums, assets, venue].join("|");
}

/**
 * Identity ignoring the amount, for reconciling a leg with its own resolved self.
 *
 * A leg whose amount was unknown is labelled "Borrow XLM"; once the user supplies the
 * size, the executor relabels it "Borrow 15 XLM". Those are the same leg, but `legKey`
 * hashes the amount, so the resolved copy was appended as a NEW leg — leaving the original
 * frozen on "paused · needs input" with its question still open, a duplicate reporting
 * settled, a leg count inflated from 4 to 5, and a restarted server index that renumbered
 * step 2 as step 1.
 *
 * Only ever used one way: to match an amount-LESS leg to an amount-BEARING one. Two legs
 * that both carry amounts are never compared loosely, so "Borrow 15 XLM" can still not be
 * confused with "Borrow 20 XLM".
 */
export function legKeyLoose(label: string): string {
  const { verb, assets, venue } = parts(label);
  return [verb, assets, venue].join("|");
}

/** True when the label states a size, i.e. this leg's amount is already resolved. */
export function labelHasAmount(label: string): boolean {
  return parts(label).nums.length > 0;
}

const USDC_VARIANTS = new Set(["BLUSDC", "AQUSDC", "SOUSDC"]);

/**
 * True when `resolved` is the same leg as `ambiguous` after the user picked a USDC variant.
 *
 * A paused leg is labelled "Lend 125 USDC on Earn"; once the user picks AQUSDC the
 * executor returns "Lend 125 AQUSDC on Earn". Exact and amount-loose keys both differ
 * (assets changed), so without this check the resolved leg was appended as a duplicate
 * while the original stayed frozen on "paused · needs input".
 *
 * Only bare USDC → one concrete variant. Two concrete variants never match each other.
 */
export function isUsdcVariantResolution(ambiguousLabel: string, resolvedLabel: string): boolean {
  const a = parts(ambiguousLabel);
  const r = parts(resolvedLabel);
  if (a.verb !== r.verb || a.nums !== r.nums || a.venue !== r.venue) return false;
  if (a.assets !== "USDC") return false;
  return USDC_VARIANTS.has(r.assets);
}
