/**
 * Facts come from the SHAPE of a read, not from a list of capability names.
 *
 * ## The live failure this pins
 *
 * First signed-in battery, 11 Sep: `vanna_get_max_borrow` returned in 8.5s with
 * `max_borrow_human` present, the normalizer had no `case "max_borrow"`, and the user was
 * told "max borrow: no supported display fields were available". 13 Sep, same shape:
 * `farm_overview` and `collateral_config` — the data the prompt was about — read fine and
 * were discarded the same way. Twelve of the loop's twenty-six capabilities had no case.
 *
 * The handoff's acceptance test, verbatim: *"delete no MCP tool, add no case, and
 * `max_borrow` renders its number. Then point the loop at a capability that has never had
 * a branch and confirm it renders too."* Payloads below are real MCP responses captured
 * 13 Sep against the test account, trimmed only of addresses.
 */

import { describe, expect, it, vi } from "vitest";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import { extractFactsByShape } from "@/lib/copilot/investigation/facts-by-shape";
import type { Observation } from "@/lib/copilot/investigation/types";

const read = (capability: string, data: Observation["data"], args: Record<string, unknown> = {}): Observation => ({
  id: `obs-${capability}`, capability, args, observedAt: 1000, status: "ok", data,
});
const noFields = /no supported display fields/;
const fact = (result: ReturnType<typeof normalizeResearchFacts>, sourcePath: string) =>
  result.facts.find((f) => f.sourcePath === sourcePath);

describe("facts by shape — the reads that had no case", () => {
  it("renders max_borrow's number instead of reporting it unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = normalizeResearchFacts([read("max_borrow", {
      smart_account: "C…", symbol: "XLM", max_borrow_human: "0", max_borrow_wad: "0",
      method: "binary_search_is_borrow_allowed", note: "No positive borrow amount is allowed …",
    }, { asset: "XLM" })]);
    expect(fact(result, "max_borrow_human")).toMatchObject({ label: "XLM max borrow", value: "0", unit: "XLM", venue: "margin" });
    expect(fact(result, "max_borrow_wad")).toBeUndefined();
    expect(result.warnings.some((w) => noFields.test(w))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("renders a nested farm_overview: Blend positions, reserves and the Aquarius LP line", () => {
    const result = normalizeResearchFacts([read("farm_overview", {
      smart_account: "C…",
      blend: {
        positions: {
          venue: "blend", smart_account: "C…",
          positions: [
            { symbol: "XLM", tracking_symbol: "BLEND_XLM", b_token_balance: "8066.073944", b_token_raw: "80660739440", b_rate: "2.0069242", underlying_value: "16187.9989972030448", supply_apy_pct: "425.71", tracking_token: "CC4P…", reserve_error: null },
            { symbol: "USDC", tracking_symbol: "BLEND_USDC", b_token_balance: "829.5663882", b_token_raw: "8295663882", b_rate: "1.0561809", underlying_value: "876.17217449882538", supply_apy_pct: "0.91", tracking_token: "CC4P…", reserve_error: null },
          ],
          position_count: 2, total_underlying_approx: "17064.17117170187018", summary: "…", note: "…",
        },
        reserves: {
          venue: "blend", pool_address: "CCEB…", count: 2,
          reserves: [
            { venue: "blend", symbol: "XLM", pool_address: "CCEB…", asset_address: "CDLZ…", supply_apy_pct: "425.71", borrow_apy_pct: "697.48", supply_apr_pct: "168.6342", borrow_apr_pct: "208.2203", utilization_pct: "89.99", total_supply: "105370971.2271", total_borrow: "94820239.0997", b_rate: "2.0069242", decimals: 7, note: "…", summary: "…" },
          ],
          errors: [], summary: "Blend reserves: 2 ok.",
        },
      },
      aquarius_lp: {
        venue: "aquarius", smart_account: "C…", token_a: "XLM", token_b: "USDC", resolved: true, source: "tracking_token",
        tracking_symbol: "AQ_XLM_USDC", lp_shares_human: "0", lp_shares_raw: "0", decimals: 7, tracking_token: "CC4P…",
        tracking_shares_raw: "0", pool_address: null, pool_shares: null, pool_stats: null, apy: "0.30%", summary: "…", note: "…",
      },
      summary: "…", note: "…",
    })]);
    expect(result.warnings.some((w) => noFields.test(w))).toBe(false);
    expect(fact(result, "blend.positions.positions[0].underlying_value")).toMatchObject({ label: "XLM Blend underlying value", value: "16187.9989972030448", unit: "XLM", venue: "blend" });
    expect(fact(result, "blend.positions.positions[0].supply_apy_pct")).toMatchObject({ label: "XLM Blend supply APY", value: "425.71", unit: "% APY" });
    expect(fact(result, "blend.positions.positions[1].underlying_value")).toMatchObject({ label: "USDC Blend underlying value", unit: "USDC" });
    expect(fact(result, "blend.reserves.reserves[0].utilization_pct")).toMatchObject({ label: "XLM Blend utilization", value: "89.99", unit: "%" });
    expect(fact(result, "blend.reserves.reserves[0].total_supply")).toMatchObject({ unit: "XLM" });
    expect(fact(result, "aquarius_lp.lp_shares_human")).toMatchObject({ label: "XLM/USDC Aquarius LP shares", value: "0", unit: "AQ_XLM_USDC", venue: "aquarius" });
    expect(fact(result, "aquarius_lp.apy")).toMatchObject({ value: "0.30", unit: "% APY" });
    // Raw integers, addresses and counts are never facts.
    for (const path of ["blend.positions.positions[0].b_token_raw", "blend.positions.positions[0].tracking_token", "blend.reserves.count", "blend.positions.position_count", "aquarius_lp.lp_shares_raw", "aquarius_lp.decimals"]) {
      expect(fact(result, path), path).toBeUndefined();
    }
  });

  it("renders collateral_config's allowlist and cap", () => {
    const result = normalizeResearchFacts([read("collateral_config", {
      allowed_collateral: [{ symbol: "XLM", allowed: true }, { symbol: "BLUSDC", allowed: false }, { symbol: "AQUSDC", allowed: true }],
      max_distinct_collateral_assets: 10, max_distinct_collateral_assets_raw_wad: "10", per_asset_amount_cap: null, risk_params_note: "…",
    })]);
    expect(result.warnings.some((w) => noFields.test(w))).toBe(false);
    expect(fact(result, "allowed_collateral[0].allowed")).toMatchObject({ label: "XLM allowed collateral", value: "yes" });
    expect(fact(result, "allowed_collateral[1].allowed")).toMatchObject({ label: "BLUSDC allowed collateral", value: "no" });
    expect(fact(result, "max_distinct_collateral_assets")).toMatchObject({ value: "10", unit: "" });
    expect(fact(result, "max_distinct_collateral_assets_raw_wad")).toBeUndefined();
  });

  it("renders an Earn position in vTokens and its redeemable underlying in the asset", () => {
    const result = normalizeResearchFacts([read("earn_position", {
      holder: "G…", symbol: "AQUSDC", vtoken_symbol: "VAQUSDC", vtoken_address: "CAU5…", raw_native: "49182651397", decimals: 7,
      human: "4918.2651397", wad: "4918265139700000000000", balance_raw: "49182651397", balance_wad: "…", total_supply_raw: "130649665326",
      redeemable: "5000786863027758031020", redeemable_human: "5000.786863027758031020", redeem_hint: "…",
    }, { asset: "AQUSDC" })]);
    expect(fact(result, "human")).toMatchObject({ label: "AQUSDC Earn balance", value: "4918.2651397", unit: "VAQUSDC", venue: "earn" });
    expect(fact(result, "redeemable_human")).toMatchObject({ label: "AQUSDC Earn redeemable", value: "5000.786863027758031020", unit: "AQUSDC" });
    // The bare WAD `redeemable` has no unit the key can vouch for.
    expect(fact(result, "redeemable")).toBeUndefined();
  });

  it("names an Earn pool by the asset the read was for, not the venue's wire spelling (13 Sep: three 'USDC Earn' rates)", () => {
    // The pool answers `pool_symbol: "USDC"` for BLUSDC, AQUSDC and SOUSDC alike; the registry
    // records that spelling as each asset's `earnSymbol`, so the label carries the asset id.
    const result = normalizeResearchFacts([
      read("earn_market", { pool_symbol: "USDC", supply_apr_pct: "20.179294", borrow_apr_pct: "25.1", utilization_pct: "80.3" }, { asset: "AQUSDC" }),
      read("earn_market", { pool_symbol: "USDC", supply_apr_pct: "29.084267", borrow_apr_pct: "32.5", utilization_pct: "89.5" }, { asset: "BLUSDC" }),
    ]).facts;
    const labels = result.filter((f) => f.label.includes("supply APR")).map((f) => f.label).sort();
    expect(labels).toEqual(["AQUSDC Earn supply APR", "BLUSDC Earn supply APR"]);
  });

  it("renders a prices_batch keyed by symbol", () => {
    const result = normalizeResearchFacts([read("prices_batch", {
      prices: { XLM: { price_usd: "0.18085576397841", decimals: 14, price_wad: "180855763978410000" }, USDC: { price_usd: "1", decimals: 14, price_wad: "1000000000000000000" } },
      fetched: 2, requested: 3,
    })]);
    expect(fact(result, "prices.XLM.price_usd")).toMatchObject({ label: "XLM oracle price", value: "0.18085576397841", unit: "USD", venue: "oracle" });
    expect(fact(result, "prices.USDC.price_usd")).toMatchObject({ label: "USDC oracle price", unit: "USD" });
    expect(result.facts).toHaveLength(2);
  });

  it("renders a capability nobody has written a branch for, on a symbol nobody enumerated", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = normalizeResearchFacts([read("some_future_read", {
      symbol: "US-DC2", venue: "earn", supply_apr_pct: "3.5", depth_usd: "1000.25", is_stale: false, pool_address: "C…", duration_ms: 12,
    })]);
    expect(result.facts.map((f) => [f.label, f.value, f.unit])).toEqual([
      ["US-DC2 Earn supply APR", "3.5", "% APR"],
      ["US-DC2 Earn depth", "1000.25", "USD"],
      ["US-DC2 Earn stale", "no", ""],
    ]);
    expect(result.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("facts by shape — what is never a fact", () => {
  it("does not invent a unit for a bare number", () => {
    const { facts } = extractFactsByShape(read("x", { foo: "123", bar: 4.5, total: "99" }));
    expect(facts).toEqual([]);
  });

  it("skips raw and WAD integers, addresses, ids, notes, and durations", () => {
    const { facts } = extractFactsByShape(read("x", {
      amount_raw: "1", amount_wad: "1", pool_address: "C…", asset_id: "1", id: "7", note: "n", summary: "s", duration_ms: 3, price_usd: "1",
    }));
    expect(facts.map((f) => f.path)).toEqual(["price_usd"]);
  });

  it("honours a row's own <field>_untrusted flag", () => {
    const { facts } = extractFactsByShape(read("account_collateral", {
      collateral: [{ symbol: "AQ_XLM_USDC", balance: "0", value_usd: "0.0000", kind: "lp_tracking", balance_untrusted: true, warning: "tracking is not SEP-41 inventory" }],
    }));
    expect(facts.map((f) => f.path)).toEqual(["collateral[0].value_usd"]);
  });

  it("treats a non-ok row status as information, and only error/available:false as unavailable", () => {
    const result = normalizeResearchFacts([read("wallet_balances", {
      wallet: "G…",
      assets: [
        { symbol: "XLM", contract: null, source: "horizon_native", status: "ok", balance: "10206.8356118" },
        { symbol: "USDC", contract: null, source: "n/a", status: "not_resolvable", balance: null, message: "No separate plain-USDC SAC on this network." },
        { symbol: "XLM_SAC", contract: "CDLZ…", balance: "10206.8356118", decimals: 7, source: "soroban_sac", status: "ok", balance_raw: "102068356118" },
        { symbol: "AQUSDC", contract: "CAZR…", balance: "0.0000000", decimals: 7, source: "soroban_sac", status: "ok", balance_raw: "0" },
        { symbol: "EURC", contract: "CB…", error: "trustline_missing", message: "No EURC trustline on this wallet." },
      ],
      fee_reserve_xlm: "0.5", note: "…",
    })]);
    // The 13 Sep card said "wallet balances: some entries were unavailable" for the USDC line. It is not unavailable.
    expect(result.warnings).toEqual(["wallet balances: EURC was unavailable — No EURC trustline on this wallet."]);
    expect(result.facts.map((f) => [f.label, f.value, f.unit])).toEqual([
      ["XLM wallet balance", "10206.8356118", "XLM"],
      ["AQUSDC wallet balance", "0.0000000", "AQUSDC"],
      ["Wallet fee reserve", "0.5", "XLM"],
    ]);
  });

  it("names a top-level errors list without hiding the rest", () => {
    const result = normalizeResearchFacts([read("blend_markets", {
      reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "3", borrow_apr_pct: "5", utilization_pct: "80" }],
      errors: [{ symbol: "USDC", error: "reserve_unavailable" }],
    })]);
    expect(fact(result, "reserves[0].supply_apr_pct")).toMatchObject({ label: "XLM Blend supply APR", value: "3" });
    expect(result.warnings).toEqual(["blend markets: 1 entry could not be read; this is not a complete picture."]);
  });
});
