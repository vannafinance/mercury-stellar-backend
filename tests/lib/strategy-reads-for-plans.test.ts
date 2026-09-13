/**
 * Code fetches what code needs. 13 Sep live: "Supply idle XLM to Blend…" matched none of
 * the phrases that gate the market seed, no XLM price was read, and the plan was ruled
 * out for a missing price. The reads a plan needs are derived from its legs.
 */
import { describe, expect, it } from "vitest";
import { readsForPlans, STRATEGY_READS } from "@/lib/copilot/investigation/strategy-reads";
import { allAssets } from "@/lib/copilot/registry/assets";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const NOW = 1_000_000;
const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({ title: "t", rationale: "r", evidenceIds: [], legs });

describe("readsForPlans", () => {
  it("asks for the price, the wallet and the Blend reserves a deposit-then-supply plan needs", () => {
    const reads = readsForPlans([plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], [], NOW);
    expect(reads).toEqual(expect.arrayContaining([
      { capability: "asset_price", args: { asset: "XLM" } },
      { capability: "wallet_balances", args: {} },
      { capability: "blend_markets", args: {} },
      // The rate row pairs Blend with the asset's Earn market.
      { capability: "earn_market", args: { asset: "XLM" } },
    ]));
    expect(reads.some((r) => r.args.asset === "BLUSDC")).toBe(false);
  });

  it("asks for the Earn market of an asset that is lent or borrowed", () => {
    const reads = readsForPlans([plan([{ op: "borrow", asset: "BLUSDC", sizing: { kind: "to_floor" } }])], [], NOW);
    expect(reads).toEqual(expect.arrayContaining([{ capability: "earn_market", args: { asset: "BLUSDC" } }, { capability: "asset_price", args: { asset: "BLUSDC" } }]));
  });

  it("skips a read that is already fresh, and re-asks for one that is stale", () => {
    const fresh: Observation = { id: "e1", capability: "asset_price", args: { asset: "XLM" }, observedAt: NOW - 10_000, status: "ok", data: { price_usd: "0.18" } };
    const stale: Observation = { ...fresh, id: "e2", observedAt: NOW - 61_000 };
    const legs: ProposedPlan["legs"] = [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "1", sourceQuote: "lend 1 XLM" } }];
    expect(readsForPlans([plan(legs)], [fresh], NOW).some((r) => r.capability === "asset_price")).toBe(false);
    expect(readsForPlans([plan(legs)], [stale], NOW).some((r) => r.capability === "asset_price")).toBe(true);
  });

  it("derives the default strategy seed from the registry, not a list", () => {
    const earnAssets = allAssets().filter((a) => a.earnSymbol).map((a) => a.id);
    expect(earnAssets.length).toBeGreaterThan(0);
    for (const asset of earnAssets) {
      expect(STRATEGY_READS).toContainEqual({ capability: "earn_market", args: { asset } });
      expect(STRATEGY_READS).toContainEqual({ capability: "asset_price", args: { asset } });
    }
  });
});
