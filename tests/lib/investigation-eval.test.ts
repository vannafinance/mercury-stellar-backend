import { describe, expect, it, vi } from "vitest";
import { SIZING_SOURCES_DISAGREE_WARNING } from "@/lib/copilot/investigation/sizing-copy";

/**
 * P2.6 fixture-backed evaluation gate. Asserts behaviour, not prose: which
 * capability was requested, whether candidates were ranked, whether a
 * non-borrowing alternative appeared, and whether the named exit is right.
 *
 * Default CI: recorded MCP, no live Vertex.
 * Live model smoke: INVESTIGATION_EVAL_LIVE=1 or RUN_FLASH_INVESTIGATION_EVAL=1
 * (see tests/lib/investigation-live.test.ts).
 */

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

const CAPACITY = {
  floor: "1.30",
  grossCollateralUsd: "317.00",
  debtUsd: "217.12",
  healthFactor: "1.46",
  maxBorrowUsd: "115.813333333333333333",
};

const POSITION = {
  grossCollateralUsd: CAPACITY.grossCollateralUsd,
  debtUsd: CAPACITY.debtUsd,
  healthFactor: CAPACITY.healthFactor,
  snapshot: {
    borrowedBalances: { XLM: 1000 },
    collateralBalances: { XLM: 1668 },
    totalBorrowedValue: 217.12,
    grossCollateralValue: 317,
    totalCollateralValue: 317,
  },
};

function deps(mcp: { call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> }, model: Parameters<typeof researchTurn>[1]["model"]) {
  mocks.resolveInvestigationScope.mockReset();
  mocks.computeAccountPosition.mockReset();
  mocks.computeBorrowCapacity.mockReset();
  mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
  mocks.computeAccountPosition.mockResolvedValue(POSITION);
  mocks.computeBorrowCapacity.mockResolvedValue(CAPACITY);
  return {
    subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: "a".repeat(32),
    mcp, signal: new AbortController().signal, model,
  } satisfies Parameters<typeof researchTurn>[1];
}

describe("investigation eval (fixture MCP, no live Vertex)", () => {
  it("withdraw 100 XLM requests can_withdraw and exits researched, not executed", async () => {
    const prompt = "can I withdraw 100 XLM without getting liquidated?";
    const mcp = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_can_withdraw") {
          return { allowed: true, symbol: args.symbol, amount: args.amount };
        }
        throw new Error(`Unexpected tool ${tool}`);
      }),
    };
    let turn = 0;
    const result = await researchTurn(
      { message: prompt, wallet: SCOPE.trader, continuation: null, promptName: "withdraw-100-xlm" },
      deps(mcp, async () => turn++ === 0
        ? { kind: "inspect", reads: [{ capability: "can_withdraw", args: { asset: "XLM", amount: "100" } }] }
        : {
            kind: "research_complete",
            goal: {
              intent: "answer", relation: "new", objective: prompt,
              constraints: [], borrowing: "unspecified",
            },
            findings: [{ summary: "Withdraw 100 XLM is allowed on the current health check.", evidenceIds: ["e1"] }],
            openQuestions: [],
          }),
    );
    expect(result.status).toBe("researched");
    expect(result.executionAllowed).toBe(false);
    expect(result.checks.some((check) => check.label === "can withdraw" && check.status === "ok")).toBe(true);
    expect(mcp.call).toHaveBeenCalledWith(
      "vanna_can_withdraw",
      expect.objectContaining({ symbol: "XLM", amount: "100", smart_account: SCOPE.smartAccount }),
      SCOPE.trader,
    );
  });

  it("owner strategy ranks candidates including a non-borrowing alternative", async () => {
    const prompt = "use both usdc and xlm to build a strategy in a way that health factor doesnt go below 1.3. You can use spot and farm markets yourself. You can even take new loans";
    const mcp = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_get_pool_stats") {
          return { supply_apr_pct: "2", supply_apy_pct: "2", borrow_apr_pct: "4" };
        }
        if (tool === "vanna_list_blend_reserves") {
          return {
            reserves: [
              { venue: "blend", symbol: "XLM", supply_apr_pct: "10", supply_apy_pct: "10.5" },
              { venue: "blend", symbol: "USDC", supply_apr_pct: "10", supply_apy_pct: "10.5" },
            ],
          };
        }
        if (tool === "vanna_get_wallet_balance") {
          return { assets: [{ symbol: "XLM", balance: "50", status: "ok" }, { symbol: "BLUSDC", balance: "80", status: "ok" }] };
        }
        if (tool === "vanna_get_price") {
          return { price_usd: args.symbol === "XLM" ? "0.18" : "1" };
        }
        throw new Error(`Unexpected tool ${tool}`);
      }),
    };
    let turn = 0;
    const result = await researchTurn(
      { message: prompt, wallet: SCOPE.trader, continuation: null, promptName: "owner-strategy-usdc-xlm" },
      deps(mcp, async () => turn++ === 0
        ? {
            kind: "inspect",
            reads: [
              { capability: "earn_market", args: { asset: "XLM" } },
              { capability: "earn_market", args: { asset: "BLUSDC" } },
              { capability: "blend_markets", args: {} },
              { capability: "wallet_balances", args: {} },
              { capability: "asset_price", args: { asset: "XLM" } },
              { capability: "asset_price", args: { asset: "BLUSDC" } },
            ],
          }
        : {
            kind: "research_complete",
            goal: {
              intent: "strategy",
              objective: "Build a Blend strategy with USDC and XLM",
              constraints: ["Health factor at or above 1.3"],
              borrowing: "allowed",
            },
            findings: [{ summary: "Rates and idle balances were read", evidenceIds: ["e1", "e2", "e3"] }],
            openQuestions: [],
          }),
    );
    expect(["researched", "needs_input"]).toContain(result.status);
    expect(result.executionAllowed).toBe(false);
    expect(result.candidates).not.toBeNull();
    expect(result.candidates?.feasible.some((candidate) => candidate.borrows)).toBe(true);
    expect(result.candidates?.feasible.some((candidate) => !candidate.borrows)).toBe(true);
    expect(mcp.call.mock.calls.map((call) => call[0]).sort()).toEqual([
      "vanna_get_pool_stats",
      "vanna_get_pool_stats",
      "vanna_get_price",
      "vanna_get_price",
      "vanna_get_wallet_balance",
      "vanna_list_blend_reserves",
    ].sort());
  });

  it("bare USDC clarifies or resolves a variant rather than guessing", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP on a clarify"); }) };
    const result = await researchTurn(
      { message: "what is the USDC rate?", wallet: SCOPE.trader, continuation: null, promptName: "bare-usdc-rate" },
      deps(mcp, async () => ({
        kind: "clarify",
        question: "Which USDC do you mean — Blend (BLUSDC), Aquarius (AQUSDC), or Soroswap (SOUSDC)?",
      })),
    );
    expect(result.status).toBe("needs_input");
    expect(result.executionAllowed).toBe(false);
    expect(result.question).toMatch(/BLUSDC|AQUSDC|SOUSDC|which USDC/i);
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("refuses a conditional write instead of running the action", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP on a refused conditional"); }) };
    const result = await researchTurn(
      {
        message: "if my health factor drops below 1.2 repay 10 XLM",
        wallet: SCOPE.trader, continuation: null, promptName: "conditional-repay",
      },
      deps(mcp, async () => ({ kind: "blocked", reason: "should not reach the model" })),
    );
    expect(result.status).toBe("blocked");
    expect(result.executionAllowed).toBe(false);
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("refuses an off-domain prompt at the immediate gate", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP off-domain"); }) };
    const result = await researchTurn(
      { message: "write me a python function to sort a list", wallet: SCOPE.trader, continuation: null, promptName: "off-domain-python" },
      deps(mcp, async () => ({ kind: "blocked", reason: "should not reach the model" })),
    );
    expect(result.status).toBe("replied");
    expect(result.executionAllowed).toBe(false);
    expect(result.message).toMatch(/Vanna Finance/i);
    expect(mcp.call).not.toHaveBeenCalled();
    expect(mocks.resolveInvestigationScope).not.toHaveBeenCalled();
  });

  it("refuses to size when the app snapshot understates debt vs the contract", async () => {
    // Fixture from BUGS-FOR-APP-TEAM.md: dropped USDC leg → app $1,684.99, contract $2,705.60.
    const prompt =
      "use some USDC and BLUSDC to build a strategy so my health factor doesn't go below 1.3 — you can use spot and farm markets yourself, and you can even take new loans.";
    const mcp = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_get_pool_stats") {
          return { supply_apr_pct: "2", supply_apy_pct: "2", borrow_apr_pct: "4" };
        }
        if (tool === "vanna_list_blend_reserves") {
          return {
            reserves: [
              { venue: "blend", symbol: "XLM", supply_apr_pct: "10", supply_apy_pct: "10.5" },
              { venue: "blend", symbol: "USDC", supply_apr_pct: "10", supply_apy_pct: "10.5" },
            ],
          };
        }
        if (tool === "vanna_get_wallet_balance") {
          return { assets: [{ symbol: "XLM", balance: "50", status: "ok" }, { symbol: "BLUSDC", balance: "80", status: "ok" }] };
        }
        if (tool === "vanna_get_price") {
          return { price_usd: args.symbol === "XLM" ? "0.18" : "1" };
        }
        throw new Error(`Unexpected tool ${tool}`);
      }),
    };
    let turn = 0;
    const d = deps(mcp, async () => turn++ === 0
      ? {
          kind: "inspect",
          reads: [
            { capability: "earn_market", args: { asset: "XLM" } },
            { capability: "earn_market", args: { asset: "BLUSDC" } },
            { capability: "blend_markets", args: {} },
            { capability: "wallet_balances", args: {} },
            { capability: "asset_price", args: { asset: "XLM" } },
            { capability: "asset_price", args: { asset: "BLUSDC" } },
          ],
        }
      : {
          kind: "research_complete",
          goal: {
            intent: "strategy",
            objective: "Build a strategy with USDC and BLUSDC",
            constraints: ["Health factor at or above 1.3"],
            borrowing: "allowed",
          },
          findings: [{ summary: "Rates were read", evidenceIds: ["e1"] }],
          openQuestions: [],
        });
    mocks.computeBorrowCapacity.mockRejectedValue(new Error("sizing_sources_disagree"));
    const result = await researchTurn(
      { message: prompt, wallet: SCOPE.trader, continuation: null, promptName: "owner-strategy-debt-drift" },
      d,
    );
    expect(result.capacity).toBeNull();
    expect(result.warnings).toContain(SIZING_SOURCES_DISAGREE_WARNING);
    expect(result.candidates?.feasible.some((candidate) => candidate.borrows) ?? false).toBe(false);
    expect(result.message).not.toMatch(/Sized so health/i);
    expect(result.executionAllowed).toBe(false);
  });
});
