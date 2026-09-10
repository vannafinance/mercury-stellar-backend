import { afterEach, describe, expect, it, vi } from "vitest";
import { matchFastPath, fastPathView, healthObservations } from "@/lib/copilot/investigation/fast-path";
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
  model?: () => Promise<never>;
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
  });

  it("matches a single canonical asset price and refuses bare USDC", () => {
    expect(matchFastPath("price of XLM")).toEqual({ kind: "price", asset: "XLM" });
    expect(matchFastPath("what's USDC trading at")).toBeNull();
    expect(matchFastPath("price of XLM then borrow")).toBeNull();
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

  it("answers health from the seeded snapshot without calling the model", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue({
      grossCollateralUsd: "317.00",
      debtUsd: "217.12",
      healthFactor: "2.43",
      snapshot: {},
    });
    const result = await researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null },
      deps({}),
    );
    expect(result.message).toMatch(/2\.43/);
    expect(result.executionAllowed).toBe(false);
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
});
