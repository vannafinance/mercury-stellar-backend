import { beforeEach, describe, expect, it, vi } from "vitest";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { isRetryableRiskReason, validateWorkflowRisk } from "@/lib/copilot/workflow/risk";
import { allowedInvocation, writeArgsFor } from "@/lib/copilot/workflow/allowlist";
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
const defaultCall = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (tool === "vanna_get_price") return { price_usd: "1" };
  if (tool === "vanna_get_token_balance") return { holder: args.holder, contract: Asset.native().contractId(Networks.TESTNET), human: "1000", decimals: 7 };
  throw new Error("Unexpected tool");
};
const mcp = { call: vi.fn(defaultCall) };
const validate = (p: WorkflowProposal) => validateWorkflowRisk(p, mcp as never, AbortSignal.timeout(1000));
beforeEach(() => {
  mocks.app.mockClear();
  mocks.chain.mockClear();
  mcp.call.mockReset().mockImplementation(defaultCall);
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
  it("values a Blend supply at par, as the RiskEngine does, so it neither passes nor fails a floor", async () => {
    /**
     * Until 14 Sep a Blend supply was charged as a full withdrawal "until post-supply receipt
     * valuation is verified". Verified: BlendController mints a TrackingToken receipt by the
     * measured b-token delta and syncs it into the account's collateral list
     * (BlendControllerContract/src/controller.rs), and RiskEngine values that receipt at
     * underlying × oracle price (risk_engine.rs, `BlendUnderlying`). The op-flow table says
     * `neutral`; the sizer and this validator now agree. A borrow that lands exactly on the
     * 1.5 floor stays there after the supply — and the supply still must be funded.
     */
    const p = proposal("100");
    p.steps.push({ ...p.steps[0], id: "supply", op: "supply_blend", tool: "vanna_blend_supply" });
    expect(await validate(p)).toBeNull();
    const unfunded = proposal("100");
    unfunded.steps.push({ ...unfunded.steps[0], id: "supply", op: "supply_blend", tool: "vanna_blend_supply", amount: "1200", args: { ...unfunded.steps[0].args, amount: "1200" } });
    expect(await validate(unfunded)).toMatch(/not enough XLM in the margin account/);
  });
  it("rejects unsupported tools, inconsistent amounts and extra arguments", () => {
    const p = proposal("50");
    expect(() => allowedInvocation({ ...p.steps[0], tool: "shell" }, scope)).toThrow();
    expect(() => allowedInvocation({ ...p.steps[0], amount: "500" }, scope)).toThrow();
    expect(() => allowedInvocation({ ...p.steps[0], args: { ...p.steps[0].args, recipient: "other" } }, scope)).toThrow();
  });
  it("a swap proposal that showed impact may carry acknowledged_price_impact", () => {
    const swapScope = {
      trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
      smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
    };
    const args = writeArgsFor("swap", "XLM", "10", swapScope, {
      tokenOut: "SOUSDC",
      venue: "soroswap",
      minOut: "1",
      acknowledgedPriceImpact: true,
    });
    expect(args.acknowledged_price_impact).toBe(true);
    expect(() =>
      allowedInvocation(
        {
          id: "s0-swap",
          op: "swap",
          asset: "XLM",
          amount: "10",
          label: "Swap 10 XLM",
          tool: "vanna_swap",
          args,
        },
        swapScope,
      ),
    ).not.toThrow();
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
  it("allows a literal borrow without a user floor while retaining the liquidation guard", async () => {
    const p = proposal("50");
    p.floor = null;
    expect(await validate(p)).toBeNull();
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

describe("redeem and withdraw in the risk gate", () => {
  it("checks a redeem against the vToken balance and credits the underlying to the wallet for the next step", async () => {
    const p = proposal("1");
    p.floor = null; p.objective = "Bring AqUSDC into margin";
    p.steps = [
      { id: "redeem", op: "redeem", asset: "AQUSDC", amount: "4918.2651397", label: "Redeem", tool: "vanna_redeem", args: { symbol: "AQUSDC", amount: "4918.2651397", lender: scope.trader } },
      { id: "deposit", op: "deposit_collateral", asset: "AQUSDC", amount: "5000.786863", label: "Deposit", tool: "vanna_deposit_collateral", args: { symbol: "AQUSDC", amount: "5000.786863", trader: scope.trader, smart_account: scope.smartAccount } },
    ];
    mcp.call.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "vanna_get_price") return { price_usd: "1" };
      // The wallet holds no AQUSDC yet — the redeem is what puts it there.
      if (tool === "vanna_get_token_balance") return { holder: args.holder, contract: args.token_contract, human: "0", decimals: 7 };
      if (tool === "vanna_get_vtoken_balance") return { holder: args.holder, symbol: "AQUSDC", human: "4918.2651397", redeemable_human: "5000.786863027758031020" };
      throw new Error(`Unexpected tool ${tool}`);
    });
    expect(await validate(p)).toBeNull();
    expect(mcp.call.mock.calls.some((c) => c[0] === "vanna_get_vtoken_balance" && c[1].holder === scope.trader)).toBe(true);
  });

  it("refuses a redeem of more vTokens than are held", async () => {
    const p = proposal("1");
    p.floor = null;
    p.steps = [{ id: "redeem", op: "redeem", asset: "AQUSDC", amount: "9999", label: "Redeem", tool: "vanna_redeem", args: { symbol: "AQUSDC", amount: "9999", lender: scope.trader } }];
    mcp.call.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "vanna_get_vtoken_balance") return { holder: args.holder, symbol: "AQUSDC", human: "4918.2651397", redeemable_human: "5000.78" };
      if (tool === "vanna_get_price") return { price_usd: "1" };
      return { holder: args.holder, contract: args.token_contract, human: "0", decimals: 7 };
    });
    expect(await validate(p)).toMatch(/not enough AQUSDC vTokens in Earn/);
  });

  it("projects a withdraw as lowering health and holds it to the floor", async () => {
    const p = proposal("150");
    p.objective = "Withdraw XLM";
    p.steps = [{ id: "w", op: "withdraw_collateral", asset: "XLM", amount: "150", label: "Withdraw", tool: "vanna_withdraw_collateral", args: { symbol: "XLM", amount: "150", trader: scope.trader, smart_account: scope.smartAccount } }];
    // (200 - 150) / 100 = 0.5 < 1.5 floor.
    expect(await validate(p)).toMatch(/do not pass your 1.5 health-factor floor/);
    p.steps[0].amount = "10"; p.steps[0].args.amount = "10";
    expect(await validate(p)).toBeNull();
  });
});
