/**
 * Token precision is the protocol's number, read per token — never a default. The Notion
 * reference lists the USDC family at 6 places; the deployed SACs report 7. The chain wins.
 */
import { describe, expect, it } from "vitest";
import { decimalsFrom, truncateToDecimals } from "@/lib/copilot/investigation/precision";
import type { Observation } from "@/lib/copilot/investigation/types";

const obs = (capability: string, data: Record<string, unknown>): Observation => ({ id: capability, capability, args: {}, observedAt: 1, status: "ok", data });

describe("decimalsFrom — a price's precision is not a token's", () => {
  it("ignores `decimals` on an oracle price row and keeps the SAC's (13 Sep: XLM repay cut to 14 places)", () => {
    const now = 1_700_000_000_000;
    const read = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}) =>
      ({ id, capability, args, data, status: "ok" as const, observedAt: now });
    const map = decimalsFrom([
      read("e1", "asset_price", { symbol: "XLM", price_usd: "0.178", price_wad: "178336092932010000", decimals: 14 }, { asset: "XLM" }),
      read("e2", "wallet_balances", { assets: [{ symbol: "XLM_SAC", balance: "9999.88", decimals: 7 }] }),
    ]);
    expect(map.get("XLM")).toBe(7);
    // Only the price read: nothing is known about the token's precision, so nothing is guessed.
    expect(decimalsFrom([read("e1", "asset_price", { symbol: "XLM", price_usd: "0.178", decimals: 14 }, { asset: "XLM" })]).get("XLM")).toBeUndefined();
  });

  it("keeps the coarsest precision when two token reads disagree", () => {
    const now = 1_700_000_000_000;
    const read = (id: string, capability: string, data: Record<string, unknown>) => ({ id, capability, args: {}, data, status: "ok" as const, observedAt: now });
    const map = decimalsFrom([
      read("e1", "wallet_balances", { assets: [{ symbol: "AQUSDC", balance: "1", decimals: 7 }] }),
      read("e2", "earn_position", { symbol: "AQUSDC", human: "1", decimals: 18 }),
    ]);
    expect(map.get("AQUSDC")).toBe(7);
  });
});

describe("decimalsFrom", () => {
  it("collects every token's decimals from the reads, letting XLM_SAC speak for native XLM", () => {
    const map = decimalsFrom([
      obs("wallet_balances", { assets: [
        { symbol: "XLM", balance: "1", status: "ok" },
        { symbol: "XLM_SAC", balance: "1", decimals: 7, status: "ok" },
        { symbol: "AQUSDC", balance: "0", decimals: 7, status: "ok" },
      ] }),
      obs("earn_position", { symbol: "BLUSDC", vtoken_symbol: "VBLUSDC", decimals: 7, human: "1" }),
      obs("blend_markets", { reserves: [{ symbol: "USDC", decimals: 7, total_supply: "129251.65" }] }),
    ]);
    expect(Object.fromEntries(map)).toEqual({ XLM: 7, XLM_SAC: 7, AQUSDC: 7, BLUSDC: 7, VBLUSDC: 7, USDC: 7 });
  });
  it("ignores failed reads and nonsense decimals", () => {
    const map = decimalsFrom([
      { ...obs("wallet_balances", { assets: [{ symbol: "XLM", decimals: 7 }] }), status: "error" },
      obs("wallet_balances", { assets: [{ symbol: "EURC", decimals: "many" }, { symbol: "AQUA", decimals: 99 }] }),
    ]);
    expect(map.size).toBe(0);
  });
});

describe("truncateToDecimals", () => {
  it("cuts, never rounds, and drops trailing zeros", () => {
    expect(truncateToDecimals("5000.948562526353068375", 7)).toBe("5000.9485625");
    expect(truncateToDecimals("5000.786863027758031020", 6)).toBe("5000.786863");
    expect(truncateToDecimals("720.0000000", 7)).toBe("720");
    expect(truncateToDecimals("1.99999999", 0)).toBe("1");
  });
});
