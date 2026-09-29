/**
 * The questionnaire, end to end through the service: a direct action with inputs missing is
 * asked as a questionnaire, and the answers come back as that SAME instruction with the inputs
 * filled — no second model turn, no plan card (REQUESTED_ACTIONS_ID), sized from the sealed reads.
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
