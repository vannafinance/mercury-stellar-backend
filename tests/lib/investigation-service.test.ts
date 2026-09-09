import { describe, expect, it, vi } from "vitest";
import { researchTurn } from "@/lib/copilot/investigation/service";
import type { GoalUnderstanding } from "@/lib/copilot/investigation/types";

describe("investigation to deterministic comparison", () => {
  it.each(["allowed", "forbidden"] as const)("publishes comparisons according to borrowing scope: %s", async (borrowing: GoalUnderstanding["borrowing"]) => {
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_list_my_wallet_bindings") return { sub: "user", has_assertion: true, bindings: [] };
      if (tool === "vanna_get_pool_stats") return { supply_apy_pct: "2", borrow_apr_pct: "7" };
      if (tool === "vanna_list_blend_reserves") return { reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "3", supply_apy_pct: "3.04" }] };
      throw new Error("Unexpected tool");
    }) };
    let turn = 0;
    const result = await researchTurn({ message: "Compare XLM options", wallet: null, continuation: null }, {
      subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp, signal: new AbortController().signal,
      model: async () => turn++ === 0 ? { kind: "inspect", reads: [{ capability: "earn_market", args: { asset: "XLM" } }, { capability: "blend_markets", args: {} }] }
        : { kind: "research_complete", goal: { objective: "Compare XLM options", constraints: [], borrowing },
          findings: [{ summary: "Rates were read", evidenceIds: ["e1", "e2"] }], openQuestions: [] },
    });
    // Comparing supply venues remains useful when borrowing is forbidden; only the
    // borrowing candidate is gated, not the evidence used for a debt-free option.
    expect(result.rateComparisons).toHaveLength(1);
    expect(result.executionAllowed).toBe(false);
    if (borrowing === "allowed") expect(result.rateComparisons?.[0]).toMatchObject({ spreadApr: "-4", verdict: "cost_exceeds_supply" });
  });
});
