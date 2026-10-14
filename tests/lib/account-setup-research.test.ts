import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/copilot/investigation/capacity", async (original) => ({
  ...await original<typeof import("@/lib/copilot/investigation/capacity")>(),
  computeAccountPosition: vi.fn(async () => ({ grossCollateralUsd: "0", debtUsd: "0", healthFactor: null,
    snapshot: { grossCollateralValue: 0, totalBorrowedValue: 0, collateralBalances: {}, borrowedBalances: {} } })),
  computeBorrowCapacity: vi.fn(async () => null),
  computeSizingBasis: vi.fn(async () => ({ grossCollateralUsd: "0", debtUsd: "0", source: "contract", issue: null,
    app: { grossCollateralUsd: "0", debtUsd: "0" }, contract: { grossCollateralUsd: "0", debtUsd: "0" } })),
}));
vi.mock("@/lib/account-snapshot", async (original) => ({
  ...await original<typeof import("@/lib/account-snapshot")>(),
  computeMarginSnapshot: vi.fn(async () => null),
}));
import { researchTurn } from "@/lib/copilot/investigation/service";
import { resetInvestigationScopeCache } from "@/lib/copilot/investigation/scope";
import { accountSetupRequest } from "@/lib/copilot/account-setup-continuation";

describe("research after a required account is created", () => {
  it("rediscovers the account and prepares the unchanged request with fresh scope, without submitting it", async () => {
    resetInvestigationScopeCache();
    const wallet = "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA";
    const account = "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC";
    const message = "Deposit 5 XLM";
    let created = false;
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_resolve_account") return created ? { status: "found_on_chain", smart_account: account } : { status: "required", smart_account: null };
      if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "XLM", balance: "100", decimals: 7, status: "ok" }, { symbol: "XLM_SAC", balance: "100", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" };
      if (tool === "vanna_get_price") return { price_usd: "0.2" };
      return {};
    }) };
    const deps = {
      subject: `stellar:${wallet}`, server: "setup-test", network: "testnet", secret: "a".repeat(32),
      mcp, signal: new AbortController().signal,
      model: async () => ({ kind: "research_complete" as const,
        goal: { intent: "strategy" as const, objective: message, constraints: [], borrowing: "forbidden" as const,
          actions: [{ op: "deposit_collateral" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "5", sourceQuote: message }, sourceQuote: message }] },
        findings: [{ summary: "Prepare the requested collateral deposit.", evidenceIds: [] }], openQuestions: [],
      }),
    };
    const before = await researchTurn({ message, wallet, continuation: null }, deps);
    expect(before.scope.smartAccount).toBeNull();
    expect(before.choices?.some(choice => choice.write === "create_account")).toBe(true);
    created = true;
    const request = accountSetupRequest({ wallet, conversationId: "chat", request: before.originalRequest, setupRequestId: "setup" },
      { wallet, conversationId: "chat", setupRequestId: "setup", operation: "create_account", cancelled: false, settled: true });
    expect(request).toBe(message);
    const after = await researchTurn({ message: request!, wallet, continuation: before.continuation }, deps);
    expect(after.scope.smartAccount).toBe(account);
    expect(after.choices?.some(choice => choice.write === "create_account")).not.toBe(true);
    expect(after.message).toContain("Deposit 5 XLM");
    expect(after.proposalCandidateId).toBeTruthy();
    expect(mcp.call.mock.calls.filter(([tool]) => tool === "vanna_resolve_account")).toHaveLength(2);
    expect(mcp.call.mock.calls.some(([tool]) => tool.includes("submit") || tool.includes("unsigned") || tool === "vanna_create_account")).toBe(false);
  });
});
