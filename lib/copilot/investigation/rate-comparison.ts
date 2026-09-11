import type { Observation } from "./types";
import { isRecord } from "./decision";
import { decimalWad, formatWad, WAD } from "./fixed";

export type RateAsset = "XLM" | "BLUSDC" | "AQUSDC" | "SOUSDC";

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

const RATE_ASSETS: readonly RateAsset[] = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"];

function blendReserveSymbol(asset: RateAsset): string | null {
  if (asset === "XLM") return "XLM";
  if (asset === "BLUSDC") return "USDC";
  return null;
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

/** Same token + same simple APR convention; never subtract APY from APR. */
export function compareObservedRates(observations: readonly Observation[], now: number): RateComparison[] {
  const fresh = observations.filter((o) => o.status === "ok" && o.data && Number.isFinite(o.observedAt) &&
    o.observedAt <= now && now - o.observedAt <= 60_000);
  const rate = (value: unknown): bigint | null => {
    try {
      // Existing MCP Blend rates are numbers; reject exponent notation or non-finite.
      const result = decimalWad(typeof value === "number" && Number.isFinite(value) ? String(value) : value);
      // 100% APR is already implausible for these pools. Blend XLM has reported
      // 366% from a decimals bug; treating that as a real rate would rank it first.
      return result <= BigInt(100) * WAD ? result : null;
    } catch { return null; }
  };
  const results: RateComparison[] = [];
  for (const asset of RATE_ASSETS) {
    const earn = fresh.filter((o) => o.capability === "earn_market" && o.args.asset === asset);
    const blendSymbol = blendReserveSymbol(asset);
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
    const earnSupply = earnUnique.length === 1 ? rate(earnUnique[0].data?.supply_apr_pct ?? earnUnique[0].data?.supply_apy_pct) : null;
    const earnBorrow = earnUnique.length === 1 ? rate(earnUnique[0].data?.borrow_apr_pct) : null;
    const blendSupply = blendUnique.length === 1 ? rate(blendUnique[0].row.supply_apr_pct) : null;
    if (blendSymbol) {
      // Blend-listed tokens keep the old gate: both venues must be uniquely readable.
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
    // AQUSDC / SOUSDC: Earn pool only. Never attach Blend's USDC reserve.
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
  return results;
}
