import { describe, expect, it, vi } from "vitest";

/**
 * Unspecified borrowing still offers borrow-to-floor shapes when a floor exists.
 * Mapping `unspecified` to `borrowingAllowed: false` is what made the owner prompt
 * skip borrow/supply and fall through to the keyword planner.
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

describe("unspecified borrowing with a stated floor", () => {
  it("still ranks borrow-to-floor Blend candidates", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue({
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
    });
    mocks.computeBorrowCapacity.mockResolvedValue(CAPACITY);

    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_get_pool_stats") return { supply_apy_pct: "2", borrow_apr_pct: "4" };
        if (tool === "vanna_list_blend_reserves") {
          return { reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "10", supply_apy_pct: "10.5" }] };
        }
        throw new Error(`Unexpected tool ${tool}`);
      }),
    };
    let turn = 0;
    const result = await researchTurn(
      {
        message: "use both usdc and xlm to build a strategy in a way that health factor doesnt go below 1.3. You can use spot and farm markets yourself. You can even take new loans",
        wallet: SCOPE.trader,
        continuation: null,
      },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: "a".repeat(32),
        mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? {
              kind: "inspect",
              reads: [
                { capability: "earn_market", args: { asset: "XLM" } },
                { capability: "blend_markets", args: {} },
              ],
            }
          : {
              kind: "research_complete",
              goal: {
                intent: "strategy",
                objective: "Build a Blend strategy with USDC and XLM",
                constraints: ["Health factor at or above 1.3"],
                borrowing: "unspecified",
              },
              findings: [{ summary: "Rates were read", evidenceIds: ["e1", "e2"] }],
              openQuestions: [],
            },
      },
    );

    expect(result.understanding?.borrowing).toBe("unspecified");
    expect(result.candidates?.feasible.some((candidate) => candidate.borrows)).toBe(true);
    expect(result.message).toMatch(/\$115\.81/);
    expect(result.message).not.toMatch(/1000 USDC/i);
    expect(result.executionAllowed).toBe(false);
  });
});
