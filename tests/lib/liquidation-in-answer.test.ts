import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTokenUsage } from "@/lib/copilot/token-budget";

/**
 * The turn behind a liquidation-price question on 24 Oct 2026, run end to end with the model
 * scripted and the reads faked (the wording avoids the price fast path, which claims any short
 * message with "price" and one asset and answers it from public data alone): the facts
 * the reply is composed from must hold the Margin page's ONE health factor, the liquidation figures,
 * and no posted-collateral number the model could divide into a second health factor.
 */

const mocks = vi.hoisted(() => ({
  resolveInvestigationScope: vi.fn(),
  computeAccountPosition: vi.fn(),
  computeBorrowCapacity: vi.fn(),
  computeSizingBasis: vi.fn(),
}));

vi.mock("@/lib/copilot/investigation/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/scope")>();
  return { ...actual, resolveInvestigationScope: mocks.resolveInvestigationScope };
});

vi.mock("@/lib/copilot/investigation/capacity", async (importOriginal) => ({
  PROTOCOL_MAX_BORROW_FLOOR: (await importOriginal<typeof import("@/lib/copilot/investigation/capacity")>()).PROTOCOL_MAX_BORROW_FLOOR,
  computeAccountPosition: mocks.computeAccountPosition,
  computeBorrowCapacity: mocks.computeBorrowCapacity,
  computeSizingBasis: mocks.computeSizingBasis,
}));

const { researchTurn } = await import("@/lib/copilot/investigation/service");

const SCOPE = {
  subject: "user",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};

type Row = { amount: string; usdValue: string };
const row = (amount: number, usd: number): Row => ({ amount: String(amount), usdValue: usd.toFixed(2) });

const POSITION = {
  grossCollateralUsd: "1916.27", debtUsd: "23.31", healthFactor: "82.2086",
  snapshot: {
    totalBorrowedValue: 23.31, grossCollateralValue: 1916.27,
    collateralBalances: {
      XLM: row(5173.89, 919.95), AQUSDC: row(103.21, 103.22), BLUSDC: row(0.99, 0.99),
      BLEND_XLM: row(3506.72, 623.52), BLEND_USDC: row(244.82, 245.11), SS_XLM_USDC: row(22.79, 19.86),
    },
    borrowedBalances: { AQUSDC: row(11.79, 11.8), XLM: row(47.0755, 8.37), BLUSDC: row(3.14, 3.14) },
  },
};

const CONTRACT_HEALTH = {
  smart_account: SCOPE.smartAccount, collateral_usd: "1637.70", debt_usd: "23.31", ltv_ratio: "0.0142", is_healthy: true,
  distance_to_liquidation: "0.8947643", borrow_threshold: "0.909", liquidation_threshold: "0.909",
};

afterEach(() => {
  vi.clearAllMocks();
  resetTokenUsage();
});

describe("a liquidation-price question", () => {
  it("is composed from one health factor, the liquidation facts, and no ambiguous collateral figure", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(POSITION);
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_account_health") return CONTRACT_HEALTH;
      throw new Error(`unexpected read ${tool}`);
    }) };
    let turn = 0;
    const result = await researchTurn(
      { message: "How far can XLM drop before my account gets liquidated?", wallet: SCOPE.trader, continuation: null },
      {
        subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp,
        signal: new AbortController().signal,
        model: async () => {
          turn += 1;
          if (turn === 1) return { kind: "inspect", reads: [{ capability: "account_health", args: {} }] };
          return {
            kind: "research_complete",
            goal: { intent: "answer", objective: "liquidation price", constraints: [], borrowing: "unspecified" },
            findings: [{ summary: "The liquidation threshold is a health factor of 1.1.", evidenceIds: [] }],
            openQuestions: [],
          };
        },
      },
    );
    const facts = (result as unknown as { facts?: Array<{ label: string; value: string; unit: string; sourcePath: string; evidenceId: string }> }).facts ?? [];
    expect(facts.length).toBeGreaterThan(0);
    // ONE health factor, the page's.
    const healthFactors = facts.filter((fact) => fact.unit === "HF" && fact.sourcePath === "health_factor");
    expect(healthFactors).toHaveLength(1);
    expect(healthFactors[0].value).toBe("82.2086");
    // No posted-basis collateral beside it.
    expect(facts.some((fact) => fact.label === "Account health collateral")).toBe(false);
    expect(facts.filter((fact) => fact.sourcePath === "collateral_usd" && fact.evidenceId !== "e1" && fact.label.includes("health")).length).toBe(0);
    // The liquidation answer is there: no XLM price liquidates this account.
    expect(facts.find((fact) => fact.label === "XLM liquidation price")).toMatchObject({ value: "none" });
    expect(facts.some((fact) => fact.label === "Health factor if XLM fell to near zero")).toBe(true);
    // And it cost no extra read: the snapshot already in hand was reused.
    expect(mcp.call.mock.calls.map((call) => call[0])).toEqual(["vanna_get_account_health"]);
  });
});


describe("the price shortcut and a connected account", () => {
  const scriptedDeps = (mcp: { call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> }, model?: () => Promise<unknown>) => ({
    subject: "user", server: "mcp-test", network: "testnet", secret: "a".repeat(32), mcp,
    signal: new AbortController().signal,
    model: model ?? (async () => { throw new Error("the model must not run for a signed-out price lookup"); }),
  });

  it("a liquidation question that names an asset reaches the loop for a connected user, not the public price lookup", async () => {
    // 24 Oct, live: this exact message was claimed by the price shortcut (it says "price" and names one
    // asset), which answers from public data with no account in scope - the reply said "no connected
    // wallet", and on a slow price read the turn fell through and stalled instead.
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(POSITION);
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_account_health") return CONTRACT_HEALTH;
      throw new Error(`unexpected read ${tool}`);
    }) };
    let turn = 0;
    const result = await researchTurn(
      { message: "What is my XLM liquidation price, and how far can prices drop before I get liquidated?", wallet: SCOPE.trader, continuation: null },
      scriptedDeps(mcp, async () => {
        turn += 1;
        if (turn === 1) return { kind: "inspect", reads: [{ capability: "account_health", args: {} }] };
        return {
          kind: "research_complete",
          goal: { intent: "answer", objective: "liquidation price", constraints: [], borrowing: "unspecified" },
          findings: [{ summary: "The liquidation threshold is a health factor of 1.1.", evidenceIds: [] }],
          openQuestions: [],
        };
      }),
    );
    expect(mcp.call.mock.calls.map((call) => call[0])).toEqual(["vanna_get_account_health"]);
    const facts = (result as unknown as { facts?: Array<{ label: string }> }).facts ?? [];
    expect(facts.some((fact) => fact.label === "XLM liquidation price")).toBe(true);
    expect(result.scope?.smartAccount).toBe(SCOPE.smartAccount);
  });

  it("a signed-out visitor still gets a plain price from public data, with no model turn", async () => {
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_price") return { symbol: "XLM", price_usd: "0.1778", source: "oracle" };
      throw new Error(`unexpected read ${tool}`);
    }) };
    const result = await researchTurn(
      { message: "price of XLM", wallet: null, continuation: null },
      scriptedDeps(mcp),
    );
    expect(mcp.call.mock.calls.map((call) => call[0])).toEqual(["vanna_get_price"]);
    expect(result.message).toMatch(/XLM oracle price/);
  });
});
