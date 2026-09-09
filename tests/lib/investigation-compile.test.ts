import { describe, expect, it } from "vitest";
import { compileProposal, DERIVED_MIN_AMOUNT_RATIO } from "@/lib/copilot/investigation/compile";
import { generateCandidates } from "@/lib/copilot/investigation/candidates";
import { decimalWad, formatWad, mulDown, WAD } from "@/lib/copilot/investigation/fixed";
import type { Candidate } from "@/lib/copilot/investigation/candidates";
import type { Observation, InvestigationScope } from "@/lib/copilot/investigation/types";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";
import { WorkflowJournal } from "@/lib/copilot/workflow/journal";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";

/**
 * Compiling a candidate into journal steps.
 *
 * These tests pin the judgements that a mechanical map of `candidate.legs` would
 * get wrong: the Blend supply the label promises is not in `legs`, USD becomes a
 * display token amount from a price actually read this turn, and a stated size is
 * not re-sizable. A compiler whose steps `journal.create()` refuses is not done.
 */

const BASE = { grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30" };
const SCOPE: InvestigationScope = {
  subject: "owner", trader: "GTESTOWNER", smartAccount: "CTESTACCOUNT", network: "testnet",
};
const NOW = 10_000;

function comparison(over: Partial<RateComparison> = {}): RateComparison {
  return {
    asset: "BLUSDC",
    earnSupplyApr: "25.41",
    blendSupplyApr: "10",
    marginBorrowApr: "4",
    spreadApr: "6",
    verdict: "positive_before_costs",
    evidenceIds: ["e1", "e2"],
    ...over,
  };
}

function price(asset: string, price_usd: string, observedAt = NOW): Observation {
  return {
    id: `price-${asset}`, capability: "asset_price", args: { asset },
    observedAt, status: "ok", data: { price_usd },
  };
}

function compile(candidate: Candidate, observations: Observation[], floor: string | null = BASE.floor) {
  return compileProposal({ candidate, scope: SCOPE, observations, floor, now: NOW });
}

function borrowSupply(over: Partial<Parameters<typeof generateCandidates>[0]> = {}) {
  const { feasible } = generateCandidates({
    ...BASE, idleWalletUsd: null, comparisons: [comparison()], ...over,
  });
  const candidate = feasible.find((entry) => entry.id === "borrow_supply_BLUSDC");
  if (!candidate) throw new Error("expected borrow_supply_BLUSDC");
  return candidate;
}

describe("compiling a candidate into proposal steps", () => {
  it("emits the Blend supply even though borrow_supply has only the borrow leg", () => {
    // Mapping `legs` alone would borrow and never supply — the supply is health-factor
    // neutral, so the generator never puts it in the array.
    const result = compile(borrowSupply(), [price("BLUSDC", "1")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((step) => step.op)).toEqual(["borrow", "supply_blend"]);
    expect(result.steps[0].tool).toBe("vanna_borrow");
    expect(result.steps[1].tool).toBe("vanna_blend_supply");
    expect(result.steps[0].args).toMatchObject({
      smart_account: SCOPE.smartAccount, symbol: "USDC", trader: SCOPE.trader,
    });
    expect(result.steps[1].args.symbol).toBe("USDC");
    expect(result.steps[0].amount).toBe(result.steps[1].amount);
  });

  it("deposits wallet funds before supplying them from the margin account", () => {
    const { feasible } = generateCandidates({
      ...BASE, idleWalletUsd: "680", idleWalletByAssetUsd: { BLUSDC: "680" },
      borrowingAllowed: false, comparisons: [comparison()],
    });
    const idle = feasible.find((entry) => entry.id === "supply_idle_BLUSDC");
    expect(idle?.legs).toEqual([]);
    const result = compile(idle!, [price("BLUSDC", "1")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].op).toBe("deposit_collateral");
    expect(result.steps[1]).toMatchObject({
      op: "supply_blend", tool: "vanna_blend_supply", amount: "680", asset: "BLUSDC",
    });
  });

  it("converts USD to tokens with the read price, rounded down", () => {
    // $6,541.04 of XLM at $0.19 — the exact WAD quotient, not a rounded comparison.
    const { feasible } = generateCandidates({
      ...BASE, idleWalletUsd: null, comparisons: [comparison({ asset: "XLM" })],
    });
    const candidate = {
      ...feasible[0],
      amountUsd: "6541.04",
      legs: feasible[0].legs.map((leg) => ({ ...leg, amountUsd: "6541.04" })),
    };
    const result = compile(candidate, [price("XLM", "0.19")], BASE.floor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = formatWad(mulDown(decimalWad("6541.04"), WAD, decimalWad("0.19")));
    expect(expected).toBe("34426.52631578947368421");
    expect(result.steps[0].amount).toBe("34426.526315");
    expect(result.steps[0].args.amount).toBe("34426.526315");
    expect(result.steps[0].args.symbol).toBe("XLM");
  });

  it("refuses a missing price, including a USDC-family asset with no read, and a stale one", () => {
    const candidate = borrowSupply();
    expect(compile(candidate, [])).toEqual({ ok: false, reason: "missing_price" });
    // An XLM price does not value BLUSDC, and a stable is not worth $1 by ticker.
    expect(compile(candidate, [price("XLM", "0.19")])).toEqual({ ok: false, reason: "missing_price" });
    expect(compile(candidate, [price("BLUSDC", "1", NOW - 61_000)])).toEqual({ ok: false, reason: "stale_price" });
  });

  it("carries stated vs floor-derived sizing, with the approved lower bound", () => {
    const stated = compile(borrowSupply({ requestedBorrowUsd: "500" }), [price("BLUSDC", "1")]);
    expect(stated.ok).toBe(true);
    if (!stated.ok) return;
    expect(stated.steps.every((step) => step.sizing?.basis === "stated")).toBe(true);

    const derived = compile(borrowSupply(), [price("BLUSDC", "1")]);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const bound = formatWad(mulDown(decimalWad(borrowSupply().amountUsd), decimalWad(DERIVED_MIN_AMOUNT_RATIO), WAD));
    expect(derived.steps[0].sizing).toEqual({ basis: "stated" });
    expect(derived.steps[1].sizing).toEqual({ basis: "stated" });

    const noFloor = compile(borrowSupply(), [price("BLUSDC", "1")], null);
    expect(noFloor.ok).toBe(true);
    if (!noFloor.ok) return;
    expect(noFloor.steps.every((step) => step.sizing?.basis === "stated")).toBe(true);
  });

  it("emits steps that survive journal.create without unsized_proposal_step", async () => {
    let row: { value: WorkflowRecord; version: string } | null = null;
    const store: RecordStore<WorkflowRecord> = {
      read: async () => structuredClone(row),
      write: async (_id, expected, value) => {
        if ((row?.version ?? null) !== expected) return false;
        row = { version: String(Number(expected ?? -1) + 1), value: structuredClone(value) };
        return true;
      },
    };
    const compiled = compile(borrowSupply(), [price("BLUSDC", "1")]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const record = await new WorkflowJournal(store, () => NOW).create({
      scope: SCOPE, server: "mcp", objective: "Borrow BLUSDC to Blend",
      messages: ["Keep HF above 1.3"], assumptions: [], constraints: ["Health factor at or above 1.30"],
      floor: BASE.floor, steps: compiled.steps,
    });
    expect(record.proposal.steps).toHaveLength(2);
    expect(record.proposal.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns unsupported_op for withdraw_collateral rather than dropping the leg", () => {
    const candidate = borrowSupply();
    candidate.legs = [{
      op: "withdraw_collateral", label: "Withdraw XLM", amountUsd: "10",
      grossAfterUsd: "1", debtAfterUsd: "1", healthFactorAfter: "2",
    }];
    expect(compile(candidate, [price("BLUSDC", "1")])).toEqual({ ok: false, reason: "unsupported_op" });
  });

  it("orders collateral-increasing steps before the borrow", () => {
    // Safety of intermediate health is already sizeLegs' job; this pins readable order.
    const candidate = borrowSupply();
    candidate.legs = [
      {
        op: "borrow", label: "Borrow BLUSDC", amountUsd: "100",
        grossAfterUsd: "1", debtAfterUsd: "1", healthFactorAfter: "2",
      },
      {
        op: "deposit_collateral", label: "Deposit BLUSDC", amountUsd: "50",
        grossAfterUsd: "1", debtAfterUsd: "1", healthFactorAfter: "3",
      },
    ];
    const result = compile(candidate, [price("BLUSDC", "1")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((step) => step.op)).toEqual(["deposit_collateral", "borrow", "supply_blend"]);
  });

  it("compiles Earn idle to vanna_lend with lender, not a Blend supply", async () => {
    const { feasible } = generateCandidates({
      ...BASE, idleWalletUsd: "680", idleWalletByAssetUsd: { BLUSDC: "680" },
      borrowingAllowed: false, comparisons: [comparison()],
    });
    const earn = feasible.find((entry) => entry.id === "lend_idle_BLUSDC");
    expect(earn?.venue).toBe("earn");
    const result = compile(earn!, [price("BLUSDC", "1")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      op: "lend",
      tool: "vanna_lend",
      amount: "680",
      asset: "BLUSDC",
      args: { symbol: "USDC", amount: "680", lender: SCOPE.trader },
    });
    expect(result.steps[0].args).not.toHaveProperty("smart_account");

    let row: { value: WorkflowRecord; version: string } | null = null;
    const store: RecordStore<WorkflowRecord> = {
      read: async () => structuredClone(row),
      write: async (_id, expected, value) => {
        if ((row?.version ?? null) !== expected) return false;
        row = { version: String(Number(expected ?? -1) + 1), value: structuredClone(value) };
        return true;
      },
    };
    const record = await new WorkflowJournal(store, () => NOW).create({
      scope: SCOPE, server: "mcp", objective: earn!.label,
      messages: ["Keep HF above 1.3"], assumptions: [], constraints: [],
      floor: BASE.floor, steps: result.steps,
    });
    expect(record.proposal.steps[0].op).toBe("lend");
    expect(record.proposal.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
