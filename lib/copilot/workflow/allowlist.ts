import { DEFAULT_SWAP_VENUE, lpVenues, poolVenueFor, resolveAssetDef } from "../registry/assets";
import { decimalWad } from "../investigation/fixed";
import type { InvestigationScope } from "../investigation/types";
import { OP_FLOW, WALLET_OPS, type ProposalStep, type WorkflowOp } from "./types";

/** Op → MCP write tool. The one map; `plan.ts` and `requested-actions.ts` import it rather than repeating it. */
export const TOOLS: Readonly<Record<WorkflowOp, string>> = Object.freeze({
  lend: "vanna_lend", redeem: "vanna_redeem",
  deposit_collateral: "vanna_deposit_collateral", withdraw_collateral: "vanna_withdraw_collateral",
  borrow: "vanna_borrow", repay: "vanna_repay", supply_blend: "vanna_blend_supply",
  blend_withdraw: "vanna_blend_withdraw", swap: "vanna_swap",
  remove_liquidity: "vanna_remove_liquidity", add_liquidity: "vanna_add_liquidity",
});

/**
 * The exact argument set a step must carry for its op — wallet ops name the lender, margin
 * ops the account. The key names are the MCP tool's own: `allowedInvocation` compares them
 * one for one, so a rename here is a refused write rather than a silent mismatch.
 */
export function writeArgsFor(
  op: WorkflowOp,
  symbol: string,
  amount: string,
  scope: Pick<InvestigationScope, "trader" | "smartAccount">,
  extra?: { tokenOut?: string; venue?: string; minOut?: string; amountB?: string },
): Record<string, unknown> {
  if (op === "add_liquidity") {
    // vanna_add_liquidity(smart_account, token_a, token_b, amount_a, amount_b, min_liquidity_out, trader, venue)
    // token_a/amount_a are whichever side the leg stated — same convention as swap's
    // token_in/amount_in — never assumed to be XLM: a leg stated in the paired token
    // (e.g. "add 500 AQUSDC to the pool") must not have its amount mislabeled as XLM's.
    return {
      smart_account: scope.smartAccount, token_a: symbol, token_b: extra?.tokenOut ?? "",
      amount_a: amount, amount_b: extra?.amountB ?? "", min_liquidity_out: extra?.minOut ?? "",
      trader: scope.trader, venue: extra?.venue ?? DEFAULT_SWAP_VENUE,
    };
  }
  if (op === "remove_liquidity") {
    // vanna_remove_liquidity(smart_account, token_a, token_b, liquidity, trader, venue)
    return {
      smart_account: scope.smartAccount, token_a: "XLM", token_b: symbol,
      liquidity: amount, trader: scope.trader, venue: extra?.venue ?? "",
    };
  }
  if (op === "swap") {
    // vanna_swap(smart_account, token_in, token_out, amount_in, min_out, trader, venue)
    return {
      smart_account: scope.smartAccount, token_in: symbol, token_out: extra?.tokenOut ?? "",
      amount_in: amount, min_out: extra?.minOut ?? "", trader: scope.trader, venue: extra?.venue ?? DEFAULT_SWAP_VENUE,
    };
  }
  return WALLET_OPS.includes(op)
    ? { symbol, amount, lender: scope.trader }
    : { symbol, amount, trader: scope.trader, smart_account: scope.smartAccount };
}

/** Protocol operations only. Never spread model, browser, or stored arbitrary arguments. */
export function allowedInvocation(step: ProposalStep, scope: Pick<InvestigationScope, "trader" | "smartAccount">) {
  if (!Object.hasOwn(TOOLS, step.op) || TOOLS[step.op] !== step.tool || !scope.trader) throw new Error("write_not_allowed");
  if (decimalWad(step.amount) <= BigInt(0)) throw new Error("invalid_write_amount");
  const asset = resolveAssetDef(step.asset);
  if (!asset || asset.id !== step.asset) throw new Error("invalid_write_asset");
  const symbol = WALLET_OPS.includes(step.op) ? asset.earnSymbol : asset.marginSymbol;
  if (!symbol || (OP_FLOW[step.op].venue === "blend" && !asset.blendReserve)) throw new Error("write_not_allowed");
  let extra: { tokenOut?: string; venue?: string; minOut?: string; amountB?: string } | undefined;
  /**
   * Entering a pool names the other side of the pair and the paired amount the sizer
   * derived for it — the ratio is not the model's to guess, and never re-derived here from
   * whatever step.args happens to carry: allowedInvocation's job is to confirm the step
   * matches what writeArgsFor would build from the SAME inputs, not to re-price anything.
   */
  if (step.op === "add_liquidity") {
    const other = typeof step.args.token_b === "string" ? resolveAssetDef(step.args.token_b) : null;
    const venue = typeof step.args.venue === "string" ? step.args.venue : "";
    const amountB = typeof step.args.amount_b === "string" ? step.args.amount_b : "";
    const minLiquidityOut = typeof step.args.min_liquidity_out === "string" ? step.args.min_liquidity_out : "";
    if (!other?.marginSymbol || other.id === asset.id || !(lpVenues() as readonly string[]).includes(venue)
      || decimalWad(amountB) <= BigInt(0) || decimalWad(minLiquidityOut) <= BigInt(0)) {
      throw new Error("write_not_allowed");
    }
    extra = { tokenOut: other.marginSymbol, venue, amountB, minOut: minLiquidityOut };
  }
  // Leaving a pool names the venue that holds it; XLM is the other side of every pair.
  if (step.op === "remove_liquidity") {
    const venue = typeof step.args.venue === "string" ? step.args.venue : "";
    if (asset.lpVenue !== venue || !poolVenueFor("XLM", asset.id)) throw new Error("write_not_allowed");
    extra = { venue };
  }
  // A swap names a second asset; it must be one the registry knows and the account accepts,
  // and it must carry the floor it will not accept less than — a swap with no floor at all
  // is what left the propose-time preview unable to project anything but oracle parity.
  if (step.op === "swap") {
    const out = typeof step.args.token_out === "string" ? resolveAssetDef(step.args.token_out) : null;
    const venue = typeof step.args.venue === "string" ? step.args.venue : "";
    const minOut = typeof step.args.min_out === "string" ? step.args.min_out : "";
    if (!out?.marginSymbol || out.id === asset.id || !(lpVenues() as readonly string[]).includes(venue) || decimalWad(minOut) <= BigInt(0)) {
      throw new Error("write_not_allowed");
    }
    extra = { tokenOut: out.marginSymbol, venue, minOut };
  }
  const args = writeArgsFor(step.op, symbol, step.amount, scope, extra);
  if (!WALLET_OPS.includes(step.op) && !scope.smartAccount) throw new Error("write_not_allowed");
  if (Object.keys(step.args).length !== Object.keys(args).length || Object.entries(args).some(([key, value]) => step.args[key] !== value))
    throw new Error("proposal_arguments_mismatch");
  return { tool: TOOLS[step.op], args };
}
