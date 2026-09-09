import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";

/**
 * Drive an approved journal through MCP writes without touching live RPC or disk.
 *
 * `ready` and `lookupTx` are injected. The store is the same in-memory CAS the journal
 * tests use — `workflowJournal()` would otherwise write under `.local`.
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

const { WorkflowJournal } = await import("@/lib/copilot/workflow/journal");
const { advanceWorkflow } = await import("@/lib/copilot/investigation/execute");
type McpCall = Pick<import("@/lib/copilot/mcp-client").MCPClient, "call">;

const SCOPE = {
  subject: "owner",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};
const SERVER = "https://mcp.test";
const SECRET = "workflow-test-secret-with-at-least-32-characters";
const HASH = "a".repeat(64);

async function approvedBorrow() {
  const journal = new WorkflowJournal(harness.store);
  const created = await journal.create({
    scope: SCOPE, server: SERVER, objective: "Borrow USDC to Blend",
    messages: ["Keep HF above 1.3"], assumptions: [], constraints: ["Health factor at or above 1.30"],
    floor: "1.30",
    steps: [{
      id: "one", op: "borrow", asset: "BLUSDC", amount: "50", label: "Borrow 50 USDC",
      tool: "vanna_borrow", args: { symbol: "USDC", amount: "50", trader: SCOPE.trader, smart_account: SCOPE.smartAccount },
    }],
  });
  await journal.approve(created.proposal.id, { scope: SCOPE, server: SERVER }, 1, created.proposal.digest, async () => null);
  return created.proposal.id;
}

function advance(id: string, mcp: McpCall) {
  return advanceWorkflow({
    id, subject: SCOPE.subject, secret: SECRET, server: SERVER, network: SCOPE.network,
    mcp, signal: new AbortController().signal,
    ready: async () => ({ kind: "ready" }),
    lookupTx: async () => ({ found: true, success: true, ledger: 42 }),
  });
}

beforeEach(() => {
  harness.reset();
  harness.resolveInvestigationScope.mockReset();
  harness.resolveInvestigationScope.mockResolvedValue(SCOPE);
});

describe("advanceWorkflow", () => {
  it("settles a signed_and_submitted write from the recorded hash", async () => {
    const id = await approvedBorrow();
    const seen: unknown[] = [];
    const mcp: McpCall = {
      call: async (tool, args, userId) => {
        seen.push(tool, args, userId);
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(id, mcp);
    expect(seen[0]).toBe("vanna_borrow");
    expect(seen[1]).toEqual(expect.objectContaining({
      amount: "50", symbol: "USDC", trader: SCOPE.trader, smart_account: SCOPE.smartAccount,
    }));
    expect(seen[2]).toBe(SCOPE.trader);
    expect(view.status).toBe("completed");
    expect(view.steps[0]).toMatchObject({ status: "settled", txHash: HASH, settledLedger: 42 });
  });

  it("pauses for wallet signature when MCP returns unsigned XDR", async () => {
    const id = await approvedBorrow();
    const xdr = "A".repeat(80);
    const mcp: McpCall = { call: async () => ({ unsigned_xdr: xdr }) };
    const view = await advance(id, mcp);
    expect(view.status).toBe("awaiting_signature");
    expect(view.steps[0]).toMatchObject({ status: "awaiting_signature", unsignedXdr: xdr });
    expect(view.steps[0].txHash).toBeUndefined();
  });

  it("blocks a simulation error without recording a hash", async () => {
    const id = await approvedBorrow();
    const mcp: McpCall = {
      call: async () => ({
        error: "simulation_failed",
        message: "Host function failed. Nothing was submitted.",
      }),
    };
    const view = await advance(id, mcp);
    expect(view.status).toBe("uncertain");
    expect(view.steps[0].status).toBe("uncertain");
    expect(view.steps[0].txHash).toBeUndefined();
    expect(view.message).toMatch(/could not be confirmed/);
  });

  it("sends vanna_lend with lender on the G-wallet, not a margin overlay", async () => {
    const journal = new WorkflowJournal(harness.store);
    const created = await journal.create({
      scope: SCOPE, server: SERVER, objective: "Lend idle BLUSDC to Earn",
      messages: ["Keep HF above 1.3"], assumptions: [], constraints: [],
      floor: "1.30",
      steps: [{
        id: "one", op: "lend", asset: "BLUSDC", amount: "680", label: "Lend 680 BLUSDC to Earn",
        tool: "vanna_lend", args: { symbol: "USDC", amount: "680", lender: SCOPE.trader },
      }],
    });
    await journal.approve(created.proposal.id, { scope: SCOPE, server: SERVER }, 1, created.proposal.digest, async () => null);
    const seen: unknown[] = [];
    const mcp: McpCall = {
      call: async (tool, args, userId) => {
        seen.push(tool, args, userId);
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(created.proposal.id, mcp);
    expect(seen[0]).toBe("vanna_lend");
    expect(seen[1]).toEqual({ symbol: "USDC", amount: "680", lender: SCOPE.trader });
    expect(seen[1]).not.toEqual(expect.objectContaining({ smart_account: SCOPE.smartAccount }));
    expect(view.status).toBe("completed");
  });
});
