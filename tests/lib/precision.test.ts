/**
 * Token precision is the protocol's number, read per token — never a default. The Notion
 * reference lists the USDC family at 6 places; the deployed SACs report 7. The chain wins.
 */
import { describe, expect, it } from "vitest";
import { decimalsFrom, truncateToDecimals } from "@/lib/copilot/investigation/precision";
import type { Observation } from "@/lib/copilot/investigation/types";

const obs = (capability: string, data: Record<string, unknown>): Observation => ({ id: capability, capability, args: {}, observedAt: 1, status: "ok", data });

describe("decimalsFrom", () => {
  it("collects every token's decimals from the reads, letting XLM_SAC speak for native XLM", () => {
    const map = decimalsFrom([
      obs("wallet_balances", { assets: [
        { symbol: "XLM", balance: "1", status: "ok" },
        { symbol: "XLM_SAC", balance: "1", decimals: 7, status: "ok" },
        { symbol: "AQUSDC", balance: "0", decimals: 7, status: "ok" },
      ] }),
      obs("earn_position", { symbol: "BLUSDC", vtoken_symbol: "VBLUSDC", decimals: 7, human: "1" }),
      obs("blend_markets", { reserves: [{ symbol: "USDC", decimals: 7 }] }),
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
