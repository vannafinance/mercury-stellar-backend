import { beforeEach, describe, expect, it, vi } from "vitest";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { validateWorkflowRisk } from "@/lib/copilot/workflow/risk";
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
  mocks.app.mockResolvedValue({ grossCollateralUsd: "200", debtUsd: "100", healthFactor: "2" });
  mocks.chain.mockResolvedValue({ balanceWad: decimalWad("200").toString(), debtWad: decimalWad("100").toString(),
    registryDiverged: false, wasmHash: "3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960" });
});
describe("deterministic execution risk", () => {
  it("blocks a borrow that breaches the future floor despite healthy current HF", async () => {
    expect(await validate(proposal())).toMatch(/do not pass/);
  });
  it("accepts an amount that fits both independent valuations", async () => {
    expect(await validate(proposal("50"))).toBeNull();
  });
  it("requires the chain valuation too, even when app valuation clears", async () => {
    mocks.chain.mockResolvedValueOnce({ balanceWad: decimalWad("120").toString(), debtWad: decimalWad("100").toString(),
      registryDiverged: false, wasmHash: "3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960" });
    expect(await validate(proposal("50"))).toMatch(/already below/);
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
  it("fails closed on unavailable balances and never invokes a write during validation", async () => {
    const unavailable = { call: vi.fn(async (_tool: string) => ({ error: "unavailable" })) };
    expect(await validateWorkflowRisk(proposal("50"), unavailable as never, AbortSignal.timeout(1000))).toMatch(/could not be verified/);
    expect(unavailable.call.mock.calls.every(call => !String(call[0]).includes("borrow"))).toBe(true);
  });
});
