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

describe("readsForPlans — a swap is valued on both sides", () => {
  it("asks for the price of the asset it buys as well as the one it spends", () => {
    /**
     * 15 Sep, live: "swap 10 XLM to AqUSDC" was refused with "no BLUSDC price was read this
     * investigation" on the earlier pair — the plan fetched a price for the asset it spent
     * and none for the asset it bought, so the leg could never be valued.
     */
    const reads = readsForPlans([plan([
      { op: "swap", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "literal", amount: "10", sourceQuote: "swap 10 XLM to AqUSDC" } },
    ])], [], NOW);
    const priced = reads.filter((read) => read.capability === "asset_price").map((read) => read.args.asset).sort();
    expect(priced).toEqual(["AQUSDC", "XLM"]);
  });
});

describe("readsForPlans — a share reads the base it is a share of", () => {
  it("of=idle wants the wallet; of=position wants the position the op spends", () => {
    const idle = readsForPlans([plan([{ op: "lend", asset: "XLM", sizing: { kind: "fraction", percent: "25", of: "idle", sourceQuote: "25% of xlm" } }])], [], NOW);
    expect(idle.map((r) => r.capability)).toContain("wallet_balances");
    expect(idle.map((r) => r.capability)).toContain("account_collateral");
    const redeem = readsForPlans([plan([{ op: "redeem", asset: "AQUSDC", sizing: { kind: "fraction", percent: "50", of: "position", sourceQuote: "half" } }])], [], NOW);
    expect(redeem.map((r) => r.capability)).toContain("earn_position");
    const withdraw = readsForPlans([plan([{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "fraction", percent: "10", of: "position", sourceQuote: "10%" } }])], [], NOW);
    expect(withdraw.map((r) => r.capability)).toContain("account_collateral");
  });
});

describe("readsForPlans — a repay reads the debt whatever its sizing word", () => {
  it("asks for account_debt on an all_idle repay", () => {
    const reads = readsForPlans([plan([{ op: "repay", asset: "XLM", sizing: { kind: "all_idle" } }])], [], NOW);
    expect(reads.map((r) => r.capability)).toEqual(expect.arrayContaining(["account_debt", "wallet_balances"]));
  });
});

describe("readsForPlans — literal position exits", () => {
  it("asks for Blend position evidence before sizing a literal withdrawal", () => {
    const reads = readsForPlans([plan([{
      op: "blend_withdraw",
      asset: "XLM",
      sizing: { kind: "literal", amount: "26000", sourceQuote: "remove 26k XLM from Blend" },
    }])], [], NOW);
    expect(reads).toContainEqual({ capability: "blend_position", args: {} });
  });
});

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
