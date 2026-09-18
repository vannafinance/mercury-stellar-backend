import { describe, expect, it, vi } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { resolveInvestigationScope } from "@/lib/copilot/investigation/scope";
import { researchTurn } from "@/lib/copilot/investigation/service";

describe("conceptual answers without a wallet", () => {
  it("skips wallet bindings when no wallet is provided", async () => {
    const mcp = { call: vi.fn() };
    const scope = await resolveInvestigationScope(
      { subject: "guest", wallet: null, network: "testnet" },
      mcp,
      new AbortController().signal,
    );
    expect(mcp.call).not.toHaveBeenCalled();
    expect(scope).toEqual({ subject: "guest", trader: null, smartAccount: null, network: "testnet" });
  });

  it("accepts research_complete with empty evidence when intent is answer", () => {
    const decision = parseDecision({
      kind: "research_complete",
      goal: {
        intent: "answer",
        objective: "Explain health factor",
        constraints: [],
        borrowing: "unspecified",
      },
      findings: [{
        summary: "A health factor is collateral divided by debt. 1.1 is the liquidation threshold.",
        evidenceIds: [],
      }],
      openQuestions: [],
    });
    expect(decision).toMatchObject({ kind: "research_complete", goal: { intent: "answer" } });
  });

  it("still requires evidence IDs behind any figure in a strategy handoff", () => {
    // A number the user will read must trace to a read; a sentence with no figure may stand alone.
    expect(parseDecision({
      kind: "research_complete",
      goal: { intent: "strategy", objective: "Build a plan", constraints: [], borrowing: "unspecified" },
      findings: [{ summary: "Blend XLM supply APR is 168.7%", evidenceIds: [] }],
      openQuestions: [],
    })).toBeNull();
    expect(parseDecision({
      kind: "research_complete",
      goal: { intent: "strategy", objective: "Build a plan", constraints: [], borrowing: "unspecified" },
      findings: [{ summary: "Adding liquidity is not an operation this copilot can execute.", evidenceIds: [] }],
      openQuestions: [],
    })).toMatchObject({ kind: "research_complete" });
  });

  it("allows empty evidence when the planner nominated stated actions", () => {
    const decision = parseDecision({
      kind: "research_complete",
      goal: {
        intent: "strategy",
        objective: "repay 1 XLM",
        constraints: [],
        borrowing: "forbidden",
        actions: [{ op: "repay", asset: "XLM", amount: "1", sourceQuote: "repay 1 XLM" }],
      },
      findings: [{ summary: "User named a complete repay.", evidenceIds: [] }],
      openQuestions: [],
    });
    expect(decision).toMatchObject({ kind: "research_complete", goal: { intent: "strategy" } });
  });

  it("answers a health-factor definition without calling MCP", async () => {
    const summary = "A health factor is collateral divided by debt. Protocol liquidation starts at 1.1.";
    const result = await researchTurn(
      { message: "explain what a health factor is and why 1.1 matters", wallet: null, continuation: null },
      {
        subject: "guest",
        server: "mcp-test",
        network: "testnet",
        secret: "a".repeat(32),
        mcp: { call: vi.fn(async () => { throw new Error("no MCP on a conceptual question"); }) },
        signal: new AbortController().signal,
        model: async () => ({
          kind: "research_complete",
          goal: {
            intent: "answer",
            objective: "Explain health factor",
            constraints: [],
            borrowing: "unspecified",
          },
          findings: [{ summary, evidenceIds: [] }],
          openQuestions: [],
        }),
      },
    );
    expect(result.message).toContain("liquidation");
    expect(result.executionAllowed).toBe(false);
    expect(result.scope.wallet).toBeNull();
  });

  it("marks a guest request that still carried a navbar wallet as an unsigned session", async () => {
    const mcp = { call: vi.fn() };
    const wallet = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
    const scope = await resolveInvestigationScope(
      { subject: "guest", wallet, network: "testnet" },
      mcp,
      new AbortController().signal,
    );
    expect(mcp.call).not.toHaveBeenCalled();
    expect(scope).toEqual({
      subject: "guest", trader: null, smartAccount: null, network: "testnet", unverified: "session",
    });
  });

  it("does not run a public-market strategy when the page sent a wallet but the request is guest", async () => {
    const model = vi.fn(async () => {
      throw new Error("the bound investigation should run this, not guest public reads");
    });
    const wallet = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";
    const result = await researchTurn(
      { message: "lend 100 xlm and BLUSDC", wallet, continuation: null },
      {
        subject: "guest",
        server: "mcp-test",
        network: "testnet",
        secret: "a".repeat(32),
        mcp: { call: vi.fn(async () => { throw new Error("no MCP on an unsigned wallet request"); }) },
        signal: new AbortController().signal,
        model,
      },
    );
    expect(model).not.toHaveBeenCalled();
    expect(result.status).toBe("needs_input");
    expect(result.facts).toEqual([]);
    expect(result.message).toMatch(/not signed in/i);
    expect(result.scope.wallet).toBe(wallet);
  });
});
