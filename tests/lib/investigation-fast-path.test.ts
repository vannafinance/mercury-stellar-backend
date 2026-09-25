import { afterEach, describe, expect, it, vi } from "vitest";
import { matchFastPath, fastPathView, healthObservations, parseWithdrawCheck, postedHealthFactorFromSnapshot, pageDebtAgreesWithContract } from "@/lib/copilot/investigation/fast-path";
import { researchCodec } from "@/lib/copilot/investigation/continuation";
import { compactResearchEvidence } from "@/lib/copilot/investigation/evidence";
import { routeMessage } from "@/lib/copilot/router";
import { STANDING_ORDER_OFFER } from "@/lib/copilot/standing-orders";
import { resetTokenUsage } from "@/lib/copilot/token-budget";

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

vi.mock("@/lib/copilot/investigation/capacity", () => ({
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
        unpriceable_plain: false,
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
        unpriceable_plain: false,
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
        unpriceable_plain: false,
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

  it("stores no standing-order mandate from wording and executes nothing (25 Sep)", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    const result = await researchTurn(
      { message: "when my health factor drops below 1.2 repay 10 XLM", wallet: SCOPE.trader, continuation: null },
      deps({ mcp: { call: vi.fn(async () => ({})) }, model: async () => ({ kind: "blocked", reason: "not now" }) }),
    );
    expect(result.message).not.toContain(STANDING_ORDER_OFFER);
    expect(result.message).not.toMatch(/Mandate /);
    expect(result.executionAllowed).toBe(false);
  });

  it("sizes a stated write from live reads and refuses it with the wallet's own figures when nothing is spendable (14 Sep: 'lend 1 xlm to earn')", async () => {
    /**
     * Until 14 Sep a stated write compiled straight to a step, nothing checked against a
     * balance. "lend 1 xlm to earn" was offered from 3.94 XLM of which 3.5 was the chain's
     * minimum balance and 0.5 the fee reserve; the user approved; the contract answered
     * "HostError #10: resulting balance is not within the allowed range". The wallet read
     * had said spendable = 0 all along.
     */
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_wallet_balance") return { assets: [
        { symbol: "XLM", balance: "3.94", spendable: "0", min_balance: "3.5", status: "ok" },
        { symbol: "XLM_SAC", balance: "3.94", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" };
      if (tool === "vanna_get_price") return { price_usd: "0.18" };
      if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" };
      throw new Error(`Unexpected tool ${tool}`);
    }) };
    const model = vi.fn(async () => ({
      kind: "research_complete",
      goal: { intent: "strategy", relation: "new", objective: "lend 1 xlm to earn", constraints: [], borrowing: "forbidden",
        actions: [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "1", sourceQuote: "lend 1 xlm to earn" }, sourceQuote: "lend 1 xlm to earn" }] },
      findings: [{ summary: "User named a complete lend.", evidenceIds: [] }],
      openQuestions: [],
    }));
    const result = await researchTurn({ message: "lend 1 xlm to earn", wallet: SCOPE.trader, continuation: null }, deps({ model, mcp }));
    expect(result.proposalCandidateId).not.toBe("requested_actions");
    expect(result.candidates?.feasible).toEqual([]);
    expect(result.candidates?.rejected[0]?.reason).toBe("lend XLM: 3.94 XLM is held, but 3.5 XLM is the chain's minimum balance and 0.5 XLM is the fee reserve — nothing is spendable.");
    expect(result.message).toMatch(/3\.94 XLM is held/);
    expect(result.executionAllowed).toBe(false);
  });

  it("offers a stated write as the steps to approve once the reads cover it", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_wallet_balance") return { assets: [
        { symbol: "XLM", balance: "50", spendable: "46", min_balance: "3.5", status: "ok" },
        { symbol: "XLM_SAC", balance: "50", decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" };
      if (tool === "vanna_get_price") return { price_usd: "0.18" };
      if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" };
      // An older server without the preview: the option stays, labelled not simulated.
      if (tool === "vanna_preview_earn") return { error: "invalid_input", message: "Unknown action 'preview' for vanna_earn_market." };
      throw new Error(`Unexpected tool ${tool}`);
    }) };
    const model = vi.fn(async () => ({
      kind: "research_complete",
      goal: { intent: "strategy", relation: "new", objective: "lend 1 xlm to earn", constraints: [], borrowing: "forbidden",
        actions: [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "1", sourceQuote: "lend 1 xlm to earn" }, sourceQuote: "lend 1 xlm to earn" }] },
      findings: [{ summary: "User named a complete lend.", evidenceIds: [] }],
      openQuestions: [],
    }));
    const result = await researchTurn({ message: "lend 1 xlm to earn", wallet: SCOPE.trader, continuation: null }, deps({ model, mcp }));
    expect(result.status).toBe("researched");
    expect(result.proposalCandidateId).toBe("requested_actions");
    expect(result.message).toMatch(/^Lend 1 XLM to Earn\. Approve to run this step\./);
    expect(result.candidates?.feasible ?? []).toEqual([]);
    expect(result.executionAllowed).toBe(false);
  });

  it("does not nominate requested_actions when a typo was assumed via near match", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    const mcp = { call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_wallet_balance") return { assets: [
        { symbol: "BLUSDC", balance: "100", spendable: "100", min_balance: "0", status: "ok" },
      ], fee_reserve_xlm: "0" };
      if (tool === "vanna_get_price") return { price_usd: "1.00" };
      if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" };
      if (tool === "vanna_preview_earn") return { error: "invalid_input", message: "preview unsupported" };
      throw new Error(`Unexpected tool ${tool}`);
    }) };
    const typoModel = vi.fn(async () => ({
      kind: "research_complete",
      goal: { intent: "strategy", relation: "new", objective: "lend 1 BLUSD to earn", constraints: [], borrowing: "forbidden",
        actions: [{ op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "1", sourceQuote: "lend 1 BLUSD to earn" }, sourceQuote: "lend 1 BLUSD to earn" }] },
      findings: [{ summary: "User requested lend.", evidenceIds: [] }],
      openQuestions: [],
    }));
    // Typo'd direct action: "BLUSD" is near-match distance 1 to "BLUSDC"
    const typoResult = await researchTurn({ message: "lend 1 BLUSD to earn", wallet: SCOPE.trader, continuation: null }, deps({ model: typoModel, mcp }));
    expect(typoResult.status).toBe("researched");
    expect(typoResult.proposalCandidateId).toBeNull();

    // Exactly typed direct action: "BLUSDC" has no near-match findings
    const exactModel = vi.fn(async () => ({
      kind: "research_complete",
      goal: { intent: "strategy", relation: "new", objective: "lend 1 BLUSDC to earn", constraints: [], borrowing: "forbidden",
        actions: [{ op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "1", sourceQuote: "lend 1 BLUSDC to earn" }, sourceQuote: "lend 1 BLUSDC to earn" }] },
      findings: [{ summary: "User requested lend.", evidenceIds: [] }],
      openQuestions: [],
    }));
    const exactResult = await researchTurn({ message: "lend 1 BLUSDC to earn", wallet: SCOPE.trader, continuation: null }, deps({ model: exactModel, mcp }));
    expect(exactResult.status).toBe("researched");
    expect(exactResult.proposalCandidateId).toBe("requested_actions");
  });

  it("answers health from still-fresh carried evidence without another chain read", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    const now = Date.now();
    const evidence = compactResearchEvidence(healthObservations({
      grossCollateralUsd: "317.00", debtUsd: "217.12", healthFactor: "1.46",
    }), null, now);
    const session = researchCodec("a".repeat(32), "mcp-test", () => now).seal(SCOPE, ["previous strategy"], null, evidence);
    const mcp = { call: vi.fn(async () => { throw new Error("MCP should not run"); }) };
    const result = await researchTurn(
      { message: "what's my health factor?", wallet: SCOPE.trader, continuation: null, session },
      deps({ mcp }),
    );
    expect(mcp.call).not.toHaveBeenCalled();
    expect(mocks.computeAccountPosition).not.toHaveBeenCalled();
    expect(result.message).toMatch(/1\.46/);
    expect(result.executionAllowed).toBe(false);
  });

  it("sizes a stated repay against the account it draws from: the account's own balance covers it, or the wallet puts it in first", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    mocks.computeSizingBasis.mockResolvedValue({ grossCollateralUsd: "144", debtUsd: "54", source: "app", issue: null, app: null, contract: null });
    const world = (posted: string, wallet: string) => ({ call: vi.fn(async (tool: string) => {
      if (tool === "vanna_get_wallet_balance") return { assets: [
        { symbol: "XLM", balance: wallet, spendable: wallet, status: "ok" }, { symbol: "XLM_SAC", balance: wallet, decimals: 7, status: "ok" },
      ], fee_reserve_xlm: "0.5" };
      if (tool === "vanna_get_price") return { price_usd: "0.18" };
      if (tool === "vanna_get_debt") return { debt: [{ symbol: "XLM", balance: "300" }] };
      if (tool === "vanna_get_collateral") return { collateral: posted === "0" ? [] : [{ symbol: "XLM", balance: posted }] };
      if (tool === "vanna_preview_margin") return { error: "invalid_input", message: "Unknown action 'preview' for vanna_margin_status." };
      throw new Error(`Unexpected tool ${tool}`);
    }) });
    const model = async () => ({
      kind: "research_complete",
      goal: { intent: "strategy", relation: "new", objective: "repay 1 XLM", constraints: [], borrowing: "unspecified",
        actions: [{ op: "repay", asset: "XLM", sizing: { kind: "literal", amount: "1", sourceQuote: "repay 1 XLM" }, sourceQuote: "repay 1 XLM" }] },
      findings: [{ summary: "Named repay.", evidenceIds: [] }],
      openQuestions: [],
    });
    const fromAccount = await researchTurn({ message: "repay 1 XLM", wallet: SCOPE.trader, continuation: null }, deps({ mcp: world("800", "0"), model }));
    expect(fromAccount.proposalCandidateId).toBe("requested_actions");
    expect(fromAccount.message).toMatch(/^Repay 1 XLM\. Approve to run this step\./);
    const fromWallet = await researchTurn({ message: "repay 1 XLM", wallet: SCOPE.trader, continuation: null }, deps({ mcp: world("0", "100"), model }));
    expect(fromWallet.proposalCandidateId).toBe("requested_actions");
    expect(fromWallet.message).toMatch(/^Deposit 1 XLM as collateral, then Repay 1 XLM\. Approve to run these steps\./);
    const nothing = await researchTurn({ message: "repay 1 XLM", wallet: SCOPE.trader, continuation: null }, deps({ mcp: world("0", "0"), model }));
    expect(nothing.proposalCandidateId).not.toBe("requested_actions");
    expect(nothing.candidates?.rejected[0]?.reason).toBe("deposit collateral XLM: XLM is not in the connected wallet.");
  });
});
