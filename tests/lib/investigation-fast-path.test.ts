import { afterEach, describe, expect, it, vi } from "vitest";
import { matchFastPath, fastPathView, healthObservations, parseWithdrawCheck, postedHealthFactorFromSnapshot, pageDebtAgreesWithContract } from "@/lib/copilot/investigation/fast-path";
import { routeMessage } from "@/lib/copilot/router";
import { STANDING_ORDER_OFFER } from "@/lib/copilot/standing-orders";
import { resetTokenUsage } from "@/lib/copilot/token-budget";

const mocks = vi.hoisted(() => ({
  resolveInvestigationScope: vi.fn(),
  computeAccountPosition: vi.fn(),
  computeBorrowCapacity: vi.fn(),
}));

vi.mock("@/lib/copilot/investigation/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/scope")>();
  return { ...actual, resolveInvestigationScope: mocks.resolveInvestigationScope };
});

vi.mock("@/lib/copilot/investigation/capacity", () => ({
  computeAccountPosition: mocks.computeAccountPosition,
  computeBorrowCapacity: mocks.computeBorrowCapacity,
}));

const { researchTurn } = await import("@/lib/copilot/investigation/service");

const SCOPE = {
  subject: "user",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};

const deps = (over: {
  mcp?: { call: (tool: string, args: Record<string, unknown>, userId?: string) => Promise<Record<string, unknown>> };
  model?: (turn: unknown) => Promise<unknown>;
}) => ({
  subject: "user",
  server: "mcp-test",
  network: "testnet",
  secret: "a".repeat(32),
  mcp: over.mcp ?? { call: vi.fn(async () => { throw new Error("MCP should not run"); }) },
  model: over.model ?? (async () => { throw new Error("model should not run"); }),
  signal: new AbortController().signal,
});

afterEach(() => {
  vi.clearAllMocks();
  resetTokenUsage();
});

describe("matchFastPath", () => {
  it("matches a health-factor read and not a write mixed into the same sentence", () => {
    expect(matchFastPath("what's my health factor?")).toEqual({ kind: "health" });
    expect(matchFastPath("hey what's my health factor")).toEqual({ kind: "health" });
    expect(matchFastPath("am I safe")).toEqual({ kind: "health" });
    expect(matchFastPath("what's my health factor and can I borrow 50")).toBeNull();
    expect(matchFastPath("repay 1 xlm from my account")).toBeNull();
    expect(matchFastPath("repay 1 XLM")).toBeNull();
  });

  it("matches a single canonical asset price and refuses bare USDC", () => {
    expect(matchFastPath("price of XLM")).toEqual({ kind: "price", asset: "XLM" });
    expect(matchFastPath("what's USDC trading at")).toBeNull();
    expect(matchFastPath("price of XLM then borrow")).toBeNull();
  });

  it("does not treat a withdraw eligibility question as a health fast-path", () => {
    expect(matchFastPath("can I withdraw 100 XLM without getting liquidated?")).toBeNull();
  });
});

describe("routeMessage read-through cache", () => {
  it("returns the same health and price templates the investigation cache would", () => {
    expect(routeMessage("what's my health factor?")).toMatchObject({
      kind: "read",
      template_id: "query_account_health",
    });
    expect(routeMessage("price of XLM")).toMatchObject({
      kind: "read",
      template_id: "query_price",
      args: { symbol: "XLM" },
    });
  });

  it("does not let the cache swallow a write mixed into a health sentence", () => {
    expect(matchFastPath("what's my health factor and can I borrow 50")).toBeNull();
    const routed = routeMessage("what's my health factor and can I borrow 50");
    expect(routed.kind === "read" && routed.template_id === "query_account_health").toBe(false);
  });
});

describe("parseWithdrawCheck", () => {
  it("parses the flagship eligibility prompt and ignores a write command", () => {
    expect(parseWithdrawCheck("can I withdraw 100 XLM without getting liquidated?")).toEqual({
      asset: "XLM", amount: "100",
    });
    expect(parseWithdrawCheck("withdraw 100 XLM")).toBeNull();
    expect(parseWithdrawCheck("can I withdraw 100 XLM then borrow 50 BLUSDC?")).toBeNull();
  });
});

describe("fastPathView", () => {
  it("answers health from the same snapshot shape the Margin rail uses", () => {
    const view = fastPathView({
      message: "what's my health factor?",
      scope: SCOPE,
      observations: healthObservations({
        grossCollateralUsd: "317.00",
        debtUsd: "217.12",
        healthFactor: "1.46",
      }),
      secret: "a".repeat(32),
      server: "mcp-test",
    });
    expect(view.executionAllowed).toBe(false);
    expect(view.understanding?.intent).toBe("answer");
    expect(view.message).toMatch(/1\.46/);
  });
});

describe("postedHealthFactorFromSnapshot", () => {
  it("divides one RiskEngine tuple and returns null when there is no debt", () => {
    expect(postedHealthFactorFromSnapshot({
      collateral_usd_wad: (BigInt(953) * (BigInt(10) ** BigInt(18))).toString(),
      debt_usd_wad: (BigInt(278) * (BigInt(10) ** BigInt(18))).toString(),
    })).toMatch(/^3\.428/);
    expect(postedHealthFactorFromSnapshot({
      collateral_usd: "953.80", debt_usd: "0",
    })).toBeNull();
  });

  it("treats unposted collateral as agreement and a dropped debt leg as disagreement", () => {
    expect(pageDebtAgreesWithContract(278.91, 278.91)).toBe(true);
    expect(pageDebtAgreesWithContract(42.54, 278.91)).toBe(false);
  });
});

describe("researchTurn fast path", () => {
  it("answers a price question from one public read without the investigation loop", async () => {
    const mcp = { call: vi.fn(async () => ({ price_usd: "0.11" })) };
    const result = await researchTurn(
      { message: "price of XLM", wallet: null, continuation: null },
      deps({ mcp }),
    );
    expect(mcp.call).toHaveBeenCalledOnce();
    expect(result.message).toMatch(/0\.11/);
    expect(result.executionAllowed).toBe(false);
    expect(mocks.resolveInvestigationScope).not.toHaveBeenCalled();
  });

  it("answers health from liquidation_snapshot without waiting on a hung snapshot", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    const mcp = {
      call: vi.fn(async () => ({
        collateral_usd: "953.80",
        debt_usd: "278.91",
        collateral_usd_wad: (BigInt(95380) * (BigInt(10) ** BigInt(16))).toString(),
        debt_usd_wad: (BigInt(27891) * (BigInt(10) ** BigInt(16))).toString(),
        liquidatable: false,
        source: "risk_engine.liquidation_snapshot",
      })),
    };
    const result = await researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null },
      deps({ mcp }),
    );
    expect(mcp.call).toHaveBeenCalledWith(
      "vanna_get_liquidation_snapshot",
      expect.objectContaining({ smart_account: SCOPE.smartAccount }),
      SCOPE.trader,
    );
    expect(result.message).toMatch(/3\.42/);
    expect(result.message).toMatch(/posted collateral/);
    expect(result.message).not.toMatch(/can read higher/);
    expect(result.executionAllowed).toBe(false);
  });

  it("answers with the Margin-page figure when snapshot debt matches the contract", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue({
      grossCollateralUsd: "1087.20",
      debtUsd: "278.91",
      healthFactor: "3.90",
      snapshot: { totalBorrowedValue: 278.91, grossCollateralValue: 1087.20 },
    });
    const mcp = {
      call: vi.fn(async () => ({
        collateral_usd: "953.80",
        debt_usd: "278.91",
        liquidatable: false,
        source: "risk_engine.liquidation_snapshot",
      })),
    };
    const result = await researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null },
      deps({ mcp }),
    );
    expect(result.message).toMatch(/Your reported health factor is 3\.90/);
    expect(result.message).not.toMatch(/3\.42/);
    expect(result.message).not.toMatch(/posted collateral/);
  });

  it("does not quote a 25.50 panel figure when contract debt disagrees", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue({
      grossCollateralUsd: "1084.95",
      debtUsd: "42.54",
      healthFactor: "25.50",
      snapshot: { totalBorrowedValue: 42.54, grossCollateralValue: 1084.95 },
    });
    const mcp = {
      call: vi.fn(async () => ({
        collateral_usd: "953.80",
        debt_usd: "278.91",
        collateral_usd_wad: (BigInt(95380) * (BigInt(10) ** BigInt(16))).toString(),
        debt_usd_wad: (BigInt(27891) * (BigInt(10) ** BigInt(16))).toString(),
        liquidatable: false,
        source: "risk_engine.liquidation_snapshot",
      })),
    };
    const result = await researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null },
      deps({ mcp }),
    );
    expect(result.message).toMatch(/3\.42/);
    expect(result.message).toMatch(/25\.50/);
    expect(result.message).toMatch(/not using it/);
    expect(result.message).not.toMatch(/Your reported health factor is 25\.50/);
  });

  it("falls back to the page snapshot only when the contract read fails", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue({
      grossCollateralUsd: "317.00",
      debtUsd: "217.12",
      healthFactor: "2.43",
      snapshot: {},
    });
    const mcp = { call: vi.fn(async () => ({ error: "contract_error" })) };
    const result = await researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null },
      deps({ mcp }),
    );
    expect(mocks.computeAccountPosition).toHaveBeenCalledOnce();
    expect(result.message).toMatch(/2\.43/);
    expect(result.executionAllowed).toBe(false);
  });

  it("does not Vertex a health ask when both contract and snapshot miss", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockImplementation(() => new Promise(() => {}));
    const mcp = { call: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})) };
    const model = vi.fn(async () => {
      throw new Error("model should not run");
    });
    const abort = new AbortController();
    const pending = researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null },
      { ...deps({ mcp, model }), signal: abort.signal },
    );
    await vi.waitFor(() => expect(mcp.call).toHaveBeenCalled());
    abort.abort();
    const result = await pending;
    expect(model).not.toHaveBeenCalled();
    expect(result.executionAllowed).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.message).toMatch(/could not read a live figure/i);
  });

  it("answers a named withdraw check from can_withdraw without the investigation loop", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue({
      grossCollateralUsd: "317.00",
      debtUsd: "217.12",
      healthFactor: "2.43",
      snapshot: {},
    });
    const mcp = { call: vi.fn(async () => ({ allowed: true, symbol: "XLM", amount: "100" })) };
    const model = vi.fn(async () => { throw new Error("model should not run"); });
    const result = await researchTurn(
      { message: "can I withdraw 100 XLM without getting liquidated?", wallet: SCOPE.trader, continuation: null },
      deps({ mcp, model }),
    );
    expect(model).not.toHaveBeenCalled();
    expect(mcp.call).toHaveBeenCalledWith(
      "vanna_can_withdraw",
      expect.objectContaining({ symbol: "XLM", amount: "100", smart_account: SCOPE.smartAccount }),
      SCOPE.trader,
    );
    expect(result.message).toMatch(/withdraw 100 XLM is allowed on the current health check/);
    expect(result.executionAllowed).toBe(false);
    expect(result.status).toBe("researched");
  });

  it("offers a standing-order mandate and does not execute", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    const result = await researchTurn(
      { message: "when my health factor drops below 1.2 repay 10 XLM", wallet: SCOPE.trader, continuation: null },
      deps({}),
    );
    expect(result.status).toBe("blocked");
    expect(result.message).toContain(STANDING_ORDER_OFFER);
    expect(result.executionAllowed).toBe(false);
    expect(result.message).toMatch(/Mandate /);
  });

  it("compiles a fully specified write from the planner without waiting on the snapshot", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockImplementation(() => new Promise(() => {}));
    const model = vi.fn(async () => ({
      kind: "research_complete",
      goal: {
        intent: "strategy",
        relation: "new",
        objective: "repay 1xlm from my account",
        constraints: [],
        borrowing: "forbidden",
        actions: [{
          op: "repay",
          asset: "XLM",
          amount: "1",
          sourceQuote: "repay 1xlm from my account",
        }],
      },
      findings: [{ summary: "User named a complete repay.", evidenceIds: [] }],
      openQuestions: [],
    }));
    const result = await researchTurn(
      { message: "repay 1xlm from my account", wallet: SCOPE.trader, continuation: null },
      deps({ model }),
    );
    expect(model).toHaveBeenCalled();
    expect(result.status).toBe("researched");
    expect(result.proposalCandidateId).toBe("requested_actions");
    expect(result.message).toMatch(/repay 1 XLM/i);
    expect(result.message).not.toMatch(/wallet holds/i);
    expect(result.executionAllowed).toBe(false);
  });
});
