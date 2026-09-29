import { describe, expect, it, vi } from "vitest";
import { SIZING_SOURCES_DISAGREE_WARNING } from "@/lib/copilot/investigation/sizing-copy";
import { CONDITIONAL_REFUSAL } from "@/lib/copilot/conditional-guard";
import { researchCodec } from "@/lib/copilot/investigation/continuation";
import { buildQuestionnaireSet } from "@/lib/copilot/investigation/questionnaire";

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
          return { supply_apr_pct: "2", supply_apy_pct: "2", borrow_apr_pct: "4", utilization_pct: "60" };
        }
        if (tool === "vanna_list_blend_reserves") {
          return {
            reserves: [
              { venue: "blend", symbol: "XLM", supply_apr_pct: "10", supply_apy_pct: "10.5", borrow_apr_pct: "12", utilization_pct: "90" },
              { venue: "blend", symbol: "USDC", supply_apr_pct: "10", supply_apy_pct: "10.5", borrow_apr_pct: "12", utilization_pct: "90" },
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
    const tools = mcp.call.mock.calls.map((call) => call[0]);
    expect(tools).toContain("vanna_get_pool_stats");
    expect(tools).toContain("vanna_list_blend_reserves");
    expect(tools).toContain("vanna_get_wallet_balance");
    expect(tools).toContain("vanna_get_price");
  });

  it("a strategy clarify becomes plan cards, not a questionnaire: put my idle usdc to work (25 Sep, live)", async () => {
    const mcp = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "19", supply_apy_pct: "19", borrow_apr_pct: "4", utilization_pct: "60" };
        if (tool === "vanna_list_blend_reserves") return { reserves: [{ venue: "blend", symbol: "USDC", supply_apr_pct: "2", supply_apy_pct: "2", borrow_apr_pct: "5", utilization_pct: "50" }] };
        if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "XLM", balance: "50", status: "ok" }, { symbol: "BLUSDC", balance: "80", status: "ok" }] };
        if (tool === "vanna_get_price") return { price_usd: args.symbol === "XLM" ? "0.18" : "1" };
        return {};
      }),
    };
    let turn = 0;
    const result = await researchTurn(
      { message: "put my idle usdc to work", wallet: SCOPE.trader, continuation: null, promptName: "strategy-clarify" },
      deps(mcp, async () => turn++ === 0
        ? { kind: "inspect", reads: [
            { capability: "earn_market", args: { asset: "BLUSDC" } },
            { capability: "blend_markets", args: {} },
            { capability: "wallet_balances", args: {} },
            { capability: "asset_price", args: { asset: "BLUSDC" } },
          ] }
        : {
            kind: "clarify", intent: "strategy",
            question: "Which venue would you like to put your idle USDC to work in?",
            missing: [{ asset: "USDC", slots: ["asset", "venue", "amount"], sourceQuote: "put my idle usdc to work" }],
          }),
    );
    expect(result.questionnaire).toBeUndefined();
    expect(result.candidates?.feasible.length ?? 0).toBeGreaterThan(0);
    expect(result.executionAllowed).toBe(false);
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

  it("refuses a future-conditioned clarify before issuing a questionnaire", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP on a refused conditional"); }) };
    const result = await researchTurn(
      { message: "supply XLM when it reaches $0.30", wallet: SCOPE.trader, continuation: null, promptName: "conditional-clarify" },
      deps(mcp, async () => ({
        kind: "clarify",
        question: "How much XLM?",
        missing: [{ op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "supply XLM" }],
        trigger: { kind: "future_condition", sourceQuote: "when it reaches $0.30" },
      })),
    );
    expect(result.status).toBe("blocked");
    expect(result.message).toBe(CONDITIONAL_REFUSAL);
    expect(result.questionnaire).toBeUndefined();
    expect(result.executionAllowed).toBe(false);
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("refuses 'repay 5 xlm when xlm hits $0.30' with no standing-order mandate (25 Sep, live)", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP on a refused conditional"); }) };
    const message = "repay 5 xlm of my debt when xlm hits $0.30";
    const result = await researchTurn(
      { message, wallet: SCOPE.trader, continuation: null, promptName: "conditional-complete" },
      deps(mcp, async () => ({
        kind: "research_complete",
        goal: { objective: message, constraints: [], borrowing: "unspecified", intent: "strategy",
          trigger: { kind: "future_condition", sourceQuote: "when xlm hits $0.30" },
          actions: [{ op: "repay", asset: "XLM", sizing: { kind: "literal", amount: "5", sourceQuote: "repay 5 xlm" }, sourceQuote: "repay 5 xlm" }] },
        findings: [{ summary: "The user wants this later, when a price arrives.", evidenceIds: [] }], openQuestions: [],
      })),
    );
    expect(result.status).toBe("blocked");
    expect(result.message).toBe(CONDITIONAL_REFUSAL);
    expect(result.message).not.toMatch(/Mandate/);
    expect(result.executionAllowed).toBe(false);
  });

  it("refuses answers to a sealed future-conditioned questionnaire before planning", async () => {
    const now = Date.now();
    const observations = [{
      id: "w", capability: "wallet_balances", args: {}, observedAt: now, status: "ok" as const,
      data: { assets: [{ symbol: "XLM", balance: "10", decimals: 7, status: "ok" }], fee_reserve_xlm: "0" },
    }, {
      id: "a", capability: "account_collateral", args: {}, observedAt: now, status: "ok" as const,
      data: { collateral: [{ symbol: "XLM", balance: "10", decimals: 7 }] },
    }];
    const questionnaire = buildQuestionnaireSet(
      [{ op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "supply XLM" }],
      observations, now, ["supply XLM when it reaches $0.30"], [], true,
      { kind: "future_condition", sourceQuote: "when it reaches $0.30" },
    )!;
    const continuation = researchCodec("a".repeat(32), "mcp-test").seal(
      SCOPE,
      ["supply XLM when it reaches $0.30"],
      "How much XLM?",
      { capturedAt: now, observations, capacity: null, questionnaire },
    );
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP on a refused questionnaire answer"); }) };
    const model = vi.fn(async () => { throw new Error("no model on a refused questionnaire answer"); });
    const section = questionnaire.sections![0];
    const result = await researchTurn({
      message: "Use 1 XLM",
      wallet: SCOPE.trader,
      continuation,
      promptName: "conditional-answer",
      answers: {
        questionnaireId: questionnaire.id,
        asset: "XLM",
        venue: "supply_blend:XLM",
        amount: { kind: "literal", amount: "1" },
        summary: "Supply 1 XLM when it reaches $0.30",
        sections: [{ sectionId: section.id, asset: "XLM", venue: "supply_blend:XLM", amount: { kind: "literal", amount: "1" } }],
      },
    }, deps(mcp, model));
    expect(result.status).toBe("blocked");
    expect(result.message).toBe(CONDITIONAL_REFUSAL);
    expect(result.executionAllowed).toBe(false);
    expect(mcp.call).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it.each([
    "if my health factor drops below 1.2 repay 10 XLM",
    "when health factor is below 1.2, repay 10 XLM",
    "when my health factor falls below 1.2, repay 10 XLM",
    "once liquidation risk increases, withdraw my funds",
    "as soon as HF drops below 1.2, repay 10 XLM",
    "unless health factor rises above 1.5, withdraw 20 XLM",
  ])("blocks conditional writes without calling dependencies: %s", async (prompt) => {
    const mcp = { call: vi.fn(async () => { throw new Error("no MCP on a refused conditional"); }) };
    const result = await researchTurn(
      {
        message: prompt,
        wallet: SCOPE.trader, continuation: null, promptName: "conditional-write",
      },
      deps(mcp, async () => ({ kind: "blocked", reason: "should not reach the model" })),
    );
    expect(result.status).toBe("blocked");
    expect(result.executionAllowed).toBe(false);
    // The phrase regex no longer refuses before the model. A future condition is
    // goal.trigger, anchored to the user's words, and these fixtures never set one.
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
          return { supply_apr_pct: "2", supply_apy_pct: "2", borrow_apr_pct: "4", utilization_pct: "60" };
        }
        if (tool === "vanna_list_blend_reserves") {
          return {
            reserves: [
              { venue: "blend", symbol: "XLM", supply_apr_pct: "10", supply_apy_pct: "10.5", borrow_apr_pct: "12", utilization_pct: "90" },
              { venue: "blend", symbol: "USDC", supply_apr_pct: "10", supply_apy_pct: "10.5", borrow_apr_pct: "12", utilization_pct: "90" },
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
