/**
 * A pool that the registry does not list is not a venue option.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/copilot/registry/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/registry/assets")>();
  return {
    ...actual,
    lpPairs: () => actual.lpPairs().filter((pair) => pair.venue !== "soroswap"),
  };
});

import { buildQuestionnaire } from "@/lib/copilot/investigation/questionnaire";
import type { Observation } from "@/lib/copilot/investigation/types";

const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });

describe("an LP venue disappears when the registry has no such pool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not offer the Soroswap pool once lpPairs drops it", () => {
    const built = buildQuestionnaire({ asset: "XLM", slots: ["venue"] }, [
      obs("w", "wallet_balances", { assets: [{ symbol: "XLM", balance: "50", decimals: 7, status: "ok" }] }),
      obs("a", "account_collateral", { collateral: [{ symbol: "XLM", balance: "40" }] }),
      obs("e", "earn_market", { supply_apr_pct: "3" }, { asset: "XLM" }),
      obs("b", "blend_markets", { reserves: [{ symbol: "XLM", supply_apr_pct: "12" }] }),
      obs("r", "aquarius_pool_reserves", {
        found: true,
        pool: { available: true, reserves: { XLM: "1000", USDC: "200" }, total_share: "100", fee: "0.003", reserves_source: "ledger" },
      }, { asset: "AQUSDC" }),
    ], NOW);
    const ids = built?.steps.find((step) => step.slot === "venue")?.options.map((option) => option.id);
    expect(ids).toContain("lend");
    expect(ids).toContain("supply_blend");
    expect(ids).toContain("add_liquidity:aquarius");
    expect(ids).not.toContain("add_liquidity:soroswap");
  });
});