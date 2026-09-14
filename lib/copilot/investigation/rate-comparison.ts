import type { Observation } from "./types";
import { isRecord } from "./decision";
import { decimalWad, formatWad, WAD } from "./fixed";
import { ASSET_IDS, resolveAssetDef, type AssetId } from "../registry/assets";

export type RateAsset = AssetId;

export interface RateComparison {
  asset: RateAsset;
  earnSupplyApr: string | null;
  /** Null when this token has no Blend reserve (AQUSDC / SOUSDC). */
  blendSupplyApr: string | null;
  marginBorrowApr: string | null;
  spreadApr: string | null;
  verdict: "cost_exceeds_supply" | "no_spread" | "positive_before_costs" | "earn_only";
  evidenceIds: string[];
}

/**
 * A supply rate that was read but not used, and why — so the card can say so. A rate
 * that vanishes silently leaves the model's prose and the ranked options disagreeing,
 * which is exactly what the first signed-in battery showed with Blend XLM.
 */
export interface ExcludedRate {
  asset: RateAsset;
  venue: "earn" | "blend";
  reason: "unparsable" | "not_cross_checkable" | "inconsistent";
  /** One sentence for the card. Names the numbers so the user can check the venue themselves. */
  detail: string;
  evidenceId: string;
}

export interface RateAnalysis {
  comparisons: RateComparison[];
  excluded: ExcludedRate[];
}

/**
 * Rounding slack for the supply-vs-borrow cross-check. The MCP rounds percentages to
 * four to six decimals, which moves the product by well under 0.1%; a decimals bug
 * moves it by a factor of ten or more.
 */
const CROSS_CHECK_TOLERANCE = decimalWad("1.001");

/** Blend's own symbol for an asset it holds a reserve for (BLUSDC is USDC on the wire), from the registry. */
function blendReserveSymbol(asset: RateAsset): string | null {
  const def = resolveAssetDef(asset);
  return def?.blendReserve ? (def.marginSymbol ?? def.id) : null;
}

/** Identical copies (seed + loop fulfill) collapse; disagreeing copies are a conflict. */
function dedupeBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  if (rows.length <= 1) return [...rows];
  const groups = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!groups.has(id)) groups.set(id, row);
  }
  return [...groups.values()];
}

/** Parse a percentage as read. Rejects exponent notation, non-finite and negative values. */
function rate(value: unknown): bigint | null {
  try {
    // Existing MCP Blend rates are numbers; reject exponent notation or non-finite.
    return decimalWad(typeof value === "number" && Number.isFinite(value) ? String(value) : value);
  } catch { return null; }
}

/**
 * A supply rate is used only when the same read shows where it comes from: suppliers
 * receive a share of what borrowers pay, scaled by utilization, and never more than all
 * of it. That relationship holds on every lending venue whatever its fee take, and it
 * is the check that distinguishes a real 168% APR on a 90%-utilised testnet pool from a
 * 366% one produced by a decimals slip. A size cap cannot tell those apart — the old
 * 100% ceiling silently threw away the real one.
 *
 * A row that does not carry the borrow rate and utilization cannot be vouched for, so it
 * is excluded too — loudly, with the reason, never silently.
 */
function supplyRateOf(row: Record<string, unknown> | undefined, supplyRaw: unknown, label: string):
  { ok: true; supply: bigint } | { ok: false; reason: ExcludedRate["reason"]; detail: string } {
  const supply = rate(supplyRaw);
  if (supply === null) {
    return { ok: false, reason: "unparsable", detail: `${label}: the supply rate ${JSON.stringify(supplyRaw ?? null)} could not be read as a percentage. No rate was assumed.` };
  }
  const borrow = rate(row?.borrow_apr_pct);
  const utilization = rate(row?.utilization_pct);
  if (borrow === null || utilization === null) {
    return { ok: false, reason: "not_cross_checkable", detail: `${label}: supply ${formatWad(supply)}% APR was read without a borrow rate and utilization to check it against, so it was not used.` };
  }
  // borrow% × utilization% / 100 — what borrowers pay per unit supplied, before any take.
  const ceiling = (borrow * utilization) / (BigInt(100) * WAD);
  const bound = (ceiling * CROSS_CHECK_TOLERANCE) / WAD;
  if (supply > bound) {
    return { ok: false, reason: "inconsistent", detail: `${label}: supply ${formatWad(supply)}% APR exceeds what borrowers pay (${formatWad(borrow)}% × ${formatWad(utilization)}% utilization = ${formatWad(ceiling)}%), so it was not used. Check the venue directly.` };
  }
  return { ok: true, supply };
}

/** Same token + same simple APR convention; never subtract APY from APR. */
export function compareObservedRates(observations: readonly Observation[], now: number): RateComparison[] {
  return analyseObservedRates(observations, now).comparisons;
}

export function analyseObservedRates(observations: readonly Observation[], now: number): RateAnalysis {
  const fresh = observations.filter((o) => o.status === "ok" && o.data && Number.isFinite(o.observedAt) &&
    o.observedAt <= now && now - o.observedAt <= 60_000);
  const results: RateComparison[] = [];
  const excluded: ExcludedRate[] = [];
  // Every registry asset whose Earn market was read this investigation — no separate list of "rate assets".
  const assets = ASSET_IDS.filter((asset) => fresh.some((o) => o.capability === "earn_market" && o.args.asset === asset));
  for (const asset of assets) {
    const earn = fresh.filter((o) => o.capability === "earn_market" && o.args.asset === asset);
    const blendSymbol = blendReserveSymbol(asset);
    const blendRead = fresh.some((o) => o.capability === "blend_markets");
    const blend = blendSymbol ? fresh.filter((o) => o.capability === "blend_markets").flatMap((o) => {
      const reserves = o.data?.reserves;
      return Array.isArray(reserves) ? reserves.filter((r) => isRecord(r) && !r.error && r.available !== false &&
        (r.status === undefined || r.status === "ok") && r.venue === "blend" &&
        r.symbol === blendSymbol).map((row) => ({ observation: o, row })) : [];
    }) : [];
    const earnRows = dedupeBy(earn, (o) => JSON.stringify([
      o.data?.supply_apr_pct, o.data?.supply_apy_pct, o.data?.borrow_apr_pct,
    ]));
    const blendRows = dedupeBy(blend, (row) => JSON.stringify([
      row.row.supply_apr_pct, row.row.supply_apy_pct, row.row.symbol,
    ]));
    // Conflicting duplicates are not a license to choose whichever rate looks best.
    if (earn.length > 1 && earnRows.length !== 1) continue;
    if (blend.length > 1 && blendRows.length !== 1) continue;
    const earnUnique = earnRows;
    const blendUnique = blendRows;
    /**
     * Supply rates pass the cross-check or are excluded with a reason. Earn's supply rate
     * is optional for Blend-listed tokens (the borrow shape only needs Earn's borrow rate),
     * so an excluded Earn supply is reported but does not drop the row.
     */
    let earnSupply: bigint | null = null;
    if (earnUnique.length === 1) {
      // Earn's APY field is the simple APR under an older name; Blend's APY is compounded.
      const checked = supplyRateOf(earnUnique[0].data ?? undefined, earnUnique[0].data?.supply_apr_pct ?? earnUnique[0].data?.supply_apy_pct, `Earn ${asset}`);
      if (checked.ok) earnSupply = checked.supply;
      else excluded.push({ asset, venue: "earn", reason: checked.reason, detail: checked.detail, evidenceId: earnUnique[0].id });
    }
    const earnBorrow = earnUnique.length === 1 ? rate(earnUnique[0].data?.borrow_apr_pct) : null;
    let blendSupply: bigint | null = null;
    if (blendUnique.length === 1) {
      const checked = supplyRateOf(blendUnique[0].row, blendUnique[0].row.supply_apr_pct, `Blend ${blendSymbol}`);
      if (checked.ok) blendSupply = checked.supply;
      else excluded.push({ asset, venue: "blend", reason: checked.reason, detail: checked.detail, evidenceId: blendUnique[0].observation.id });
    }
    if (blendSymbol && blendRead) {
      // Blend was read: both venues must be uniquely readable, or the asset gets no row.
      if (earnUnique.length !== 1 || blendUnique.length !== 1 || blendSupply === null || earnBorrow === null) continue;
      const spread = blendSupply - earnBorrow;
      results.push({
        asset,
        earnSupplyApr: earnSupply === null ? null : formatWad(earnSupply),
        blendSupplyApr: formatWad(blendSupply),
        marginBorrowApr: formatWad(earnBorrow),
        spreadApr: formatWad(spread),
        verdict: spread < BigInt(0) ? "cost_exceeds_supply" : spread === BigInt(0) ? "no_spread" : "positive_before_costs",
        evidenceIds: [earnUnique[0].id, blendUnique[0].observation.id],
      });
      continue;
    }
    /**
     * Earn only: AQUSDC / SOUSDC have no Blend reserve, and a Blend-listed token whose Blend
     * market was NOT read this investigation still has an Earn rate. Until 14 Sep the second
     * case produced no row at all, so a plain lend of XLM — which fetches only earn_market —
     * was refused for "no usable Earn supply rate". A Blend market that WAS read but whose
     * reserve is unusable keeps the gate above: an excluded reserve is not quietly forgotten.
     */
    if (earnUnique.length !== 1 || earnSupply === null) continue;
    results.push({
      asset,
      earnSupplyApr: formatWad(earnSupply),
      blendSupplyApr: null,
      marginBorrowApr: earnBorrow === null ? null : formatWad(earnBorrow),
      spreadApr: null,
      verdict: "earn_only",
      evidenceIds: [earnUnique[0].id],
    });
  }
  return { comparisons: results, excluded };
}
