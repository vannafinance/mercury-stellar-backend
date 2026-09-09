import { Asset, Networks } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import type { MCPClient } from "../mcp-client";
import { resolveRead } from "../investigation/capabilities";
import { interruptible } from "../investigation/runtime";
import { computeAccountPosition } from "../investigation/capacity";
import { readContractHealthState } from "../investigation/contract-health";
import { decimalWad, formatWad, WAD } from "../investigation/fixed";
import { sizeLegs, type LegRequest } from "../investigation/sizing";
import { allowedInvocation } from "./allowlist";
import type { WorkflowProposal } from "./types";

const TOKENS: Record<string, string> = {
  XLM: Asset.native().contractId(Networks.TESTNET), BLUSDC: CONTRACT_ADDRESSES.BLEND_USDC_TOKEN,
  AQUSDC: CONTRACT_ADDRESSES.AQUARIUS_USDC_TOKEN, SOUSDC: CONTRACT_ADDRESSES.SOROSWAP_USDC_TOKEN,
};
const VERIFIED_RISK_WASM = "3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960";

/** Fresh funding + every intermediate projected state, independent of model prose. */
export async function validateWorkflowRisk(proposal: WorkflowProposal, mcp: Pick<MCPClient, "call">, signal: AbortSignal): Promise<string | null> {
  try {
    if (proposal.scope.network !== "testnet" || !proposal.scope.trader) return "The execution network or wallet is unavailable.";
    for (const step of proposal.steps) allowedInvocation(step, proposal.scope);
    const margin = proposal.steps.some(s => s.op !== "lend");
    if (proposal.steps.some(s => s.op === "borrow") && !proposal.floor) return "A borrowing proposal needs an explicit health-factor floor.";
    const assets = [...new Set(proposal.steps.map(s => s.asset))];
    const funds = new Map<string, bigint>(), prices = new Map<string, bigint>();
    const read = (tool: string, args: Record<string, unknown>) => interruptible(() => mcp.call(tool, args, proposal.scope.trader!), signal);
    await Promise.all(assets.map(async asset => {
      const contract = TOKENS[asset];
      if (!contract) throw new Error("asset_not_validated");
      const priceRead = resolveRead("asset_price", { asset }, proposal.scope);
      const price = await read(priceRead.tool, priceRead.args);
      if (price.error) throw new Error("price_unavailable");
      const value = decimalWad(String(price.price_usd));
      if (value <= BigInt(0)) throw new Error("price_unavailable");
      prices.set(asset, value);
      await Promise.all([proposal.scope.trader, ...(margin && proposal.scope.smartAccount ? [proposal.scope.smartAccount] : [])].map(async holder => {
        const balance = await read("vanna_get_token_balance", { holder, token_contract: contract });
        if (balance.error || balance.holder !== holder || balance.contract !== contract ||
          !Number.isInteger(balance.decimals) || Number(balance.decimals) < 0 || Number(balance.decimals) > 18) throw new Error("balance_unavailable");
        const decimals = Number(balance.decimals);
        for (const step of proposal.steps.filter(s => s.asset === asset)) {
          if ((step.amount.split(".")[1]?.length ?? 0) > decimals) throw new Error("amount_precision");
        }
        funds.set(`${holder}:${asset}`, decimalWad(String(balance.human)));
      }));
    }));
    const legs: LegRequest[] = [];
    for (const step of proposal.steps) {
      const amount = decimalWad(step.amount);
      const walletKey = `${proposal.scope.trader}:${step.asset}`, accountKey = `${proposal.scope.smartAccount}:${step.asset}`;
      const source = ["lend", "deposit_collateral"].includes(step.op) ? walletKey : accountKey;
      if (step.op !== "borrow") {
        const available = funds.get(source);
        if (available === undefined || available < amount) return `There is not enough ${step.asset} in the ${source === walletKey ? "wallet" : "margin account"} for the approved step.`;
        funds.set(source, available - amount);
      }
      if (step.op === "deposit_collateral" || step.op === "borrow") funds.set(accountKey, (funds.get(accountKey) ?? BigInt(0)) + amount);
      if (step.op === "lend") continue;
      const amountUsd = formatWad((amount * prices.get(step.asset)! + WAD - BigInt(1)) / WAD);
      // Until post-supply receipt valuation is verified, charge the full outflow.
      // Crediting an assumed receipt would overstate collateral during a multi-leg run.
      legs.push({ op: step.op === "supply_blend" ? "withdraw_collateral" : step.op, amountUsd, label: step.label });
    }
    if (!margin) return null;
    if (!proposal.scope.smartAccount) return "This proposal requires a verified margin account.";
    const [app, chain] = await Promise.all([
      interruptible(() => computeAccountPosition(proposal.scope.smartAccount!), signal),
      interruptible(() => readContractHealthState(proposal.scope.smartAccount!, { signal }), signal),
    ]);
    if (!app || chain.registryDiverged || chain.wasmHash !== VERIFIED_RISK_WASM) return "The current risk configuration could not be verified.";
    if (!proposal.floor) {
      if (proposal.steps.some(s => s.op !== "deposit_collateral")) return "A health-factor floor is needed before moving margin assets.";
      return null;
    }
    const floor = decimalWad(proposal.floor);
    if (BigInt(chain.debtWad) > BigInt(0) && BigInt(chain.balanceWad) * WAD < BigInt(chain.debtWad) * floor)
      return "The contract-valued position is already below your health-factor floor.";
    for (const base of [{ grossCollateralUsd: app.grossCollateralUsd, debtUsd: app.debtUsd },
      { grossCollateralUsd: formatWad(BigInt(chain.balanceWad)), debtUsd: formatWad(BigInt(chain.debtWad)) }]) {
      const projected = sizeLegs(base, legs, proposal.floor);
      if (!projected.ok) return `The proposed steps do not pass your ${proposal.floor} health-factor floor (${projected.reason}).`;
    }
    return null;
  } catch {
    return "Fresh balances, prices, token precision or projected health could not be verified. No transaction was requested.";
  }
}
