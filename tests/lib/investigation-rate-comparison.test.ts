import { describe, expect, it } from "vitest";
import { analyseObservedRates, compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import type { Observation } from "@/lib/copilot/investigation/types";

const now = 100_000;
/** Every fixture carries borrow rate and utilization, as the MCP does: a supply rate is only usable when it can be checked against them. */
const earn = (data: Record<string, unknown> = { borrow_apr_pct: "7", supply_apy_pct: "2", utilization_pct: "40" }): Observation => ({
  id: "e1", capability: "earn_market", args: { asset: "XLM" }, observedAt: now, status: "ok", data,
});
const blend = (row: Record<string, unknown> = {}): Observation => ({
  id: "e2", capability: "blend_markets", args: {}, observedAt: now, status: "ok", data: {
    reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "3.123456789", supply_apy_pct: "99", borrow_apr_pct: "10", utilization_pct: "80", ...row }],
  },
});

describe("evidence-based borrowing economics", () => {
  it("compares simple APRs and preserves exact difference and sources", () => {
    expect(compareObservedRates([earn(), blend()], now)).toEqual([{
      asset: "XLM", earnSupplyApr: "2", blendSupplyApr: "3.123456789", marginBorrowApr: "7",
      spreadApr: "-3.876543211", verdict: "cost_exceeds_supply", evidenceIds: ["e1", "e2"],
    }]);
  });
  it.each([["7", "no_spread"], ["7.000000000000000001", "positive_before_costs"]])("classifies %s without inventing net profit", (value, verdict) => {
    expect(compareObservedRates([earn(), blend({ supply_apr_pct: value })], now)[0].verdict).toBe(verdict);
  });
  it("does not compare APR to APY when the simple APR is missing", () => {
    expect(compareObservedRates([earn(), blend({ supply_apr_pct: undefined })], now)).toEqual([]);
  });
  it("maps Blend's USDC to BLUSDC, and allows earn-only AQUSDC without attaching that reserve", () => {
    expect(compareObservedRates([{ ...earn(), args: { asset: "BLUSDC" } }, blend({ symbol: "USDC" })], now)[0].asset).toBe("BLUSDC");
    const aqusdc = compareObservedRates([{ ...earn(), args: { asset: "AQUSDC" } }, blend({ symbol: "USDC" })], now);
    expect(aqusdc).toEqual([{
      asset: "AQUSDC",
      earnSupplyApr: "2",
      blendSupplyApr: null,
      marginBorrowApr: "7",
      spreadApr: null,
      verdict: "earn_only",
      evidenceIds: ["e1"],
    }]);
  });
  it("rejects failed, stale, future and conflicting duplicate reads", () => {
    for (const bad of [{ ...earn(), status: "error" as const }, { ...earn(), observedAt: now - 60_001 }, { ...earn(), observedAt: now + 1 }]) {
      expect(compareObservedRates([bad, blend()], now)).toEqual([]);
    }
    expect(compareObservedRates([
      earn(),
      { ...earn(), id: "e3", data: { borrow_apr_pct: "9", supply_apy_pct: "2", utilization_pct: "40" } },
      blend(),
    ], now)).toEqual([]);
    expect(compareObservedRates([earn(), blend(), blend({ supply_apr_pct: "8" })], now)).toEqual([]);
  });

  it("collapses identical copies of the same read so a seed plus a loop fulfill still compares", () => {
    expect(compareObservedRates([earn(), { ...earn(), id: "e9" }, blend(), { ...blend(), id: "e8" }], now)).toHaveLength(1);
  });
  it.each([{ error: "unavailable" }, { venue: "earn" }, { supply_apr_pct: "NaN" }, { supply_apr_pct: -1 }])("rejects unusable reserve %o", (row) => {
    expect(compareObservedRates([earn(), blend(row)], now)).toEqual([]);
  });

  /**
   * Plausibility comes from the read itself, not from a size cap. Suppliers can never be
   * shown earning more than borrowers pay (borrow × utilization); anything else is used as
   * read, however large. The old 100% ceiling silently dropped a real 168% testnet rate.
   */
  describe("supply rates are checked against borrow × utilization, not against a cap", () => {
    it("uses the real 90%-utilised testnet Blend XLM rate that the old cap threw away", () => {
      const live = { supply_apr_pct: "168.6154", borrow_apr_pct: "208.2050", utilization_pct: "89.98" };
      const rows = compareObservedRates([earn(), blend(live)], now);
      expect(rows).toHaveLength(1);
      expect(rows[0].blendSupplyApr).toBe("168.6154");
      expect(analyseObservedRates([earn(), blend(live)], now).excluded).toEqual([]);
    });
    it("uses any size of rate that its own read supports", () => {
      // 1001% supply on a pool whose borrowers pay 1200% at 95% utilization is internally consistent.
      const rows = compareObservedRates([earn(), blend({ supply_apr_pct: "1001", borrow_apr_pct: "1200", utilization_pct: "95" })], now);
      expect(rows[0]?.blendSupplyApr).toBe("1001");
    });
    it("excludes a supply rate that exceeds what borrowers pay, and says so with the numbers", () => {
      // The 366% decimals slip: borrowers were paying 4.5% at 80% utilization.
      const slipped = blend({ supply_apr_pct: "366.53", borrow_apr_pct: "4.5", utilization_pct: "80" });
      const analysis = analyseObservedRates([earn(), slipped], now);
      expect(analysis.comparisons).toEqual([]);
      expect(analysis.excluded).toEqual([{
        asset: "XLM", venue: "blend", reason: "inconsistent", evidenceId: "e2",
        detail: "Blend XLM: supply 366.53% APR exceeds what borrowers pay (4.5% × 80% utilization = 3.6%), so it was not used. Check the venue directly.",
      }]);
    });
    it("excludes a supply rate it cannot cross-check, loudly rather than silently", () => {
      const bare = blend({ borrow_apr_pct: undefined, utilization_pct: undefined });
      const analysis = analyseObservedRates([earn(), bare], now);
      expect(analysis.comparisons).toEqual([]);
      expect(analysis.excluded[0]).toMatchObject({ asset: "XLM", venue: "blend", reason: "not_cross_checkable" });
      expect(analysis.excluded[0].detail).toContain("3.123456789% APR");
    });
    it("allows rounding slack but not a factor of ten", () => {
      // 10% × 80% = 8%: 8.007 is inside 0.1% slack; 8.01 is not.
      expect(compareObservedRates([earn(), blend({ supply_apr_pct: "8.007" })], now)).toHaveLength(1);
      expect(compareObservedRates([earn(), blend({ supply_apr_pct: "8.01" })], now)).toEqual([]);
    });
    it("reports an excluded Earn supply rate without dropping the borrow comparison", () => {
      // Earn's borrow rate is what the borrow shape needs; its supply rate is only for the idle path.
      const analysis = analyseObservedRates([earn({ borrow_apr_pct: "7", supply_apy_pct: "50", utilization_pct: "40" }), blend()], now);
      expect(analysis.comparisons[0]).toMatchObject({ asset: "XLM", earnSupplyApr: null, marginBorrowApr: "7", blendSupplyApr: "3.123456789" });
      expect(analysis.excluded[0]).toMatchObject({ venue: "earn", reason: "inconsistent" });
    });
    it("never uses Blend's compounded APY in place of a missing APR", () => {
      const analysis = analyseObservedRates([earn(), blend({ supply_apr_pct: undefined })], now);
      expect(analysis.comparisons).toEqual([]);
      expect(analysis.excluded[0]).toMatchObject({ venue: "blend", reason: "unparsable" });
    });
  });
});
