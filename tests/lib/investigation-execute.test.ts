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

/**
 * 15 Sep, live: the identical 1,000 XLM → AQUSDC swap was refused by the DEX at approve
 * time (HostError #2006) and filled at the same floor minutes later. The floor is derived
 * when the plan is built and sent when the user approves it, and the pool does not stand
 * still in between — so the pool is re-quoted immediately before the write.
 */
describe("advanceWorkflow — a swap's floor is re-checked against the pool before it is sent", () => {
  const POOL = "vanna_get_aquarius_pool_stats";
  const swapStep = {
    id: "one", op: "swap" as const, asset: "XLM", amount: "1000",
    label: "Swap 1000 XLM for at least 147.3333 AQUSDC on Aquarius",
    tool: "vanna_swap",
    args: {
      smart_account: SCOPE.smartAccount, token_in: "XLM", token_out: "AQUSDC",
      amount_in: "1000", min_out: "147.3333", trader: SCOPE.trader, venue: "aquarius",
    },
  };

  async function approvedSwap() {
    const journal = new WorkflowJournal(harness.store);
    const created = await journal.create({
      scope: SCOPE, server: SERVER, objective: "Swap XLM to AQUSDC",
      messages: ["swap 1000 xlm to AQUSDC"], assumptions: [], constraints: [], floor: "1.30",
      steps: [swapStep],
    });
    await journal.approve(created.proposal.id, { scope: SCOPE, server: SERVER }, 1, created.proposal.digest, async () => null);
    return created.proposal.id;
  }

  const poolPaying = (xlm: string, aqusdc: string) =>
    ({ found: true, pool: { available: true, reserves: { XLM: xlm, AQUSDC: aqusdc }, total_share: "40000", fee: "0.0030" } });

  it("sends the approved floor unchanged when the pool still pays it", async () => {
    const id = await approvedSwap();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcp: McpCall = {
      call: async (tool, args) => {
        seen.push({ tool, args: args as Record<string, unknown> });
        // 100,000 XLM / 15,000 AQUSDC quotes 148.07 — above the 147.3333 approved.
        if (tool === POOL) return poolPaying("100000", "15000");
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(id, mcp);
    expect(seen.map((s) => s.tool)).toEqual([POOL, "vanna_swap"]);
    // The floor the user approved is the floor that gets signed — never re-derived upward.
    expect(seen[1].args.min_out).toBe("147.3333");
    expect(view.status).toBe("completed");
  });

  it("refuses with both figures when the pool has moved below the approved floor, and sends nothing", async () => {
    const id = await approvedSwap();
    const seen: string[] = [];
    const mcp: McpCall = {
      call: async (tool) => {
        seen.push(tool);
        // 100,000 XLM / 14,000 AQUSDC quotes ~138.2 — below the 147.3333 approved.
        if (tool === POOL) return poolPaying("100000", "14000");
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(id, mcp);
    expect(seen).toEqual([POOL]);
    expect(view.steps[0].status).toBe("failed");
    const message = String(view.steps[0].message);
    expect(message).toContain("the pool's price moved after you approved this");
    expect(message).toContain("147.3333 AQUSDC floor you approved");
    expect(message).toContain("The floor was not lowered to fit");
    expect(view.steps[0].txHash).toBeUndefined();
  });

  it("fails open: a pool read that errors never blocks a swap the user approved", async () => {
    const id = await approvedSwap();
    const seen: string[] = [];
    const mcp: McpCall = {
      call: async (tool) => {
        seen.push(tool);
        if (tool === POOL) throw new Error("amm api unreachable");
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(id, mcp);
    expect(seen).toEqual([POOL, "vanna_swap"]);
    expect(view.status).toBe("completed");
  });

  it("leaves every non-swap write alone — no extra pool round-trip", async () => {
    const id = await approvedBorrow();
    const seen: string[] = [];
    const mcp: McpCall = {
      call: async (tool) => { seen.push(tool); return { status: "signed_and_submitted", tx_hash: HASH }; },
    };
    await advance(id, mcp);
    expect(seen).toEqual(["vanna_borrow"]);
  });
});
