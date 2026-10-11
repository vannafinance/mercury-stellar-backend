/**
 * The questionnaire, end to end through the service: a direct action with inputs missing is
 * asked as a questionnaire, and the answers come back as that SAME instruction with the inputs
 * filled - no second model turn, no plan card (REQUESTED_ACTIONS_ID), sized from the sealed reads.
 * The unit and component tests cover each half; nothing drove both halves through researchTurn.
 */
vi.mock("@/lib/copilot/workflow/risk", () => ({ validateWorkflowRisk: vi.fn(async () => null) }));
import { describe, expect, it, vi } from "vitest";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";

const harness = vi.hoisted(() => {
  let row: { value: WorkflowRecord; version: string } | null = null;
  const store: RecordStore<WorkflowRecord> = {
    read: async () => structuredClone(row),
    write: async (_id, expected, value) => {
      if ((row?.version ?? null) !== expected) return false;
      row = { version: String(Number(expected ?? -1) + 1), value: structuredClone(value) };
      return true;
    },
  };
  return {
    store,
    resolveInvestigationScope: vi.fn(), computeAccountPosition: vi.fn(), computeBorrowCapacity: vi.fn(), computeSizingBasis: vi.fn(),
  };
});
vi.mock("@/lib/copilot/workflow/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/workflow/store")>();
  return { ...actual, workflowStore: () => harness.store };
});
vi.mock("@/lib/copilot/investigation/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/scope")>();
  return { ...actual, resolveInvestigationScope: harness.resolveInvestigationScope };
});
vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return { ...actual, computeMarginSnapshot: vi.fn(async () => ({ grossCollateralValue: 200, totalBorrowedValue: 50 })) };
});
vi.mock("@/lib/copilot/investigation/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/capacity")>();
  return { ...actual, computeAccountPosition: harness.computeAccountPosition, computeBorrowCapacity: harness.computeBorrowCapacity, computeSizingBasis: harness.computeSizingBasis };
});

const { researchTurn } = await import("@/lib/copilot/investigation/service");
const { REQUESTED_ACTIONS_ID } = await import("@/lib/copilot/investigation/candidate-id");
const { proposeWorkflow } = await import("@/lib/copilot/investigation/proposal");

const SCOPE = {
  subject: "user",
  trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
  smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
  network: "testnet",
};
const SECRET = "a".repeat(32);
const BASIS = {
  grossCollateralUsd: "200", debtUsd: "50", source: "contract" as const, issue: null,
  app: { grossCollateralUsd: "200", debtUsd: "50" }, contract: { grossCollateralUsd: "200", debtUsd: "50" },
};

const mcp = {
  call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "XLM", balance: "80", decimals: 7, status: "ok" }, { symbol: "XLM_SAC", balance: "80", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" };
    if (tool === "vanna_get_collateral") return { collateral: [{ symbol: "XLM", balance: "300" }] };
    if (tool === "vanna_get_price" || tool === "vanna_get_prices_batch") return { price_usd: "0.2", prices: { XLM: { price_usd: "0.2" } } };
    if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "60" };
    if (tool === "vanna_list_blend_reserves") return { reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "12", borrow_apr_pct: "15", utilization_pct: "70" }] };
    if (tool === "vanna_get_debt") return { debt: [], total_debt_usd: "0" };
    return {};
  }),
};

describe("questionnaire round trip through researchTurn", () => {
  it("includes the Margin health factor when a model-led health read has only LTV", async () => {
    harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
    harness.computeAccountPosition.mockResolvedValue({ grossCollateralUsd: "200", debtUsd: "50", healthFactor: "4", snapshot: { grossCollateralValue: 200, totalBorrowedValue: 50, collateralBalances: {}, borrowedBalances: {} } });
    const healthMcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => tool === "vanna_get_account_health" ? { collateral_usd: "170", debt_usd: "50", ltv_ratio: "0.294117", is_healthy: true } : mcp.call(tool, args)) };
    let turn = 0;
    const result = await researchTurn({ message: "Tell me my current HF", wallet: SCOPE.trader, continuation: null }, { subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp: healthMcp, signal: new AbortController().signal, model: async () => ++turn === 1 ? { kind: "inspect", capability: "account_health", args: {} } : { kind: "research_complete", goal: { intent: "answer", objective: "Current account health", constraints: [], borrowing: "unspecified" }, findings: [{ summary: "The account health read completed.", evidenceIds: [] }], openQuestions: [] } });
    expect(result.facts).toContainEqual(expect.objectContaining({ sourcePath: "health_factor", value: "4", requested: true }));
    expect(result.message).toContain("health factor is 4");
  });
  it("keeps maximum sizing from an asset-only questionnaire without another model call", async () => {
    harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
    harness.computeAccountPosition.mockResolvedValue({ grossCollateralUsd: "200", debtUsd: "50", healthFactor: "4", snapshot: { grossCollateralValue: 200, totalBorrowedValue: 50, collateralBalances: {}, borrowedBalances: {} } });
    harness.computeSizingBasis.mockResolvedValue(BASIS);
    harness.computeBorrowCapacity.mockResolvedValue(null);
    const message = "Get the largest available loan";
    const loanMcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => tool === "vanna_get_max_borrow" ? { max_borrow_human: "321", symbol: "XLM" } : mcp.call(tool, args)) };
    const model = vi.fn(async () => ({ kind: "clarify", intent: "action", question: "Which asset?", missing: [{ op: "borrow", slots: ["asset"], sizing: "to_floor", sourceQuote: message }] }));
    const deps = { subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp: loanMcp, signal: new AbortController().signal, model };
    const asked = await researchTurn({ message, wallet: SCOPE.trader, continuation: null }, deps);
    const section = asked.questionnaire!.sections![0];
    expect(section.steps.map(step => step.slot)).toEqual(["asset"]);
    const answered = await researchTurn({ message: "Borrow the maximum XLM", wallet: SCOPE.trader, continuation: asked.continuation, answers: { questionnaireId: asked.questionnaire!.id, asset: "XLM", venue: null, amount: { kind: "to_floor" }, summary: "Borrow the maximum XLM", sections: [{ sectionId: section.id, asset: "XLM", venue: null, amount: { kind: "to_floor" } }] } }, deps);
    expect(model).toHaveBeenCalledTimes(1);
    expect(answered.proposalCandidateId).toBe(REQUESTED_ACTIONS_ID);
    expect(answered.message).toContain("Borrow 320.679 XLM.");
    expect(harness.computeBorrowCapacity).toHaveBeenLastCalledWith(SCOPE.smartAccount, expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ useProtocolFloor: true }));
  });
  it("prepares an explicit maximum loan directly even when display and contract collateral disagree", async () => {
    const message = "Take the largest XLM loan";
    harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
    harness.computeAccountPosition.mockResolvedValue({ grossCollateralUsd: "250", debtUsd: "50", healthFactor: "5", snapshot: { grossCollateralValue: 250, totalBorrowedValue: 50, collateralBalances: {}, borrowedBalances: {} } });
    harness.computeSizingBasis.mockResolvedValue({ ...BASIS, issue: "sizing_sources_disagree", app: { grossCollateralUsd: "250", debtUsd: "50" } });
    harness.computeBorrowCapacity.mockResolvedValue(null);
    const loanMcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "vanna_get_max_borrow") return { max_borrow_human: "321", symbol: "XLM" };
      if (tool === "vanna_can_borrow") return { allowed: true };
      return mcp.call(tool, args);
    }) };
    const result = await researchTurn({ message, wallet: SCOPE.trader, continuation: null }, {
      subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp: loanMcp,
      signal: new AbortController().signal,
      model: async () => ({ kind: "research_complete", goal: {
        intent: "strategy", objective: message, constraints: [], borrowing: "required", namedOps: [{ op: "borrow", sourceQuote: message }],
      }, plans: [{ title: "Maximum XLM loan", rationale: message, evidenceIds: [], legs: [{ op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } }] }], findings: [{ summary: "The requested loan is sized by the server.", evidenceIds: [] }], openQuestions: [] }),
    });
    expect(result.questionnaire).toBeUndefined();
    expect(result.proposalCandidateId).toBe(REQUESTED_ACTIONS_ID);
    expect(result.message).toContain("Borrow 320.679 XLM.");
    expect(harness.computeBorrowCapacity).toHaveBeenCalledWith(SCOPE.smartAccount, [message], expect.anything(), expect.anything(), expect.objectContaining({ useProtocolFloor: true }));
  });

  it("asks where and how much for 'supply xlm', then runs that instruction with the answers, no second model turn", async () => {
    harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
    harness.computeAccountPosition.mockResolvedValue({ grossCollateralUsd: "200", debtUsd: "50", healthFactor: "4", snapshot: { grossCollateralValue: 200, totalBorrowedValue: 50, collateralBalances: {}, borrowedBalances: {} } });
    harness.computeSizingBasis.mockResolvedValue(BASIS);
    harness.computeBorrowCapacity.mockResolvedValue(null);
    const model = vi.fn(async () => ({
      kind: "clarify", intent: "action", question: "Where should the XLM go, and how much?",
      missing: [{ asset: "XLM", slots: ["venue", "amount"], sourceQuote: "supply xlm" }],
    }));
    const deps = { subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal, model };

    const asked = await researchTurn({ message: "supply xlm", wallet: SCOPE.trader, continuation: null }, deps);
    const questionnaire = asked.questionnaire!;
    expect(questionnaire).toBeTruthy();
    // One action is issued as one section; the component answers it in the sections form.
    const section = questionnaire.sections![0];
    const venue = section.steps.find((step) => step.slot === "venue")!;
    const earn = venue.options.find((option) => option.op === "lend")!;
    expect(earn).toBeTruthy();
    expect(earn.detail).toMatch(/\d/); // the held balance is on the option
    expect(asked.proposalCandidateId ?? null).toBeNull();

    const answered = await researchTurn({
      message: `Supply 5 XLM to Earn`, wallet: SCOPE.trader, continuation: asked.continuation,
      answers: {
        questionnaireId: questionnaire.id, asset: "XLM", venue: earn.id, amount: { kind: "literal", amount: "5" }, summary: "Supply 5 XLM to Earn",
        sections: [{ sectionId: section.id, asset: "XLM", venue: earn.id, amount: { kind: "literal", amount: "5" } }],
      },
    }, deps);
    expect(model).toHaveBeenCalledTimes(1);
    expect(answered.proposalCandidateId).toBe(REQUESTED_ACTIONS_ID);
    // What the browser does next: propose the sealed requested actions by id.
    const proposal = await proposeWorkflow({
      continuation: answered.continuation, candidateId: REQUESTED_ACTIONS_ID, subject: SCOPE.subject, secret: SECRET, server: "mcp-test",
      network: "testnet", mcp, signal: new AbortController().signal, now: Date.now() + 60_000,
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.steps.map((step) => [step.op, step.asset, step.amount])).toEqual([["lend", "XLM", "5"]]);
  });

  it("refuses an answer that names a place the questionnaire never offered", async () => {
    harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
    const model = vi.fn(async () => ({
      kind: "clarify", intent: "action", question: "Where should the XLM go, and how much?",
      missing: [{ asset: "XLM", slots: ["venue", "amount"], sourceQuote: "supply xlm" }],
    }));
    const deps = { subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal, model };
    const asked = await researchTurn({ message: "supply xlm", wallet: SCOPE.trader, continuation: null }, deps);
    await expect(researchTurn({
      message: "Supply 5 XLM", wallet: SCOPE.trader, continuation: asked.continuation,
      answers: {
        questionnaireId: asked.questionnaire!.id, asset: "XLM", venue: "borrow:XLM", amount: { kind: "literal", amount: "5" }, summary: "Supply 5 XLM",
        sections: [{ sectionId: asked.questionnaire!.sections![0].id, asset: "XLM", venue: "borrow:XLM", amount: { kind: "literal", amount: "5" } }],
      },
    }, deps)).rejects.toBeDefined();
    expect(model).toHaveBeenCalledTimes(1);
  });
});
