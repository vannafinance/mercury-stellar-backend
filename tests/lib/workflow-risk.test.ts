import { beforeEach, describe, expect, it, vi } from "vitest";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { isRetryableRiskReason, validateWorkflowRisk } from "@/lib/copilot/workflow/risk";
import { allowedInvocation } from "@/lib/copilot/workflow/allowlist";
import type { WorkflowProposal } from "@/lib/copilot/workflow/types";
import { decimalWad } from "@/lib/copilot/investigation/fixed";

const mocks = vi.hoisted(() => ({ app: vi.fn(), chain: vi.fn() }));
vi.mock("@/lib/copilot/investigation/capacity", () => ({ computeAccountPosition: mocks.app }));
vi.mock("@/lib/copilot/investigation/contract-health", () => ({ readContractHealthState: mocks.chain }));
const scope = { subject: "owner", trader: "G-wallet", smartAccount: "C-account", network: "testnet" };
function proposal(amount = "200"): WorkflowProposal {
  return { id: "test", revision: 1, digest: "test", scope, server: "mcp", createdAt: 0, expiresAt: 1,
    objective: "Borrow XLM", messages: [], assumptions: [], constraints: [], floor: "1.5",
    steps: [{ id: "borrow", op: "borrow", asset: "XLM", amount, label: "Borrow XLM", tool: "vanna_borrow",
      args: { symbol: "XLM", amount, trader: scope.trader, smart_account: scope.smartAccount } }] };
}
const mcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
  if (tool === "vanna_get_price") return { price_usd: "1" };
  if (tool === "vanna_get_token_balance") return { holder: args.holder, contract: Asset.native().contractId(Networks.TESTNET), human: "1000", decimals: 7 };
  throw new Error("Unexpected tool");
}) };
const validate = (p: WorkflowProposal) => validateWorkflowRisk(p, mcp as never, AbortSignal.timeout(1000));
beforeEach(() => {
  mocks.app.mockClear();
  mocks.chain.mockClear();
  mcp.call.mockClear();
  mocks.app.mockResolvedValue({ grossCollateralUsd: "200", debtUsd: "100", healthFactor: "2" });
  mocks.chain.mockResolvedValue({ balanceWad: decimalWad("200").toString(), debtWad: decimalWad("100").toString(),
    registryDiverged: false, wasmHash: "3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960" });
});
describe("deterministic execution risk", () => {
  it("blocks a borrow that breaches the future floor despite healthy current HF", async () => {
    expect(await validate(proposal())).toMatch(/do not pass/);
    expect(mocks.app).not.toHaveBeenCalled();
  });
  it("accepts an amount that fits the contract-valued position", async () => {
    expect(await validate(proposal("50"))).toBeNull();
    expect(mocks.app).not.toHaveBeenCalled();
  });
  it("requires the chain valuation, even when an app snapshot would clear", async () => {
    mocks.app.mockResolvedValueOnce({ grossCollateralUsd: "200", debtUsd: "100", healthFactor: "2" });
    mocks.chain.mockResolvedValueOnce({ balanceWad: decimalWad("120").toString(), debtWad: decimalWad("100").toString(),
      registryDiverged: false, wasmHash: "3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960" });
    expect(await validate(proposal("50"))).toMatch(/already below/);
    expect(mocks.app).not.toHaveBeenCalled();
  });
  it("does not credit unvalidated future Blend receipts", async () => {
    const p = proposal("100");
    p.steps.push({ ...p.steps[0], id: "supply", op: "supply_blend", tool: "vanna_blend_supply" });
    expect(await validate(p)).toMatch(/do not pass/);
  });
  it("rejects unsupported tools, inconsistent amounts and extra arguments", () => {
    const p = proposal("50");
    expect(() => allowedInvocation({ ...p.steps[0], tool: "shell" }, scope)).toThrow();
    expect(() => allowedInvocation({ ...p.steps[0], amount: "500" }, scope)).toThrow();
    expect(() => allowedInvocation({ ...p.steps[0], args: { ...p.steps[0].args, recipient: "other" } }, scope)).toThrow();
  });
  it("accepts a sized repay without a health-factor floor", async () => {
    const p = proposal("1");
    p.floor = null;
    p.objective = "Repay 1 XLM";
    p.steps = [{
      id: "repay", op: "repay", asset: "XLM", amount: "1", label: "Repay 1 XLM",
      tool: "vanna_repay",
      args: { symbol: "XLM", amount: "1", trader: scope.trader, smart_account: scope.smartAccount },
    }];
    expect(await validate(p)).toBeNull();
    expect(mocks.app).not.toHaveBeenCalled();
    expect(mocks.chain).not.toHaveBeenCalled();
    expect(mcp.call.mock.calls.every((call) => call[0] === "vanna_get_token_balance")).toBe(true);
    expect(mcp.call.mock.calls.every((call) => call[1].holder === scope.smartAccount)).toBe(true);
  });
  it("still requires a floor before a borrow", async () => {
    const p = proposal("50");
    p.floor = null;
    expect(await validate(p)).toMatch(/borrowing proposal needs an explicit health-factor floor/);
  });
  it("fails closed on unavailable balances and never invokes a write during validation", async () => {
    const unavailable = { call: vi.fn(async (_tool: string) => ({ error: "unavailable" })) };
    expect(await validateWorkflowRisk(proposal("50"), unavailable as never, AbortSignal.timeout(1000))).toMatch(/oracle price could not be read|could not be verified/);
    expect(unavailable.call.mock.calls.every(call => !String(call[0]).includes("borrow"))).toBe(true);
  });
  it("treats a timed-out balance read as retryable, not a consumed refusal", async () => {
    const hanging = { call: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return { price_usd: "1" }; }) };
    const reason = await validateWorkflowRisk(proposal("50"), hanging as never, AbortSignal.timeout(1));
    expect(reason).toMatch(/could not be re-read in time|could not be verified/);
    expect(isRetryableRiskReason(reason!)).toBe(true);
    expect(isRetryableRiskReason("There is not enough XLM in the margin account for the approved step.")).toBe(false);
  });
});
