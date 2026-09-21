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
const { advanceWorkflow, staleLiquidityAmounts, staleSwapFloor, stalePositionAmount } = await import("@/lib/copilot/investigation/execute");
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
 * 15 Sep, live, twice over. First: the identical swap was refused by the DEX (HostError
 * #2006) at approve time and filled fine minutes later — a moved price alone, wrongly
 * treated as fatal. Then, once fixed to re-quote instead of refusing outright: "it is not
 * mandatory [that the exact number holds] — whatever price is available after the plan
 * executes, it should execute, with a clear message of what price it swapped at — don't
 * fail it unless it's actually dangerous." So a moved price adjusts the floor down and
 * proceeds, with a note recording what actually happened; only a fill that would itself be
 * a bad trade (the same oracle price-impact threshold the propose-time card refuses on)
 * stops the write.
 */
describe("advanceWorkflow — a swap's floor is re-checked against the pool before it is sent", () => {
  const POOL = "vanna_get_aquarius_pool_stats";
  const PRICE = "vanna_get_price";
  // Reserves 100,000 XLM / 17,730 AQUSDC quote ~175.0231 for 1,000 XLM — a normal spread
  // under oracle parity ($180 at $0.18/XLM), floored 0.5% down to 174.148 at approve time.
  const swapStep = {
    id: "one", op: "swap" as const, asset: "XLM", amount: "1000",
    label: "Swap 1000 XLM for at least 174.148 AQUSDC on Aquarius",
    tool: "vanna_swap",
    args: {
      smart_account: SCOPE.smartAccount, token_in: "XLM", token_out: "AQUSDC",
      amount_in: "1000", min_out: "174.148", trader: SCOPE.trader, venue: "aquarius",
    },
  };

  it("does not lower an exact-output target when the pool moves", async () => {
    const mcp: McpCall = { call: async () => poolPaying("100000", "17600") };
    const verdict = await staleSwapFloor({ ...swapStep, targetOut: "174" }, mcp, SCOPE.trader!, new AbortController().signal);
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind === "refuse") expect(verdict.message).toContain("below the 174 AQUSDC you approved");
  });

  it("swap_killed on the AMM API does not block a swap the pool can still fill", async () => {
    const id = await approvedSwap();
    const seen: string[] = [];
    const mcp: McpCall = { call: async (tool) => {
      seen.push(tool);
      if (tool === POOL) {
        return { ...poolPaying("100000", "17750"), pool: { ...poolPaying("100000", "17750").pool, swap_killed: true } };
      }
      return { status: "signed_and_submitted", tx_hash: HASH };
    } };
    const view = await advance(id, mcp);
    expect(seen).toEqual([POOL, "vanna_swap"]);
    expect(view.status).toBe("completed");
    expect(String(view.steps[0].message ?? "")).not.toMatch(/paused/i);
  });

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
  const price = (usd: string) => ({ price_usd: usd });
  /**
   * vanna_get_price is called once per symbol; route by the symbol argument. Every call
   * (price or otherwise) is recorded into `seen` here, so callers only supply the non-price
   * behavior.
   */
  function withPrices(
    seen: Array<{ tool: string; args: Record<string, unknown> }>,
    mcp: (tool: string, args: Record<string, unknown>) => Record<string, unknown>,
  ): McpCall {
    return {
      call: async (tool, args) => {
        const a = args as Record<string, unknown>;
        seen.push({ tool, args: a });
        if (tool === PRICE) return price(String(a.symbol) === "XLM" ? "0.18" : "1");
        return mcp(tool, a);
      },
    };
  }

  it("sends the approved floor unchanged when the pool still pays it — no oracle call needed", async () => {
    const id = await approvedSwap();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcp: McpCall = {
      call: async (tool, args) => {
        seen.push({ tool, args: args as Record<string, unknown> });
        // 100,000 XLM / 17,750 AQUSDC quotes ~175.22 — above the 174.148 approved.
        if (tool === POOL) return poolPaying("100000", "17750");
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(id, mcp);
    expect(seen.map((s) => s.tool)).toEqual([POOL, "vanna_swap"]);
    // The floor the user approved is the floor that gets signed — never re-derived upward,
    // and never needs an oracle round-trip when the approved floor is already met.
    expect(seen[1].args.min_out).toBe("174.148");
    expect(view.status).toBe("completed");
  });

  it("lowers the floor and proceeds when the price moved but the fresh fill is still fair, and says so plainly", async () => {
    const id = await approvedSwap();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcp = withPrices(seen, (tool) =>
      // 100,000 XLM / 17,600 AQUSDC quotes ~173.74 — below the 174.148 approved, but only
      // 3.48% under the $180 oracle value of the XLM spent: an ordinary spread, not a red flag.
      tool === POOL ? poolPaying("100000", "17600") : { status: "signed_and_submitted", tx_hash: HASH });
    const view = await advance(id, mcp);
    expect(seen.map((s) => s.tool)).toEqual([POOL, PRICE, PRICE, "vanna_swap"]);
    const sent = seen.find((s) => s.tool === "vanna_swap")!;
    // Sent at the FRESH floor (0.5% below the ~173.74 the pool actually quotes), not the
    // stale 174.148 the pool can no longer pay, and not a refusal either.
    expect(Number(sent.args.min_out)).toBeCloseTo(172.87, 1);
    expect(Number(sent.args.min_out)).toBeLessThan(174.148);
    expect(view.status).toBe("completed");
    const message = String(view.message);
    expect(message).toContain("The pool's price moved after you approved this");
    expect(message).toContain("173.7");
    expect(message).toContain("174.148 AQUSDC originally quoted for 1000 XLM");
  });

  it("still refuses when the fresh fill would itself be a bad trade, naming both figures, and sends nothing", async () => {
    const id = await approvedSwap();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcp = withPrices(seen, (tool) =>
      // 100,000 XLM / 14,000 AQUSDC quotes ~138.2 — 23.2% below the $180 oracle value of
      // the XLM spent, well past the 5% threshold the propose-time card itself refuses on.
      tool === POOL ? poolPaying("100000", "14000") : { status: "signed_and_submitted", tx_hash: HASH });
    const view = await advance(id, mcp);
    expect(seen.map((s) => s.tool)).toEqual([POOL, PRICE, PRICE]);
    expect(view.steps[0].status).toBe("failed");
    const message = String(view.steps[0].message);
    expect(message).toContain("the pool's price moved after you approved this, and now fills at a loss");
    expect(message).toContain("174.148 AQUSDC floor you approved");
    expect(view.steps[0].txHash).toBeUndefined();
  });

  it("proceeds at the fresh quote when the oracle price is unavailable, rather than blocking on it", async () => {
    const id = await approvedSwap();
    const seen: string[] = [];
    const mcp: McpCall = {
      call: async (tool) => {
        seen.push(tool);
        if (tool === POOL) return poolPaying("100000", "17600");
        if (tool === PRICE) throw new Error("oracle unreachable");
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(id, mcp);
    // Both price legs are requested concurrently; one throwing fails the pair, and the
    // write proceeds at the pool's own fresh quote rather than blocking on the oracle.
    expect(seen).toEqual([POOL, PRICE, PRICE, "vanna_swap"]);
    expect(view.status).toBe("completed");
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

describe("advanceWorkflow — LP amounts are refreshed against the pool before they are sent", () => {
  const lpStep = {
    id: "one", op: "add_liquidity" as const, asset: "XLM", amount: "100",
    label: "Add 100 XLM + 20 AQUSDC to the Aquarius pool",
    tool: "vanna_add_liquidity",
    args: {
      smart_account: SCOPE.smartAccount, token_a: "XLM", token_b: "AQUSDC",
      amount_a: "100", amount_b: "20", min_liquidity_out: "9.95",
      trader: SCOPE.trader, venue: "aquarius",
    },
  };
  const pool = (xlm: string, paired: string, shares = "100") => ({
    found: true,
    pool: { available: true, reserves: { XLM: xlm, AQUSDC: paired }, total_share: shares, fee: "0.0030" },
  });

  async function approvedLp() {
    const journal = new WorkflowJournal(harness.store);
    const created = await journal.create({
      scope: SCOPE, server: SERVER, objective: "Add Aquarius liquidity",
      messages: ["add 100 XLM liquidity"], assumptions: [], constraints: [], floor: null,
      steps: [lpStep],
    });
    await journal.approve(created.proposal.id, { scope: SCOPE, server: SERVER }, 1, created.proposal.digest, async () => null);
    return created.proposal.id;
  }

  it("recomputes the paired amount and share floor from the latest reserves", async () => {
    const verdict = await staleLiquidityAmounts(
      lpStep,
      { call: async () => pool("1000", "150", "100") },
      SCOPE.trader!,
      new AbortController().signal,
    );
    expect(verdict).toMatchObject({
      kind: "adjusted", amountA: "100", amountB: "15", minLiquidityOut: "9.95",
    });
  });

  it("never increases either approved spend when the ratio moves", async () => {
    const verdict = await staleLiquidityAmounts(
      lpStep,
      { call: async () => pool("1000", "250", "100") },
      SCOPE.trader!,
      new AbortController().signal,
    );
    expect(verdict).toMatchObject({
      kind: "adjusted", amountA: "80", amountB: "20", minLiquidityOut: "7.96",
    });
  });

  it("maps reserves correctly when the paired token is the stated side", async () => {
    const reversed = {
      ...lpStep,
      asset: "AQUSDC",
      amount: "20",
      args: { ...lpStep.args, token_a: "AQUSDC", token_b: "XLM", amount_a: "20", amount_b: "100" },
    };
    const verdict = await staleLiquidityAmounts(
      reversed,
      { call: async () => pool("1000", "250", "100") },
      SCOPE.trader!,
      new AbortController().signal,
    );
    expect(verdict).toMatchObject({
      kind: "adjusted", amountA: "20", amountB: "80", minLiquidityOut: "7.96",
    });
  });

  it("uses the Soroswap reserve reader for a Soroswap LP leg", async () => {
    const seen: string[] = [];
    const verdict = await staleLiquidityAmounts(
      { ...lpStep, args: { ...lpStep.args, token_b: "SOUSDC", venue: "soroswap" } },
      { call: async (tool) => { seen.push(tool); return pool("1000", "150", "100"); } },
      SCOPE.trader!,
      new AbortController().signal,
    );
    expect(seen).toEqual(["vanna_get_soroswap_pool_stats"]);
    expect(verdict).toMatchObject({ kind: "adjusted", amountA: "100", amountB: "15" });
  });

  it("sends the refreshed ratio to the MCP instead of the plan-time ratio", async () => {
    const id = await approvedLp();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcp: McpCall = { call: async (tool, args) => {
      seen.push({ tool, args: args as Record<string, unknown> });
      if (tool === "vanna_get_aquarius_pool_stats") return pool("1000", "150", "100");
      return { status: "signed_and_submitted", tx_hash: HASH };
    } };
    const view = await advance(id, mcp);
    expect(seen.map((entry) => entry.tool)).toEqual(["vanna_get_aquarius_pool_stats", "vanna_add_liquidity"]);
    expect(seen[1].args).toMatchObject({ amount_a: "100", amount_b: "15", min_liquidity_out: "9.95" });
    expect(view.status).toBe("completed");
    expect(String(view.message)).toContain("pool ratio was refreshed immediately before execution");
  });

  it("does not submit stale LP amounts when live reserves are unavailable", async () => {
    const id = await approvedLp();
    const seen: string[] = [];
    const view = await advance(id, { call: async (tool) => { seen.push(tool); throw new Error("offline"); } });
    expect(seen).toEqual(["vanna_get_aquarius_pool_stats"]);
    expect(view.steps[0].status).toBe("failed");
    expect(String(view.steps[0].message)).toContain("live reserves could not be refreshed");
  });
});

/**
 * "All of it" is a reading, and a reading goes stale while the plan waits for a click.
 *
 * A Blend supply accrues through its b-rate with nobody touching anything, so the
 * underlying the plan named stops being the underlying the position holds — between
 * sizing and approval, and again between approval and a signature when auto-sign is off.
 * Sending the frozen figure leaves dust behind, or reverts on chain when the balance
 * moved the other way, which is the worst moment to find out.
 *
 * The distinction pinned below is intent, not arithmetic: a number the user SAID is never
 * re-derived, and only a step whose sizing recorded `whole_position` is re-read.
 */
describe("advanceWorkflow — an amount that was the whole position is re-read before it is sent", () => {
  const BLEND = "vanna_get_blend_position";
  const signal = () => new AbortController().signal;

  /** A Blend exit sized from the position read, as `resolvePlan` records it. */
  const wholeStep = {
    id: "one", op: "blend_withdraw" as const, asset: "BLUSDC", amount: "876.38",
    label: "Withdraw all BLUSDC from Blend",
    tool: "vanna_blend_withdraw",
    args: { symbol: "USDC", amount: "876.38", smart_account: SCOPE.smartAccount, trader: SCOPE.trader },
    sizing: { basis: "whole_position" as const, read: "blend_position" },
  };
  const holding = (underlying: string) => ({ positions: [{ symbol: "USDC", underlying_value: underlying }] });

  it("sends what the position holds now, not the figure frozen at approval", async () => {
    const mcp: McpCall = { call: async () => holding("880.1207731") };
    const verdict = await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal());
    expect(verdict.kind).toBe("adjusted");
    if (verdict.kind === "adjusted") {
      expect(verdict.amount).toBe("880.1207731");
      expect(verdict.note).toContain("876.38");
      expect(verdict.note).toContain("880.1207731");
    }
  });

  it("re-reads a position that SHRANK just as readily as one that grew", async () => {
    const mcp: McpCall = { call: async () => holding("400") };
    const verdict = await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal());
    expect(verdict.kind).toBe("adjusted");
    if (verdict.kind === "adjusted") expect(verdict.amount).toBe("400");
  });

  it("leaves a number the user stated alone, and never spends a read on it", async () => {
    const seen: string[] = [];
    const mcp: McpCall = { call: async (tool) => { seen.push(tool); return holding("880.12"); } };
    const stated = { ...wholeStep, sizing: { basis: "stated" as const } };
    expect(await stalePositionAmount(stated, stated.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
    expect(seen).toEqual([]);
  });

  it("leaves a step with no sizing recorded alone — nothing claims it was the whole position", async () => {
    const seen: string[] = [];
    const mcp: McpCall = { call: async (tool) => { seen.push(tool); return holding("880.12"); } };
    const { sizing: _sizing, ...bare } = wholeStep;
    expect(await stalePositionAmount(bare, bare.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
    expect(seen).toEqual([]);
  });

  it("does not touch a write whose size is not called `amount`, and spends no read on it", async () => {
    // A swap is sized off account_collateral too, but states its size as `amount_in`.
    // Re-reading it would produce a note about an amount the args never carried.
    const seen: string[] = [];
    const mcp: McpCall = { call: async (tool) => { seen.push(tool); return holding("880.12"); } };
    const swapArgs = { token_in: "USDC", token_out: "XLM", amount_in: "876.38", trader: SCOPE.trader };
    const swapStep = {
      ...wholeStep, op: "swap" as const, tool: "vanna_swap", args: swapArgs,
      sizing: { basis: "whole_position" as const, read: "account_collateral" },
    };
    expect(await stalePositionAmount(swapStep, swapArgs, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
    expect(seen).toEqual([]);
  });

  it("sends the approved amount unchanged when the position has not moved", async () => {
    const mcp: McpCall = { call: async () => holding("876.38") };
    expect(await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
  });

  it("treats a trailing-zero re-read as unchanged rather than an adjustment", async () => {
    const mcp: McpCall = { call: async () => holding("876.3800000") };
    expect(await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
  });

  it("refuses when the position has since emptied, and says so instead of reverting on chain", async () => {
    const mcp: McpCall = { call: async () => holding("0") };
    const verdict = await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal());
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind === "refuse") expect(verdict.message).toContain("no BLUSDC left in that position");
  });

  it("fails open: a read that errors never blocks an exit the user approved", async () => {
    const mcp: McpCall = { call: async () => { throw new Error("upstream down"); } };
    expect(await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
  });

  it("fails open: an MCP error payload leaves the approved amount alone", async () => {
    const mcp: McpCall = { call: async () => ({ error: "unavailable" }) };
    expect(await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
  });

  it("fails open: a payload with no row for this asset is not read as an empty position", async () => {
    // The refusal is for a position that reads ZERO, never for one that failed to parse.
    const mcp: McpCall = { call: async () => ({ positions: [{ symbol: "XLM", underlying_value: "12" }] }) };
    expect(await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
  });

  it("fails open: a row the read marked untrusted is not spent", async () => {
    const mcp: McpCall = { call: async () => ({ positions: [{ symbol: "USDC", underlying_value: "880.12", balance_untrusted: true }] }) };
    expect(await stalePositionAmount(wholeStep, wholeStep.args, mcp, SCOPE, signal())).toEqual({ kind: "unchanged" });
  });

  it("end to end: the MCP receives the re-read amount and the note records what happened", async () => {
    const journal = new WorkflowJournal(harness.store);
    const created = await journal.create({
      scope: SCOPE, server: SERVER, objective: "Exit the Blend USDC supply",
      messages: ["withdraw all my blend usdc"], assumptions: [], constraints: [],
      floor: "1.30",
      steps: [wholeStep],
    });
    await journal.approve(created.proposal.id, { scope: SCOPE, server: SERVER }, 1, created.proposal.digest, async () => null);
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcp: McpCall = {
      call: async (tool, args) => {
        seen.push({ tool, args: args as Record<string, unknown> });
        if (tool === BLEND) return holding("880.1207731");
        return { status: "signed_and_submitted", tx_hash: HASH };
      },
    };
    const view = await advance(created.proposal.id, mcp);
    expect(seen.map((c) => c.tool)).toEqual([BLEND, "vanna_blend_withdraw"]);
    expect(seen[1].args).toEqual(expect.objectContaining({ amount: "880.1207731", symbol: "USDC" }));
    expect(view.status).toBe("completed");
    // The note is folded into the record's message on settle (`journal.settled`),
    // which is where the card reads it from.
    expect(String(view.message)).toContain("880.1207731");
    expect(String(view.message)).toContain("876.38");
  });

  it("end to end: an emptied position fails the step without sending a write", async () => {
    const journal = new WorkflowJournal(harness.store);
    const created = await journal.create({
      scope: SCOPE, server: SERVER, objective: "Exit the Blend USDC supply",
      messages: ["withdraw all my blend usdc"], assumptions: [], constraints: [],
      floor: "1.30",
      steps: [wholeStep],
    });
    await journal.approve(created.proposal.id, { scope: SCOPE, server: SERVER }, 1, created.proposal.digest, async () => null);
    const seen: string[] = [];
    const mcp: McpCall = { call: async (tool) => { seen.push(tool); return holding("0"); } };
    const view = await advance(created.proposal.id, mcp);
    expect(seen).toEqual([BLEND]);
    expect(view.steps[0].status).toBe("failed");
    expect(String(view.steps[0].message)).toContain("no BLUSDC left in that position");
  });
});
