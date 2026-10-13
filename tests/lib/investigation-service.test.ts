import { describe, expect, it, vi } from "vitest";
import { researchTurn } from "@/lib/copilot/investigation/service";
import type { GoalUnderstanding } from "@/lib/copilot/investigation/types";

describe("investigation to deterministic comparison", () => {
  it("hands a quoted signing-policy request to the settings form without granting or invoking writes", async () => {
    const message = "use $0.10 per transaction and $5000 per day";
    const signingPolicy = { action: "configure" as const, mode: "custom" as const, unit: "testnet_usd" as const, maxPerTx: "0.10", maxPerDay: "5000", sourceQuote: message };
    const mcp = { call: vi.fn(async (_tool: string) => ({ sub: "user", has_assertion: true, bindings: [] })) };
    const result = await researchTurn({ message, wallet: null, continuation: null }, {
      subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp, signal: new AbortController().signal,
      model: async () => ({ kind: "research_complete", goal: { intent: "answer", objective: "Review requested limits", constraints: [], borrowing: "unspecified", signingPolicy },
        findings: [{ summary: "Review the requested limits before applying them.", evidenceIds: [] }], openQuestions: [] }),
    });
    expect(result.signingPolicy).toEqual(signingPolicy);
    expect(result.executionAllowed).toBe(false);
    expect(result.proposalCandidateId).toBeFalsy();
    expect(result.pendingWrite).toBeNull();
    expect(mcp.call.mock.calls.every(([tool]) => tool !== "vanna_enable_auto_sign" && tool !== "vanna_disable_auto_sign")).toBe(true);
  });
  it.each(["allowed", "forbidden"] as const)("publishes comparisons according to borrowing scope: %s", async (borrowing: GoalUnderstanding["borrowing"]) => {
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_list_my_wallet_bindings") return { sub: "user", has_assertion: true, bindings: [] };
      if (tool === "vanna_get_pool_stats") return { supply_apy_pct: "2", borrow_apr_pct: "7", utilization_pct: "40" };
      if (tool === "vanna_list_blend_reserves") return { reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "3", supply_apy_pct: "3.04", borrow_apr_pct: "5", utilization_pct: "80" }] };
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
    expect(result.rateComparisons?.some((row) => row.asset === "XLM")).toBe(true);
    expect(result.executionAllowed).toBe(false);
    if (borrowing === "allowed") {
      expect(result.rateComparisons?.find((row) => row.asset === "XLM")).toMatchObject({
        spreadApr: "-4", verdict: "cost_exceeds_supply",
      });
    }
  });
});
