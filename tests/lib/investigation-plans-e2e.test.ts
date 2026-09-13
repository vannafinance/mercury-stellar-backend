/**
 * A prompt outside the three fixed shapes gets a working option — end to end.
 *
 * ## The live failure this pins
 *
 * 13 Sep: *"deploy my XLM and USDC in farm, HF above 1.2"* — five warnings, zero options,
 * Start over. Not because the reads failed (they did not) and not because the model
 * misunderstood (it did not), but because the strategy layer only knew three shapes.
 *
 * Here the model composes a shape the fixed generator does not offer on its own (deposit
 * idle XLM, then supply it to Blend, then lever the rest to the floor), the service sizes
 * it into a ranked option with steps, the id is sealed as proposable, and clicking it
 * compiles those exact steps from the sealed evidence without a second model turn.
 */

vi.mock("@/lib/copilot/workflow/risk", () => ({ validateWorkflowRisk: vi.fn(async () => null) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    store, reset() { row = null; },
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
  return { ...actual, computeMarginSnapshot: vi.fn(async () => ({ grossCollateralValue: 6605.84, totalBorrowedValue: 5102.54 })) };
});
vi.mock("@/lib/copilot/investigation/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/capacity")>();
  return { ...actual, computeAccountPosition: harness.computeAccountPosition, computeBorrowCapacity: harness.computeBorrowCapacity, computeSizingBasis: harness.computeSizingBasis };
});

const { researchTurn } = await import("@/lib/copilot/investigation/service");
const { proposeWorkflow } = await import("@/lib/copilot/investigation/proposal");

const SCOPE = {
  subject: "user",
  trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
  smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
  network: "testnet",
};
const SECRET = "a".repeat(32);
const CAPACITY = { floor: "1.2", grossCollateralUsd: "6605.84", debtUsd: "5102.54", healthFactor: "1.29", maxBorrowUsd: "2413.96" };
/** App and contract agree: the contract's figures are the basis. */
const BASIS = {
  grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd, source: "contract" as const, issue: null,
  app: { grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd },
  contract: { grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd },
};
const POSITION = {
  grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd, healthFactor: CAPACITY.healthFactor,
  snapshot: { borrowedBalances: { XLM: 28347 }, collateralBalances: { XLM: 36699 }, totalBorrowedValue: 5102.54, grossCollateralValue: 6605.84, totalCollateralValue: 6605.84 },
};

/** The 13 Sep account, recorded. */
const mcp = {
  call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "XLM", balance: "10206.8356118", status: "ok" }, { symbol: "XLM_SAC", balance: "10206.8356118", decimals: 7, status: "ok" }, { symbol: "USDC", status: "not_resolvable", balance: null }, { symbol: "AQUSDC", balance: "0", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" };
    if (tool === "vanna_get_price") return { price_usd: String(args.symbol).includes("USDC") ? "1" : "0.18" };
    if (tool === "vanna_get_pool_stats") return String(args.symbol) === "XLM"
      ? { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }
      : { supply_apr_pct: "29.08", borrow_apr_pct: "32.47", utilization_pct: "89.57" };
    if (tool === "vanna_list_blend_reserves") return { reserves: [
      { venue: "blend", symbol: "XLM", supply_apr_pct: "168.6342", borrow_apr_pct: "208.2203", utilization_pct: "89.99" },
      { venue: "blend", symbol: "USDC", supply_apr_pct: "0.9035", borrow_apr_pct: "1.3081", utilization_pct: "76.75" },
    ] };
    if (tool === "vanna_get_farm_overview") return { blend: { positions: { positions: [] } }, aquarius_lp: { lp_shares_human: "0" } };
    // The test account's debt as the MCP reports it: the margin account spells BLUSDC "USDC".
    if (tool === "vanna_get_debt") return { debt: [{ symbol: "USDC", balance: "2559.566080757051806242" }, { symbol: "XLM", balance: "14113.311211804998648290" }], total_debt_usd: "5076.86" };
    throw new Error(`Unexpected tool ${tool}`);
  }),
};

const PROMPT = "deploy my XLM and USDC in farm, keep HF above 1.2, you can borrow";

/** What a competent model returns for that prompt: two shapes, sizing by word, no numbers. */
const modelComplete = {
  kind: "research_complete",
  goal: { intent: "strategy", relation: "new", objective: "Deploy idle XLM into Blend farm keeping HF above 1.2", constraints: ["Health factor above 1.2"], borrowing: "allowed" },
  findings: [{ summary: "Wallet holds 10,206 idle XLM; Blend XLM supply APR 168.6% at 90% utilisation; no idle USDC-family tokens.", evidenceIds: ["e1"] }],
  openQuestions: [],
  plans: [
    {
      title: "Move idle XLM into Blend, then lever to the floor",
      rationale: "The wallet's idle XLM (e1) earns nothing; Blend pays 168.6% APR (e2). Deposit it, supply it, then borrow XLM to the 1.2 floor and supply that too.",
      evidenceIds: ["e1", "e2"],
      legs: [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
        { op: "borrow", asset: "XLM", sizing: { kind: "to_floor" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ],
    },
    {
      title: "Move idle XLM into Blend, no new debt",
      rationale: "Same first two legs without borrowing (e1, e2).",
      evidenceIds: ["e1", "e2"],
      legs: [
        { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
        { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } },
      ],
    },
    {
      title: "Lend idle USDC to Earn",
      rationale: "Would use idle AQUSDC (e1).",
      evidenceIds: ["e1"],
      legs: [{ op: "lend", asset: "AQUSDC", sizing: { kind: "all_idle" } }],
    },
  ],
};

beforeEach(() => {
  harness.reset();
  harness.resolveInvestigationScope.mockReset().mockResolvedValue(SCOPE);
  harness.computeAccountPosition.mockReset().mockResolvedValue(POSITION);
  harness.computeBorrowCapacity.mockReset().mockResolvedValue(CAPACITY);
  harness.computeSizingBasis.mockReset().mockResolvedValue(BASIS);
  mcp.call.mockClear();
});

describe("model proposes, code disposes — end to end", () => {
  it("turns a composed plan into a ranked option with sized steps, and rejects the one that cannot be sized", async () => {
    let turn = 0;
    const view = await researchTurn(
      { message: PROMPT, wallet: SCOPE.trader, continuation: null, promptName: "farm-deploy-composed" },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }, { capability: "blend_markets", args: {} }] }
          : modelComplete,
      },
    );
    expect(view.status).toBe("researched");
    const feasible = view.candidates?.feasible ?? [];
    const levered = feasible.find((c) => c.id === "composed:dc.XLM+sb.XLM+bo.XLM+sb.XLM");
    const unlevered = feasible.find((c) => c.id === "composed:dc.XLM+sb.XLM");
    expect(levered, "four-leg shape the fixed generator cannot produce").toBeTruthy();
    expect(unlevered).toBeTruthy();
    expect(levered!.steps!.map((s) => s.op)).toEqual(["deposit_collateral", "supply_blend", "borrow", "supply_blend"]);
    expect(levered!.steps![0].amount).toBe("10206.3356118");
    // After the deposit lifts collateral to 8,442.98, the floor allows (8442.98 − 1.2·5102.54)/0.2 = 11,599.66 USD ≈ 64,442.6 XLM.
    expect(Number(levered!.steps![2].amount)).toBeCloseTo(64442.57, 1);
    expect(levered!.steps![2].amount).toBe(levered!.steps![3].amount);
    expect(Number(levered!.finalHealthFactor)).toBeCloseTo(1.2, 6);
    expect(levered!.rationale).toMatch(/Deposit it, supply it/);
    // The fixed generator's identical shape was folded into the composed one.
    expect(feasible.map((c) => c.id)).not.toContain("supply_idle:XLM");
    // The USDC plan could not be sized, and the card says exactly why.
    expect(view.candidates?.rejected).toContainEqual({ label: "Lend idle USDC to Earn", reason: "lend AQUSDC: no idle AQUSDC in the wallet.", asset: "AQUSDC" });
    // The headline is generated from the winning option, not assembled beside it.
    expect(view.message).toMatch(/^(Move idle XLM into Blend[^:]*): deposit .* XLM as collateral, then supply .* to Blend/);
    expect(view.message).toMatch(/Health factor after this would be/);
    expect(view.warnings).not.toContainEqual(expect.stringMatching(/no supported display fields|some entries were unavailable/));
    expect(view.proposalCandidateId).toBe(feasible[0].id);
  });

  it("compiles the clicked composed option from the sealed evidence, with no model turn and no re-read", async () => {
    let turn = 0;
    const view = await researchTurn(
      { message: PROMPT, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }, { capability: "blend_markets", args: {} }] }
          : modelComplete,
      },
    );
    const target = "composed:dc.XLM+sb.XLM+bo.XLM+sb.XLM";
    expect(view.candidates?.feasible.map((c) => c.id)).toContain(target);
    mcp.call.mockClear();
    harness.computeBorrowCapacity.mockRejectedValue(new Error("capacity re-read should not run on fresh evidence"));
    const proposal = await proposeWorkflow({
      continuation: view.continuation, candidateId: target, subject: SCOPE.subject, secret: SECRET, server: "mcp-test",
      network: "testnet", mcp, signal: new AbortController().signal,
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.steps.map((s) => [s.op, s.asset, s.amount])).toEqual([
      ["deposit_collateral", "XLM", "10206.3356118"],
      ["supply_blend", "XLM", "10206.3356118"],
      ["borrow", "XLM", proposal.steps[2].amount],
      ["supply_blend", "XLM", proposal.steps[2].amount],
    ]);
    // Identical to the card's number: the fee reserve and the position were sealed with the evidence.
    expect(Number(proposal.steps[2].amount)).toBeCloseTo(64442.57, 1);
    expect(mcp.call).not.toHaveBeenCalled();
    expect(turn).toBe(2);
  });

  it("fetches the reads a plan needs that the model did not, and sizes it with no stated floor", async () => {
    // 13 Sep live: "Supply idle XLM to Blend…" matched no seed phrase, no price was read,
    // and the only plan was ruled out for "no XLM price was read this investigation".
    let turn = 0;
    const view = await researchTurn(
      { message: "Supply idle XLM to Blend without new borrowing", wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        // The model reads the wallet only — no price, no Blend reserves — and composes anyway.
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }] }
          : {
            ...modelComplete,
            goal: { ...modelComplete.goal, objective: "Supply idle XLM to Blend, no new debt", constraints: ["No new borrowing"], borrowing: "forbidden" },
            findings: [{ summary: "Idle XLM can be supplied to Blend.", evidenceIds: ["e1"] }],
            plans: [modelComplete.plans[1]],
          },
      },
    );
    const tools = mcp.call.mock.calls.map((call) => call[0]);
    expect(tools).toEqual(expect.arrayContaining(["vanna_get_price", "vanna_list_blend_reserves"]));
    const option = view.candidates?.feasible.find((c) => c.id === "composed:dc.XLM+sb.XLM");
    expect(option, JSON.stringify(view.candidates?.rejected)).toBeTruthy();
    expect(option!.steps![0].amount).toBe("10206.3356118");
    // No floor was stated: the plan is sized, and the health factor after it is still reported.
    expect(Number(option!.finalHealthFactor)).toBeCloseTo(1.6546, 3);
    expect(view.warnings).not.toContainEqual(expect.stringMatching(/price was read/));
  });

  it("sizes a levered plan to the floor the model anchored when the regex parser missed it", async () => {
    // "HF stays above 1.3" parses to no floor by regex; the model reports it with the quote.
    const prompt = "Create a strategy so my HF stays above 1.3, use USDC and XLM as collateral and deploy them in farm, you can borrow";
    harness.computeBorrowCapacity.mockImplementation(async (_account: unknown, _messages: unknown, _signal: unknown, _snapshot: unknown, options?: { floor?: string | null }) =>
      options?.floor ? { ...CAPACITY, floor: options.floor } : null);
    let turn = 0;
    const view = await researchTurn(
      { message: prompt, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }, { capability: "blend_markets", args: {} }] }
          : { ...modelComplete, goal: { ...modelComplete.goal, healthFactorFloor: { value: "1.3", sourceQuote: "HF stays above 1.3" } } },
      },
    );
    expect(harness.computeBorrowCapacity).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ floor: "1.3" }));
    const levered = view.candidates?.feasible.find((c) => c.id === "composed:dc.XLM+sb.XLM+bo.XLM+sb.XLM");
    expect(levered, JSON.stringify(view.candidates?.rejected)).toBeTruthy();
    // After the deposit, (8442.98 − 1.3·5102.54)/0.3 = 6,032.27 USD of borrow keeps HF at exactly 1.3.
    expect(Number(levered!.amountUsd)).toBeCloseTo(7869.41, 0);
    expect(Number(levered!.finalHealthFactor)).toBeCloseTo(1.3, 6);
    expect(view.candidates?.rejected.map((r) => r.reason)).not.toContainEqual(expect.stringMatching(/needs the health-factor floor/));
  });

  it("re-sizes a composed plan from a stale bundle against the sealed floor and a live position (the 409)", async () => {
    // "HF stays above 1.14": the regex parser sees no floor; only the sealed, model-anchored one knows it.
    const prompt = "Create a strategy so my HF stays above 1.14, use USDC and XLM as collateral and deploy them in farm, you can borrow";
    harness.computeBorrowCapacity.mockImplementation(async (_a: unknown, _m: unknown, _s: unknown, _snap: unknown, options?: { floor?: string | null }) =>
      options?.floor ? { ...CAPACITY, floor: options.floor } : null);
    let turn = 0;
    const view = await researchTurn(
      { message: prompt, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }, { capability: "blend_markets", args: {} }] }
          : { ...modelComplete, goal: { ...modelComplete.goal, healthFactorFloor: { value: "1.14", sourceQuote: "HF stays above 1.14" } } },
      },
    );
    const target = "composed:dc.XLM+sb.XLM+bo.XLM+sb.XLM";
    expect(view.candidates?.feasible.map((c) => c.id)).toContain(target);
    // Two minutes later the sealed bundle is stale: propose must re-read ONCE and re-size, not 409.
    harness.computeSizingBasis.mockClear();
    const proposal = await proposeWorkflow({
      continuation: view.continuation, candidateId: target, subject: SCOPE.subject, secret: SECRET, server: "mcp-test",
      network: "testnet", mcp, signal: new AbortController().signal, now: Date.now() + 120_000,
    });
    expect(proposal.status).toBe("proposed");
    expect(harness.computeSizingBasis).toHaveBeenCalledTimes(1);
    expect(proposal.steps.map((s) => s.op)).toEqual(["deposit_collateral", "supply_blend", "borrow", "supply_blend"]);
    // Sized to the sealed 1.14 floor after the deposit: (8442.98 − 1.14·5102.54)/0.14 ≈ 18,747 USD → /0.18 XLM.
    expect(Number(proposal.steps[2].amount)).toBeCloseTo(104209.71, 0);
  });

  it("re-sizes a wallet-funded repay from a stale bundle: the debt is re-read, the plan is deposit → repay (13 Sep 409)", async () => {
    // "I want zero debt": the model sizes the repay from idle XLM. The account is what repays,
    // so the sizer expands it to deposit (capped by the debt) → repay. Two minutes later the
    // bundle is stale; propose must re-read the debt too, not only the market set.
    let turn = 0;
    const view = await researchTurn(
      { message: "I want zero debt but keep all my collateral", wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }, { capability: "account_debt", args: {} }] }
          : { ...modelComplete, goal: { ...modelComplete.goal, objective: "Repay all debt without withdrawing collateral", borrowing: "forbidden" },
              plans: [{ title: "Repay XLM debt using idle wallet XLM", rationale: "Wallet XLM covers part of the XLM debt (e1, e2).", evidenceIds: ["e1", "e2"],
                legs: [{ op: "repay", asset: "XLM", sizing: { kind: "all_idle" } }] }] },
      },
    );
    const target = "composed:re.XLM";
    const option = view.candidates?.feasible.find((c) => c.id === target);
    expect(option?.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "10206.3356118"], ["repay", "10206.3356118"]]);
    const proposal = await proposeWorkflow({
      continuation: view.continuation, candidateId: target, subject: SCOPE.subject, secret: SECRET, server: "mcp-test",
      network: "testnet", mcp, signal: new AbortController().signal, now: Date.now() + 120_000,
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.steps.map((s) => s.op)).toEqual(["deposit_collateral", "repay"]);
    expect(mcp.call.mock.calls.map((c) => c[0])).toContain("vanna_get_debt");
  });

  it("when the Margin page and the liquidation engine disagree, sizes the deposit but refuses the borrow with both figures", async () => {
    // 13 Sep live: app $6,605.84 / $5,102.54 vs contract $6,457.32 / $5,110.67 — past the drift band.
    harness.computeSizingBasis.mockResolvedValue({
      grossCollateralUsd: "6457.32", debtUsd: "5110.67", source: "contract", issue: "sizing_sources_disagree",
      app: { grossCollateralUsd: "6605.84", debtUsd: "5102.54" }, contract: { grossCollateralUsd: "6457.32", debtUsd: "5110.67" },
    });
    let turn = 0;
    const view = await researchTurn(
      { message: PROMPT, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }, { capability: "blend_markets", args: {} }] }
          : modelComplete,
      },
    );
    const deposit = view.candidates?.feasible.find((c) => c.id === "composed:dc.XLM+sb.XLM");
    expect(deposit).toBeTruthy();
    // Projected on the contract's figures, not the page's: (6457.32 + 1837.14) / 5110.67.
    expect(Number(deposit!.finalHealthFactor)).toBeCloseTo(1.6229, 3);
    expect(view.candidates?.feasible.map((c) => c.id)).not.toContain("composed:dc.XLM+sb.XLM+bo.XLM+sb.XLM");
    expect(view.candidates?.rejected).toContainEqual(expect.objectContaining({
      label: "Move idle XLM into Blend, then lever to the floor",
      reason: expect.stringMatching(/^borrow XLM: the Margin page and the liquidation engine disagree on your position \(collateral \$6605\.84 vs \$6457\.32, debt \$5102\.54 vs \$5110\.67\)/),
    }));
    expect(view.warnings).toContainEqual(expect.stringMatching(/Margin page snapshot and the contract liquidation snapshot disagree/));
  });

  it("refuses a composed id the investigation never sealed", async () => {
    let turn = 0;
    const view = await researchTurn(
      { message: PROMPT, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: SECRET, mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "wallet_balances", args: {} }] }
          : modelComplete,
      },
    );
    await expect(proposeWorkflow({
      continuation: view.continuation, candidateId: "composed:bo.XLM+bo.XLM+bo.XLM", subject: SCOPE.subject, secret: SECRET, server: "mcp-test",
      network: "testnet", mcp, signal: new AbortController().signal,
    })).rejects.toThrow(/not proposed by the completed investigation/);
  });
});
