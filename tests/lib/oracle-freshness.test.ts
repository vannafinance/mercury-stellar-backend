import { describe, expect, it } from "vitest";
import { normalizeOracleFreshness } from "@/lib/copilot/oracle-freshness";
import { extractFactsByShape } from "@/lib/copilot/investigation/facts-by-shape";

describe("legacy oracle freshness", () => {
  it("does not claim a timestamp-less legacy price is fresh", () => {
    const data = normalizeOracleFreshness({ symbol: "XLM", price_usd: "0.23", is_stale: false });
    expect(data).toMatchObject({ price_usd: "0.23", is_stale: null, freshness: "unknown" });
    const result = extractFactsByShape({ id: "e1", capability: "asset_price", args: { asset: "XLM" }, data, status: "ok", observedAt: Date.now() });
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "XLM oracle freshness", value: "unknown" }));
    expect(result.facts.some(f => f.label.includes("stale") && f.value === "no")).toBe(false);
  });

  it("handles batch rows, null or future timestamps without altering the original result", () => {
    const data = { prices: { XLM: { price_usd: "0.23", is_stale: false, timestamp: null }, USDC: { price_usd: "0.99", is_stale: false, timestamp: Math.floor(Date.now() / 1000) + 100 } } };
    expect(normalizeOracleFreshness(data)).toMatchObject({ prices: { XLM: { freshness: "unknown" }, USDC: { freshness: "unknown" } } });
    expect(data.prices.XLM.is_stale).toBe(false);
  });

  it("preserves timestamped status and an explicit stale warning", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(normalizeOracleFreshness({ price_usd: "0.23", timestamp: now, is_stale: false })).toEqual({ price_usd: "0.23", timestamp: now, is_stale: false });
    expect(normalizeOracleFreshness({ price_usd: "0.23", is_stale: true }).is_stale).toBe(true);
    expect(normalizeOracleFreshness({ balance: "10" })).toEqual({ balance: "10" });
  });
});
