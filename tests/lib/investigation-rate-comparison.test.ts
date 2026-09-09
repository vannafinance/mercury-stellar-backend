import { describe, expect, it } from "vitest";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import type { Observation } from "@/lib/copilot/investigation/types";

const now = 100_000;
const earn = (data = { borrow_apr_pct: "7", supply_apy_pct: "2" }): Observation => ({
  id: "e1", capability: "earn_market", args: { asset: "XLM" }, observedAt: now, status: "ok", data,
});
const blend = (row: Record<string, unknown> = {}): Observation => ({
  id: "e2", capability: "blend_markets", args: {}, observedAt: now, status: "ok", data: {
    reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "3.123456789", supply_apy_pct: "99", ...row }],
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
  it("maps Blend's USDC to BLUSDC but never AQUSDC", () => {
    expect(compareObservedRates([{ ...earn(), args: { asset: "BLUSDC" } }, blend({ symbol: "USDC" })], now)[0].asset).toBe("BLUSDC");
    expect(compareObservedRates([{ ...earn(), args: { asset: "AQUSDC" } }, blend({ symbol: "USDC" })], now)).toEqual([]);
  });
  it("rejects failed, stale, future and conflicting duplicate reads", () => {
    for (const bad of [{ ...earn(), status: "error" as const }, { ...earn(), observedAt: now - 60_001 }, { ...earn(), observedAt: now + 1 }]) {
      expect(compareObservedRates([bad, blend()], now)).toEqual([]);
    }
    expect(compareObservedRates([earn(), earn(), blend()], now)).toEqual([]);
    expect(compareObservedRates([earn(), blend(), blend()], now)).toEqual([]);
  });
  it.each([{ error: "unavailable" }, { venue: "earn" }, { supply_apr_pct: "NaN" }, { supply_apr_pct: -1 }, { supply_apr_pct: "1001" }, { supply_apr_pct: "366.53" }])("rejects unusable reserve %o", (row) => {
    expect(compareObservedRates([earn(), blend(row)], now)).toEqual([]);
  });
});
