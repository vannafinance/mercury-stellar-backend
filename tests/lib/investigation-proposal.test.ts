vi.mock("@/lib/copilot/workflow/risk", () => ({ validateWorkflowRisk: vi.fn(async () => null) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateWorkflowRisk } from "@/lib/copilot/workflow/risk";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";
import { compactResearchEvidence } from "@/lib/copilot/investigation/evidence";
import { computeMarginSnapshot } from "@/lib/account-snapshot";
import { candidateId, REQUESTED_ACTIONS_ID } from "@/lib/copilot/investigation/candidate-id";
import { researchCodec } from "@/lib/copilot/investigation/continuation";
import type { Observation } from "@/lib/copilot/investigation/types";

/**
 * Propose must compile from sealed investigation evidence when that bundle is
 * still fresh. Re-reading markets and the margin snapshot is the 30–60s path
 * auto-propose used to take after the card already had the numbers.
 */

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
    reset() { row = null; },
    resolveInvestigationScope: vi.fn(),
    computeBorrowCapacity: vi.fn(),
    computeSizingBasis: vi.fn(),
  };
});

// The app snapshot is the slow, uncancellable read; propose attempts it once, bounded.
vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return { ...actual, computeMarginSnapshot: vi.fn(async () => ({ grossCollateralValue: 4219.36, totalBorrowedValue: 1736.19 })) };
});

vi.mock("@/lib/copilot/workflow/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/workflow/store")>();
  return { ...actual, workflowStore: () => harness.store };
});

vi.mock("@/lib/copilot/investigation/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/scope")>();
  return { ...actual, resolveInvestigationScope: harness.resolveInvestigationScope };
});

vi.mock("@/lib/copilot/investigation/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/capacity")>();
  return { ...actual, computeBorrowCapacity: harness.computeBorrowCapacity, computeSizingBasis: harness.computeSizingBasis };
});

const { proposeWorkflow } = await import("@/lib/copilot/investigation/proposal");

const SCOPE = {
  subject: "owner",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};
const SERVER = "https://mcp.test";
const SECRET = "workflow-test-secret-with-at-least-32-characters";
const NOW = 1_700_000_000_000;
const CAPACITY = {
  floor: "1.30",
  grossCollateralUsd: "4219.36",
  debtUsd: "1736.19",
  healthFactor: "2.43",
  maxBorrowUsd: "6541.043333333333333333",
};

function observation(over: Partial<Observation> & Pick<Observation, "id" | "capability">): Observation {
  return { args: {}, observedAt: NOW, status: "ok", ...over };
}

function evidenceObservations(): Observation[] {
  return [
    // Blend USDC pays 10% while Earn charges 4% to borrow BLUSDC: a positive carry.
    observation({
      id: "e1", capability: "earn_market", args: { asset: "BLUSDC" },
      data: { supply_apr_pct: "2", borrow_apr_pct: "4", utilization_pct: "60" },
    }),
    observation({
      id: "e2", capability: "blend_markets",
      data: { reserves: [{ venue: "blend", symbol: "USDC", supply_apr_pct: "10", borrow_apr_pct: "12", utilization_pct: "90" }] },
    }),
    observation({
      id: "e3", capability: "asset_price", args: { asset: "BLUSDC" },
      data: { price_usd: "1" },
    }),
    // AQUSDC has no Blend reserve, so idle AQUSDC can only go to Earn.
    observation({
      id: "e5", capability: "earn_market", args: { asset: "AQUSDC" },
      data: { supply_apr_pct: "25.41", borrow_apr_pct: "30", utilization_pct: "90" },
    }),
    observation({
      id: "e4", capability: "wallet_balances",
      data: { assets: [{ symbol: "AQUSDC", balance: "680" }] },
    }),
  ];
}

function continuation(capturedAt = NOW) {
  const codec = researchCodec(SECRET, SERVER, () => NOW);
  const evidence = compactResearchEvidence(evidenceObservations(), CAPACITY, capturedAt);
  evidence.allowedCandidateIds = [candidateId("borrow_supply", "BLUSDC"), candidateId("lend_idle", "AQUSDC")];
  return codec.seal(SCOPE, ["Keep HF above 1.3. You can take new loans."], null, evidence);
}

beforeEach(() => {
  harness.reset();
  harness.resolveInvestigationScope.mockReset();
  harness.computeBorrowCapacity.mockReset();
  vi.mocked(validateWorkflowRisk).mockClear();
  harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
  harness.computeBorrowCapacity.mockRejectedValue(new Error("capacity re-read should not run on fresh evidence"));
  harness.computeSizingBasis.mockReset().mockRejectedValue(new Error("basis re-read should not run on fresh evidence"));
});

describe("proposeWorkflow evidence reuse", () => {
  it("compiles from sealed evidence without a second market or snapshot read", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("MCP should not be called when evidence is fresh"); }) };
    const view = await proposeWorkflow({
      continuation: continuation(), candidateId: candidateId("borrow_supply", "BLUSDC"),
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).not.toHaveBeenCalled();
    expect(harness.computeBorrowCapacity).not.toHaveBeenCalled();
    expect(validateWorkflowRisk).not.toHaveBeenCalled();
    expect(view.status).toBe("proposed");
    expect(view.steps.map((step) => step.op)).toEqual(["borrow", "supply_blend"]);
    expect(view.steps[0].amount).toBe(view.steps[1].amount);
  });

  it("prepares an Earn idle plan from the same sealed bundle", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("MCP should not be called when evidence is fresh"); }) };
    const view = await proposeWorkflow({
      continuation: continuation(), candidateId: candidateId("lend_idle", "AQUSDC"),
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).not.toHaveBeenCalled();
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ op: "lend", amount: "680", asset: "AQUSDC" });
  });

  it("falls back to live reads when the sealed bundle is older than a minute", async () => {
    // One live basis (app snapshot agreed with the contract); headroom derives from it at the stated floor.
    harness.computeSizingBasis.mockResolvedValue({
      grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd, source: "contract", issue: null,
      app: { grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd },
      contract: { grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd },
    });
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "AQUSDC", balance: "680" }] };
        if (tool === "vanna_get_price") return { price_usd: "1" };
        if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "2", borrow_apr_pct: "4", utilization_pct: "60" };
        if (tool === "vanna_list_blend_reserves") {
          return { reserves: [{ venue: "blend", symbol: "USDC", supply_apr_pct: "10", borrow_apr_pct: "12", utilization_pct: "90" }] };
        }
        throw new Error(`unexpected ${tool}`);
      }),
    };
    const view = await proposeWorkflow({
      continuation: continuation(NOW - 61_000), candidateId: candidateId("borrow_supply", "BLUSDC"),
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).toHaveBeenCalled();
    expect(harness.computeSizingBasis).toHaveBeenCalledTimes(1);
    expect(view.status).toBe("proposed");
    expect(view.steps.map((step) => step.op)).toEqual(["borrow", "supply_blend"]);
  });

  /**
   * The world-read and the app snapshot are independent MCP round trips. Running them one
   * after another stacked their bounds — up to 15s each — on top of scope resolution, which
   * on a cold cache pushed a stale propose past the browser's 90s budget (15 Sep, D4). A
   * timing assertion is the only proof that they now overlap rather than merely that the
   * result is unchanged: both are delayed by the same amount, and the whole call must still
   * finish in less than their sum.
   */
  it("reads the world and the app snapshot together, not one after another", async () => {
    const DELAY_MS = 60;
    harness.computeSizingBasis.mockResolvedValue({
      grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd, source: "contract", issue: null,
      app: { grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd },
      contract: { grossCollateralUsd: CAPACITY.grossCollateralUsd, debtUsd: CAPACITY.debtUsd },
    });
    vi.mocked(computeMarginSnapshot).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      // Matches the shape the module-level mock above returns; that one is inferred loosely
      // inside the vi.mock factory, this call is against the real signature.
      return { grossCollateralValue: 4219.36, totalBorrowedValue: 1736.19 } as unknown as Awaited<ReturnType<typeof computeMarginSnapshot>>;
    });
    const mcp = {
      call: vi.fn(async (tool: string) => {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "AQUSDC", balance: "680" }] };
        if (tool === "vanna_get_price") return { price_usd: "1" };
        if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "2", borrow_apr_pct: "4", utilization_pct: "60" };
        if (tool === "vanna_list_blend_reserves") {
          return { reserves: [{ venue: "blend", symbol: "USDC", supply_apr_pct: "10", borrow_apr_pct: "12", utilization_pct: "90" }] };
        }
        throw new Error(`unexpected ${tool}`);
      }),
    };
    const startedAt = Date.now();
    const view = await proposeWorkflow({
      continuation: continuation(NOW - 61_000), candidateId: candidateId("borrow_supply", "BLUSDC"),
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    // Sequential would be at least 2 x DELAY_MS for these two legs alone; parallel is ~1 x.
    expect(Date.now() - startedAt).toBeLessThan(DELAY_MS * 2);
    expect(view.status).toBe("proposed");
  });
});

/** A stated exact-output swap — the shape the copilot proposes for "swap XLM so i get 1 AQUSDC". */
const SWAP_STEP = {
  id: "requested-0",
  op: "swap" as const,
  asset: "XLM",
  amount: "84.6004692",
  label: "Swap 84.6004692 XLM for at least 1 AQUSDC on Aquarius",
  tool: "vanna_swap",
  sizing: { basis: "stated" as const },
  targetOut: "1",
  args: {
    token_in: "XLM", token_out: "AQUSDC", amount_in: "84.6004692", min_out: "1",
    venue: "aquarius", trader: SCOPE.trader, smart_account: SCOPE.smartAccount,
  },
};

describe("proposeWorkflow requested_actions", () => {
  it("creates the journal from sealed steps without MCP or risk validation", async () => {
    const codec = researchCodec(SECRET, SERVER, () => NOW);
    const evidence = compactResearchEvidence([], null, NOW);
    evidence.allowedCandidateIds = [REQUESTED_ACTIONS_ID];
    evidence.requestedSteps = [{
      id: "requested-0",
      op: "repay",
      asset: "XLM",
      amount: "1",
      label: "repay 1 XLM",
      tool: "vanna_repay",
      sizing: { basis: "stated" },
      args: {
        symbol: "XLM", amount: "1", trader: SCOPE.trader, smart_account: SCOPE.smartAccount,
      },
    }];
    const mcp = { call: vi.fn(async () => { throw new Error("MCP should not run for a stated repay"); }) };
    const view = await proposeWorkflow({
      continuation: codec.seal(SCOPE, ["repay 1 XLM from my account"], null, evidence),
      candidateId: REQUESTED_ACTIONS_ID,
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).not.toHaveBeenCalled();
    expect(validateWorkflowRisk).not.toHaveBeenCalled();
    expect(view.status).toBe("proposed");
    expect(view.steps).toEqual([expect.objectContaining({ op: "repay", asset: "XLM", amount: "1" })]);
  });

  /**
   * A stated swap is proposed through THIS branch, and the acceptance the user stated in
   * their own words has to reach the stored proposal — it is what the pre-write re-quote
   * and the MCP's impact gate both read at execution time. Sealed on the research and
   * dropped here, the card appears and the swap is then withheld twice over for a price
   * the user had already agreed to, with nothing left for them to say.
   */
  it("carries the sealed slippage acceptance into the stored proposal", async () => {
    const codec = researchCodec(SECRET, SERVER, () => NOW);
    const evidence = compactResearchEvidence([], null, NOW);
    evidence.allowedCandidateIds = [REQUESTED_ACTIONS_ID];
    evidence.slippageAccepted = true;
    evidence.requestedSteps = [SWAP_STEP];
    const view = await proposeWorkflow({
      continuation: codec.seal(SCOPE, ["swap xlm so i get 1 AQUSDC, i accept the loss"], null, evidence),
      candidateId: REQUESTED_ACTIONS_ID,
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp: { call: vi.fn() }, signal: new AbortController().signal, now: NOW,
    });
    expect(view.status).toBe("proposed");
    expect((await harness.store.read(""))?.value.proposal.slippageAccepted).toBe(true);
  });

  it("leaves it false when the user never accepted — the refusal is the default", async () => {
    const codec = researchCodec(SECRET, SERVER, () => NOW);
    const evidence = compactResearchEvidence([], null, NOW);
    evidence.allowedCandidateIds = [REQUESTED_ACTIONS_ID];
    evidence.requestedSteps = [SWAP_STEP];
    await proposeWorkflow({
      continuation: codec.seal(SCOPE, ["swap xlm so i get 1 AQUSDC"], null, evidence),
      candidateId: REQUESTED_ACTIONS_ID,
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp: { call: vi.fn() }, signal: new AbortController().signal, now: NOW,
    });
    expect((await harness.store.read(""))?.value.proposal.slippageAccepted).toBe(false);
  });
});
