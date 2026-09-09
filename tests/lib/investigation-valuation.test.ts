import { describe, expect, it } from "vitest";
import fixture from "@/docs/copilot/risk-engine-live-fixture.json";
import { valueCollateral, type CollateralPosition } from "@/lib/copilot/investigation/valuation";
import { decimalWad, formatWad, WAD } from "@/lib/copilot/investigation/fixed";

describe("collateral valuation", () => {
  it("reproduces the deployed contract total from one ledger's independent reads", () => {
    const rows = fixture.account.valuationReads;
    expect(new Set(rows.map((row) => row.ledger)).size).toBe(1);
    expect(rows.every((row) => row.error === null)).toBe(true);
    const get = (method: string, symbol?: string): unknown => rows.find((row) => row.method === method &&
      (symbol === undefined || "symbol" in row && row.symbol === symbol))?.value;
    const price = (symbol: string) => {
      const [value, decimals] = get("get_price_latest", symbol) as [string, number];
      return String(BigInt(value) * WAD / BigInt(10) ** BigInt(decimals));
    };
    const positions: CollateralPosition[] = ["XLM", "USDC", "AQUSDC", "SOUSDC"].map((symbol) => ({
      kind: "recorded", symbol: symbol as "XLM" | "USDC" | "AQUSDC" | "SOUSDC",
      balanceWad: String(get("get_collateral_token_balance", symbol)), priceWad: price(symbol === "XLM" ? "XLM" : "USDC"),
    }));
    const reserve = get("get_reserve") as { data: { b_rate: string } };
    positions.push({ kind: "blend_receipt", symbol: "BLEND_USDC", trackingBalance: String(get("balance")),
      bRate: reserve.data.b_rate, underlyingDecimals: Number(get("decimals")), priceWad: price("USDC") });
    expect(get("get_collateral_token_balance", "BLEND_USDC")).toBe("0");
    expect(valueCollateral(positions).balanceWad).toBe(get("get_current_total_balance"));
    // Debt is not another collateral position in the total-balance read.
    expect(BigInt(String(get("get_current_total_borrows")))).toBeGreaterThan(BigInt(0));
  });
  it("preserves the two Blend truncations before pricing", () => {
    const value = valueCollateral([{ kind: "blend_receipt", symbol: "BLEND_XLM", trackingBalance: "3",
      bRate: "1500000000001", underlyingDecimals: 7, priceWad: String(WAD) }]);
    expect(value.balanceWad).toBe("400000000000");
  });
  it("rejects duplicate USDC aliases without collapsing distinct USDC assets", () => {
    const position = { kind: "recorded" as const, symbol: "USDC" as const, balanceWad: String(WAD), priceWad: String(WAD) };
    expect(() => valueCollateral([position, { ...position, symbol: "BLUSDC" }])).toThrow("duplicate");
    expect(valueCollateral([position, { ...position, symbol: "AQUSDC" }]).balanceWad).toBe(String(BigInt(2) * WAD));
  });
  it("does not price an LP or unknown token at one dollar", () => {
    for (const symbol of ["AQ_XLM_USDC", "SS_XLM_USDC", "UNKNOWN"]) expect(() => valueCollateral([
      { kind: "recorded", symbol, balanceWad: String(WAD), priceWad: String(WAD) } as CollateralPosition,
    ])).toThrow("unsupported");
  });
  it("rejects unavailable prices and invalid receipt rates", () => {
    expect(() => valueCollateral([{ kind: "recorded", symbol: "XLM", balanceWad: "1", priceWad: "0" }])).toThrow("missing_price");
    expect(() => valueCollateral([{ kind: "blend_receipt", symbol: "BLEND_XLM", trackingBalance: "1",
      bRate: "0", underlyingDecimals: 7, priceWad: String(WAD) }])).toThrow("missing_exchange_rate");
  });
  it("keeps decimal precision and rejects scientific notation and overflow", () => {
    expect(formatWad(decimalWad("1.300000000000000001"))).toBe("1.300000000000000001");
    expect(() => decimalWad("1e18")).toThrow();
    expect(() => valueCollateral([{ kind: "recorded", symbol: "XLM", balanceWad: String((BigInt(1) << BigInt(256)) - BigInt(1)), priceWad: "2" }])).toThrow("overflow");
  });
});
