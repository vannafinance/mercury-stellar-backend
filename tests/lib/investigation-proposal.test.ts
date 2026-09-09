vi.mock("@/lib/copilot/workflow/risk", () => ({ validateWorkflowRisk: vi.fn(async () => null) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";
import { compactResearchEvidence } from "@/lib/copilot/investigation/evidence";
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

vi.mock("@/lib/copilot/investigation/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/capacity")>();
  return { ...actual, computeBorrowCapacity: harness.computeBorrowCapacity };
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
    observation({
      id: "e1", capability: "earn_market", args: { asset: "BLUSDC" },
      data: { supply_apr_pct: "25.41", borrow_apr_pct: "4" },
    }),
    observation({
      id: "e2", capability: "blend_markets",
      data: { reserves: [{ venue: "blend", symbol: "USDC", supply_apr_pct: "10" }] },
    }),
    observation({
      id: "e3", capability: "asset_price", args: { asset: "BLUSDC" },
      data: { price_usd: "1" },
    }),
    observation({
      id: "e4", capability: "wallet_balances",
      data: { assets: [{ symbol: "BLUSDC", balance: "680" }] },
    }),
  ];
}

function continuation(capturedAt = NOW) {
  const codec = researchCodec(SECRET, SERVER, () => NOW);
  const evidence = compactResearchEvidence(evidenceObservations(), CAPACITY, capturedAt);
  evidence.allowedCandidateIds = ["borrow_supply_BLUSDC", "lend_idle_BLUSDC"];
  return codec.seal(SCOPE, ["Keep HF above 1.3. You can take new loans."], null, evidence);
}

beforeEach(() => {
  harness.reset();
  harness.resolveInvestigationScope.mockReset();
  harness.computeBorrowCapacity.mockReset();
  harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
  harness.computeBorrowCapacity.mockRejectedValue(new Error("capacity re-read should not run on fresh evidence"));
});

describe("proposeWorkflow evidence reuse", () => {
  it("compiles from sealed evidence without a second market or snapshot read", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("MCP should not be called when evidence is fresh"); }) };
    const view = await proposeWorkflow({
      continuation: continuation(), candidateId: "borrow_supply_BLUSDC",
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).not.toHaveBeenCalled();
    expect(harness.computeBorrowCapacity).not.toHaveBeenCalled();
    expect(view.status).toBe("proposed");
    expect(view.steps.map((step) => step.op)).toEqual(["borrow", "supply_blend"]);
    expect(view.steps[0].amount).toBe(view.steps[1].amount);
  });

  it("prepares an Earn idle plan from the same sealed bundle", async () => {
    const mcp = { call: vi.fn(async () => { throw new Error("MCP should not be called when evidence is fresh"); }) };
    const view = await proposeWorkflow({
      continuation: continuation(), candidateId: "lend_idle_BLUSDC",
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).not.toHaveBeenCalled();
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ op: "lend", amount: "680", asset: "BLUSDC" });
  });

  it("falls back to live reads when the sealed bundle is older than a minute", async () => {
    harness.computeBorrowCapacity.mockResolvedValue(CAPACITY);
    const mcp = {
      call: vi.fn(async (tool: string) => {
        if (tool === "vanna_get_wallet_balance") return { assets: [{ symbol: "BLUSDC", balance: "680" }] };
        if (tool === "vanna_get_price") return { price_usd: "1" };
        if (tool === "vanna_get_pool_stats") return { supply_apr_pct: "25.41", borrow_apr_pct: "4" };
        if (tool === "vanna_list_blend_reserves") {
          return { reserves: [{ venue: "blend", symbol: "USDC", supply_apr_pct: "10" }] };
        }
        throw new Error(`unexpected ${tool}`);
      }),
    };
    const view = await proposeWorkflow({
      continuation: continuation(NOW - 61_000), candidateId: "borrow_supply_BLUSDC",
      subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
      mcp, signal: new AbortController().signal, now: NOW,
    });
    expect(mcp.call).toHaveBeenCalled();
    expect(harness.computeBorrowCapacity).toHaveBeenCalled();
    expect(view.status).toBe("proposed");
    expect(view.steps.map((step) => step.op)).toEqual(["borrow", "supply_blend"]);
  });
});
