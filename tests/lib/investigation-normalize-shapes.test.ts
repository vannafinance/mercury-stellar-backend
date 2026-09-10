import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import type { Observation } from "@/lib/copilot/investigation/types";

/**
 * Live MCP shapes captured 10 Sep 2026 from vanna_margin_status / vanna_margin_trade
 * against CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ. A future field
 * rename that yields zero facts must fail here instead of warning in the UI.
 */

const observation = (capability: string, data: Observation["data"], over: Partial<Observation> = {}): Observation => ({
  id: capability, capability, args: { asset: "XLM", amount: "100" }, observedAt: 1000, status: "ok", data, ...over,
});

const LIVE_HEALTH = {
  smart_account: "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ",
  collateral_usd: "3057.557637281663922307",
  debt_usd: "1654.529899784728773937",
  ltv_ratio: "0.5411279511498257171680552683",
  is_healthy: true,
  distance_to_liquidation: "0.3678720488501742828319447317",
  borrow_threshold: "0.909",
  liquidation_threshold: "0.909",
};

const LIVE_COLLATERAL = {
  smart_account: "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ",
  collateral: [
    { symbol: "XLM", balance: "10936.410599397146497012", price_usd: "0.18015553045686", value_usd: "1970.2549" },
    { symbol: "USDC", balance: "350.0493229", price_usd: "1.00020818891093", value_usd: "350.1222" },
    {
      symbol: "AQ_XLM_USDC", balance: "0", price_usd: "0", value_usd: "0.0000",
      kind: "lp_tracking", warning: "tracking is not SEP-41 inventory", balance_untrusted: true,
    },
  ],
  total_value_usd: "2913.8182",
  lp_note: "Do not trust a lone tracking balance of 0 as proof of no LP.",
};

const LIVE_DEBT = {
  smart_account: "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ",
  debt: [
    { symbol: "USDC", balance: "256.643415367171011754", price_usd: "1.00020818891093", value_usd: "256.6968" },
    { symbol: "XLM", balance: "7621.408548113238317667", price_usd: "0.18015553045686", value_usd: "1373.0389" },
  ],
  total_debt_usd: "1654.5299",
};

const LIVE_CAN_WITHDRAW = {
  allowed: true,
  smart_account: "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ",
  symbol: "XLM",
  amount: "100",
  reason: "Withdrawal of 100 XLM is permitted by the risk engine.",
};

const noDisplayWarning = /no supported display fields were available/;

describe("normalizeResearchFacts live MCP shapes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts facts from a live account_health payload that has no health_factor", () => {
    const result = normalizeResearchFacts([observation("account_health", LIVE_HEALTH)]);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
    expect(result.facts.some((fact) => fact.unit === "HF")).toBe(false);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "collateral_usd", unit: "USD" }),
      expect.objectContaining({ sourcePath: "debt_usd", unit: "USD" }),
      expect.objectContaining({ sourcePath: "is_healthy", value: "healthy" }),
      expect.objectContaining({ sourcePath: "distance_to_liquidation" }),
    ]));
  });

  it("extracts facts from a live account_collateral payload including LP tracking rows", () => {
    const result = normalizeResearchFacts([observation("account_collateral", LIVE_COLLATERAL)]);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "total_value_usd", value: "2913.8182" }),
      expect.objectContaining({ label: "XLM collateral value", value: "1970.2549" }),
    ]));
  });

  it("extracts facts from a live account_debt payload", () => {
    const result = normalizeResearchFacts([observation("account_debt", LIVE_DEBT)]);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "total_debt_usd", value: "1654.5299" }),
      expect.objectContaining({ label: "XLM borrowed" }),
    ]));
  });

  it("extracts a can_withdraw fact from the live preflight payload", () => {
    const result = normalizeResearchFacts([observation("can_withdraw", LIVE_CAN_WITHDRAW)]);
    expect(result.facts).toEqual([expect.objectContaining({
      label: "withdraw 100 XLM", value: "allowed", sourcePath: "allowed",
    })]);
    expect(result.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
  });

  it("accepts allowed as a string boolean from a wrapped envelope", () => {
    const result = normalizeResearchFacts([observation("can_withdraw", { allowed: "true", symbol: "XLM", amount: "100" })]);
    expect(result.facts).toEqual([expect.objectContaining({
      label: "withdraw 100 XLM", value: "allowed", sourcePath: "allowed",
    })]);
  });

  it("extracts liquidation_snapshot collateral and debt without synthesizing a health factor", () => {
    const result = normalizeResearchFacts([observation("liquidation_snapshot", {
      smart_account: "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ",
      collateral_usd: "4230.94",
      debt_usd: "2705.60",
      liquidatable: false,
      source: "risk_engine.liquidation_snapshot",
    })]);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Contract liquidation collateral", value: "4230.94", unit: "USD" }),
      expect.objectContaining({ label: "Contract liquidation debt", value: "2705.60", unit: "USD" }),
      expect.objectContaining({ label: "Liquidation snapshot flag", value: "not liquidatable" }),
    ]));
    expect(result.facts.some((fact) => fact.unit === "HF" || fact.sourcePath === "health_factor")).toBe(false);
    expect(result.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
  });

  it("still accepts the mock MCP aliases amount_human/usd without totals", () => {
    const collateral = normalizeResearchFacts([observation("account_collateral", {
      collateral: [{ symbol: "USDC", amount_human: "100", usd: 100 }],
    })]);
    const debt = normalizeResearchFacts([observation("account_debt", {
      debt: [{ symbol: "USDC", amount_human: "40", usd: 40 }],
    })]);
    expect(collateral.facts.length).toBeGreaterThan(0);
    expect(debt.facts.length).toBeGreaterThan(0);
    expect(collateral.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
    expect(debt.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(false);
  });

  it("logs keys only when a successful read yields zero facts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = normalizeResearchFacts([observation("account_health", { smart_account: "C_ONLY" })]);
    expect(result.facts).toEqual([]);
    expect(result.warnings.some((warning) => noDisplayWarning.test(warning))).toBe(true);
    expect(warn).toHaveBeenCalledWith("[copilot] investigation fact extract", expect.objectContaining({
      capability: "account_health",
      status: "ok",
      kind: "no_fields",
      keys: ["smart_account"],
    }));
    const logged = warn.mock.calls[0]?.[1] as { keys: string[] };
    expect(logged).not.toHaveProperty("smart_account");
  });

  it("logs capability, status, error and keys for a failed can_withdraw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    normalizeResearchFacts([observation("can_withdraw", { error: "contract_error", message: "rpc failed" }, {
      status: "error",
      error: "MCP returned unavailable or failed data; do not use it as a financial fact.",
    })]);
    expect(warn).toHaveBeenCalledWith("[copilot] investigation fact extract", expect.objectContaining({
      capability: "can_withdraw",
      status: "error",
      kind: "unavailable",
      keys: ["error", "message"],
    }));
  });
});
