import type { Observation } from "./types";
import { isRecord } from "./decision";
import { decimalWad, formatWad, WAD } from "./fixed";

export interface RateComparison {
  asset: "XLM" | "BLUSDC";
  earnSupplyApr: string | null;
  blendSupplyApr: string;
  marginBorrowApr: string;
  spreadApr: string;
  verdict: "cost_exceeds_supply" | "no_spread" | "positive_before_costs";
  evidenceIds: string[];
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
  for (const asset of ["XLM", "BLUSDC"] as const) {
    const earn = fresh.filter((o) => o.capability === "earn_market" && o.args.asset === asset);
    const blend = fresh.filter((o) => o.capability === "blend_markets").flatMap((o) => {
      const reserves = o.data?.reserves;
      return Array.isArray(reserves) ? reserves.filter((r) => isRecord(r) && !r.error && r.available !== false &&
        (r.status === undefined || r.status === "ok") && r.venue === "blend" &&
        r.symbol === (asset === "BLUSDC" ? "USDC" : "XLM")).map((row) => ({ observation: o, row })) : [];
    });
    // Conflicting duplicates are not a license to choose whichever rate looks best.
    if (earn.length !== 1 || blend.length !== 1) continue;
    const supply = rate(blend[0].row.supply_apr_pct);
    const borrow = rate(earn[0].data?.borrow_apr_pct);
    const earnSupply = rate(earn[0].data?.supply_apr_pct ?? earn[0].data?.supply_apy_pct);
    if (supply === null || borrow === null) continue;
    const spread = supply - borrow;
    results.push({ asset, earnSupplyApr: earnSupply === null ? null : formatWad(earnSupply),
      blendSupplyApr: formatWad(supply), marginBorrowApr: formatWad(borrow), spreadApr: formatWad(spread),
      verdict: spread < BigInt(0) ? "cost_exceeds_supply" : spread === BigInt(0) ? "no_spread" : "positive_before_costs",
      evidenceIds: [earn[0].id, blend[0].observation.id],
    });
  }
  return results;
}
