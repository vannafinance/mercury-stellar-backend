import { Asset, Networks } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import type { MCPClient } from "../mcp-client";
import { resolveRead } from "../investigation/capabilities";
import { interruptible } from "../investigation/runtime";
import { readContractHealthState } from "../investigation/contract-health";
import { decimalWad, formatWad, WAD } from "../investigation/fixed";
import { sizeLegs, type LegRequest } from "../investigation/sizing";
import { RETRY, withRetry } from "../retry-policy";
import { logUnexpected } from "../log";
import { allowedInvocation } from "./allowlist";
import { OP_FLOW, POCKET_HOLDER, SIZED_OPS, type SizedOp, type WorkflowProposal } from "./types";

const TOKENS: Record<string, string> = {
  XLM: Asset.native().contractId(Networks.TESTNET), BLUSDC: CONTRACT_ADDRESSES.BLEND_USDC_TOKEN,
  AQUSDC: CONTRACT_ADDRESSES.AQUARIUS_USDC_TOKEN, SOUSDC: CONTRACT_ADDRESSES.SOROSWAP_USDC_TOKEN,
};
const VERIFIED_RISK_WASM = "3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960";
const READ_MS = 15_000;

/** RPC/timeout copy must not consume the proposal — the user can Approve again. */
const RETRYABLE = /abort|timeout|ECONNRESET|EPIPE|fetch failed|network|unavailable|could not be verified|could not be re-read|timed out/i;

export function isRetryableRiskReason(reason: string): boolean {
  return RETRYABLE.test(reason);
}

/** Only a step the op-flow table says LOWERS health needs the projection; the rest cannot fail a floor. */
function needsHealthProjection(proposal: WorkflowProposal): boolean {
  return proposal.steps.some((step) => OP_FLOW[step.op].health === "lowers");
}

/**
 * The keys whose token balances the steps spend, from the table's source pockets: the
 * wallet's tokens (trader), the account's (smart account). An Earn position is vTokens with
 * its own read below; borrowing capacity is no balance at all.
 */
function holdersFor(proposal: WorkflowProposal): string[] {
  const holders = new Set<string>();
  for (const step of proposal.steps) {
    const from = OP_FLOW[step.op].from;
    if (from === "earn" || from === "debt") continue;
    const holder = proposal.scope[POCKET_HOLDER[from]];
    if (holder) holders.add(holder);
  }
  return [...holders];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fail(code: string): never {
  throw new Error(code);
}

function explain(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Live balances could not be re-read in time. Nothing was submitted — approve again.";
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/abort|timeout/i.test(text)) {
    return "Live balances could not be re-read in time. Nothing was submitted — approve again.";
  }
  if (/price_unavailable/.test(text)) return "A live oracle price could not be read. Nothing was submitted — approve again.";
  if (/balance_unavailable/.test(text)) return "A live token balance could not be read. Nothing was submitted — approve again.";
  const precision = /amount_precision:([A-Za-z0-9_/-]+):(\d+)/.exec(text);
  if (precision) return `A step's ${precision[1]} amount has more decimal places than the token carries on chain (${precision[2]}). No transaction was requested — prepare the plan again.`;
  if (/asset_not_validated|amount_precision|invalid_decimal/.test(text)) {
    return "Fresh balances, prices, token precision or projected health could not be verified. No transaction was requested.";
  }
  return "Fresh balances, prices, token precision or projected health could not be verified. No transaction was requested.";
}

/** Fresh funding + every intermediate projected state, independent of model prose. */
export async function validateWorkflowRisk(proposal: WorkflowProposal, mcp: Pick<MCPClient, "call">, signal: AbortSignal): Promise<string | null> {
  try {
    if (proposal.scope.network !== "testnet" || !proposal.scope.trader) return "The execution network or wallet is unavailable.";
    for (const step of proposal.steps) allowedInvocation(step, proposal.scope);
    const margin = proposal.steps.some(s => s.op !== "lend");
    const assets = [...new Set(proposal.steps.map(s => s.asset))];
    const funds = new Map<string, bigint>(), prices = new Map<string, bigint>();
    const project = needsHealthProjection(proposal);
    const read = (tool: string, args: Record<string, unknown>) => interruptible(
      () => withRetry(RETRY.mcpRead, () => mcp.call(tool, args, proposal.scope.trader!)),
      AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]),
    );
    const holders = holdersFor(proposal);
    await Promise.all(assets.map(async asset => {
      const contract = TOKENS[asset];
      if (!contract) fail("asset_not_validated");
      if (project || proposal.floor) {
        const priceRead = resolveRead("asset_price", { asset }, proposal.scope);
        const price = asRecord(await read(priceRead.tool, priceRead.args));
        if (price.error) fail("price_unavailable");
        const value = decimalWad(String(price.price_usd));
        if (value <= BigInt(0)) fail("price_unavailable");
        prices.set(asset, value);
      }
      await Promise.all(holders.map(async holder => {
        const balance = asRecord(await read("vanna_get_token_balance", { holder, token_contract: contract }));
        const reportedHolder = typeof balance.holder === "string" ? balance.holder : "";
        const reportedContract = typeof balance.contract === "string" ? balance.contract
          : typeof balance.token_contract === "string" ? balance.token_contract : "";
        const decimals = Number(balance.decimals);
        if (balance.error || reportedHolder !== holder || reportedContract !== contract ||
          !Number.isInteger(decimals) || decimals < 0 || decimals > 18) fail("balance_unavailable");
        for (const step of proposal.steps.filter(s => s.asset === asset)) {
          if ((step.amount.split(".")[1]?.length ?? 0) > decimals) fail(`amount_precision:${asset}:${decimals}`);
        }
        funds.set(`${holder}:${asset}`, decimalWad(String(balance.human)));
      }));
    }));
    const legs: LegRequest[] = [];
    for (const step of proposal.steps) {
      const amount = decimalWad(step.amount);
      const walletKey = `${proposal.scope.trader}:${step.asset}`, accountKey = `${proposal.scope.smartAccount}:${step.asset}`;
      if (step.op === "redeem") {
        /**
         * A redeem spends vTokens and lands the underlying in the wallet, where a later
         * step may deposit it. The vToken read gives both the balance and what the whole
         * of it redeems for; a partial amount redeems pro rata.
         */
        const vtoken = asRecord(await read("vanna_get_vtoken_balance", { holder: proposal.scope.trader, symbol: String(step.args.symbol) }));
        const held = decimalWad(String(vtoken.human ?? "0"));
        const redeemable = decimalWad(String(vtoken.redeemable_human ?? "0"));
        if (vtoken.error || held < amount) return `There are not enough ${step.asset} vTokens in Earn for the approved step.`;
        const underlying = held > BigInt(0) ? (redeemable * amount) / held : BigInt(0);
        funds.set(walletKey, (funds.get(walletKey) ?? BigInt(0)) + underlying);
        continue;
      }
      // Funds flow exactly as the op-flow table says: debit the source pocket, credit the destination.
      const { from, to } = OP_FLOW[step.op];
      const keyOf = { wallet: walletKey, account: accountKey } as const;
      if (from === "wallet" || from === "account") {
        const available = funds.get(keyOf[from]);
        if (available === undefined || available < amount) return `There is not enough ${step.asset} in the ${from === "wallet" ? "wallet" : "margin account"} for the approved step.`;
        funds.set(keyOf[from], available - amount);
      }
      if (to === "wallet" || to === "account") funds.set(keyOf[to], (funds.get(keyOf[to]) ?? BigInt(0)) + amount);
      // A health-neutral step (an Earn lend, a Blend supply the RiskEngine values at par) is not a projection leg.
      if (!(SIZED_OPS as readonly string[]).includes(step.op)) continue;
      if (!project && !proposal.floor) continue;
      const price = prices.get(step.asset);
      if (price === undefined) fail("price_unavailable");
      const amountUsd = formatWad((amount * price + WAD - BigInt(1)) / WAD);
      legs.push({ op: step.op as SizedOp, amountUsd, label: step.label });
    }
    if (!margin) return null;
    if (!proposal.scope.smartAccount) return "This proposal requires a verified margin account.";
    /**
     * Deposit and repay raise health. They do not need a floor, an app snapshot, or a
     * contract health read — free-token funds above are enough. The app snapshot
     * (`computeAccountPosition` / `computeMarginSnapshot`) is unbounded, process-wide,
     * and uncancellable; interruptible only bounds the wait. It does not belong here.
     * Liquidation is a contract fact, so a floor on a worsening op is checked against
     * chain state alone.
     */
    /**
     * Without a user floor the contract's liquidation line is the stop: the sequence may
     * not pass through a liquidatable state. Until 13 Sep a deposit-then-supply plan with
     * no stated floor was refused outright here even though it ends where it started.
     */
    if (!proposal.floor && !project) return null;
    const bound = AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]);
    const chain = await interruptible(
      () => readContractHealthState(proposal.scope.smartAccount!, { signal: bound }),
      bound,
    );
    if (chain.registryDiverged || chain.wasmHash !== VERIFIED_RISK_WASM) return "The current risk configuration could not be verified.";
    if (proposal.floor) {
      const floor = decimalWad(proposal.floor);
      if (BigInt(chain.debtWad) > BigInt(0) && BigInt(chain.balanceWad) * WAD < BigInt(chain.debtWad) * floor)
        return "The contract-valued position is already below your health-factor floor.";
    }
    const projected = sizeLegs(
      { grossCollateralUsd: formatWad(BigInt(chain.balanceWad)), debtUsd: formatWad(BigInt(chain.debtWad)) },
      legs,
      proposal.floor,
    );
    if (!projected.ok) {
      return proposal.floor
        ? `The proposed steps do not pass your ${proposal.floor} health-factor floor (${projected.reason}).`
        : `The proposed steps would leave the account liquidatable (${projected.reason}).`;
    }
    return null;
  } catch (error) {
    logUnexpected("workflow risk validation failed", { error });
    return explain(error);
  }
}
