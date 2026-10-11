import { describe, expect, it } from "vitest";
import { lpExitUsd } from "@/lib/copilot/investigation/plan";
import { readsForPlans } from "@/lib/copilot/investigation/strategy-reads";
import { lpPairs } from "@/lib/copilot/registry/assets";
import type { Observation } from "@/lib/copilot/investigation/types";

/**
 * 23 Sep, X12: the Farm exit option read "Amount $0.00" because both LP legs carried no
 * value. Leaving an LP position is worth the shares' slice of each reserve.
 */
const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
// Whatever pair the registry declares first; nothing here names a token by hand.
const [pair] = lpPairs();
const [base, quote] = pair.tokens;
const reservesCapability = pair.venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves";
const pool = obs("r1", reservesCapability, {
  found: true,
  pool: { reserves: { [base]: "1000", USDC: "200" }, total_share: "100", fee: "0.003", reserves_source: "ledger" },
}, { asset: quote });
const prices = [
  obs("p1", "asset_price", { price_usd: "0.2" }, { asset: base }),
  obs("p2", "asset_price", { price_usd: "1" }, { asset: quote }),
];

describe("an LP exit is valued from the pool", () => {
  it("prices the shares' slice of both reserves", () => {
    // 10 of 100 shares = 10%: 100 base × $0.2 + 20 quote × $1 = $40.
    expect(Number(lpExitUsd([pool, ...prices], quote, "10", NOW))).toBeCloseTo(40, 6);
  });

  it("stays unvalued when the pool was not read, as before", () => {
    expect(lpExitUsd(prices, quote, "10", NOW)).toBeNull();
  });

  it("stays unvalued when a price is missing", () => {
    expect(lpExitUsd([pool, prices[0]], quote, "10", NOW)).toBeNull();
  });

  it("asks for the pool read when a plan leaves an LP position", () => {
    const reads = readsForPlans([{ title: "Exit LP", rationale: "r", evidenceIds: [], legs: [
      { op: "remove_liquidity", asset: quote, sizing: { kind: "all_position" } },
    ] }], [], NOW);
    expect(reads).toContainEqual({ capability: reservesCapability, args: { asset: quote } });
  });
});
