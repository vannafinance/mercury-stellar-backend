/**
 * Drive an approved journal proposal through MCP writes, one claimed step at a time.
 *
 * The browser never supplies tools, amounts or envelopes. It may send a transaction
 * hash after it signed the unsigned XDR this module already recorded.
 */

import type { MCPClient } from "../mcp-client";
import { allowedInvocation } from "../workflow/allowlist";
import { isRecord } from "./decision";
import { interruptible } from "./runtime";
import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import { constantProductOut, isDangerousFill, poolReservesFrom, reservesForDirection, slippageFloor, SWAP_SLIPPAGE_BPS, type PoolReserves } from "./pool-quote";
import { WorkflowConflict, type StepReadiness } from "../workflow/journal";
import { workflowView, type WorkflowProposal, type WorkflowView, type ProposalStep } from "../workflow/types";
import { getMcpClient } from "../mcp-client";
import { validateWorkflowRisk } from "../workflow/risk";
import { appendAudit } from "../audit-log";
import { checkpointFromJournal, saveCheckpoint } from "../checkpoint";
import { ResearchError, resolveInvestigationScope } from "./scope";
import type { InvestigationScope } from "./types";
import { resolveRead } from "./catalog";
import { isPositionRowRead, POSITION_ROWS, positionRowIn } from "./plan";
import { resolveAssetDef } from "../registry/assets";
import { workflowJournal } from "./proposal";
import { TOOLS } from "../workflow/allowlist";
import { WALLET_OPS } from "../workflow/types";

/** Every tool the vocabulary maps to. Derived, so a new op cannot be allowlisted yet unexecutable. */
const WRITE_TOOLS = new Set(Object.values(TOOLS));
const WALLET_TOOLS = new Set(WALLET_OPS.map((op) => TOOLS[op]));

export type LedgerLookup = (hash: string) => Promise<
  { found: true; success: boolean; ledger: number } | { found: false }
>;

function persistRun(record: { proposal: WorkflowProposal; status: string; steps: Array<{ id: string; status: string; txHash?: string }> }, subject: string) {
  const checkpoint = checkpointFromJournal({
    workflowId: record.proposal.id, subject, status: record.status,
    digest: record.proposal.digest, steps: record.steps,
  });
  void saveCheckpoint(checkpoint);
  const hash = checkpoint.lastTxHash;
  if (hash) {
    void appendAudit({
      at: Date.now(), subject, action: "executed",
      workflowId: record.proposal.id, digest: record.proposal.digest,
      txHash: hash, floor: record.proposal.floor,
    });
  }
}

function identityOf(proposal: WorkflowProposal) {
  return { scope: proposal.scope, server: proposal.server };
}

/** What re-quoting the pool right before the write decided. */
export type StaleFloorVerdict =
  | { kind: "unchanged" }
  | { kind: "adjusted"; minOut: string; note: string }
  | { kind: "refuse"; message: string };

/** What re-reading a whole-position amount immediately before the write decided. */
export type StalePositionVerdict =
  | { kind: "unchanged" }
  | { kind: "adjusted"; amount: string; note: string }
  | { kind: "refuse"; message: string };

/** What refreshing an LP deposit against the pool immediately before the write decided. */
export type StaleLiquidityVerdict =
  | { kind: "unchanged" }
  | { kind: "adjusted"; amountA: string; amountB: string; minLiquidityOut: string; note: string }
  | { kind: "refuse"; message: string };

/**
 * A swap's floor is re-quoted against the pool one more time, moments before the write.
 *
 * ## The race this closes
 *
 * The floor is derived when the plan is built; the swap is sent when the user approves it,
 * seconds or minutes later. A pool does not stand still in between — 15 Sep, live, the same
 * 1,000 XLM → AQUSDC swap was refused by the DEX (HostError #2006) at approve time on a
 * floor that had been perfectly fine moments before.
 *
 * A moved price is not, by itself, a reason to stop: the user asked to swap 100 XLM, not to
 * receive exactly one number or nothing. So the pool is re-quoted here, and the write
 * proceeds whenever the fresh fill is still a FAIR one — only a fill that is itself
 * dangerous (the same oracle-price-impact threshold the propose-time card refuses on) stops
 * the write, and it stops BEFORE anything is sent, naming both figures:
 *
 * - Pool still pays the approved floor → send it UNCHANGED.
 * - Pool pays less, but the fresh fill is still fair (within the impact threshold) → send it
 *   with the floor LOWERED to what the pool actually offers, minus the same slippage margin
 *   the original floor used. The eventual result names the price it actually settled at —
 *   never a silent substitution the user has to discover from their balance afterward.
 * - Pool pays so much less that the fresh fill is itself a bad trade → refuse, naming both
 *   figures. This is the one case a floor must not be lowered to fit: an already-thin pool
 *   getting thinner is exactly what the price-impact guard exists to catch, whichever side
 *   of the approval it happens on.
 *
 * Fails OPEN. If the pool or price reads are unavailable, slow, or not an Aquarius pair, the
 * write proceeds unchanged — the DEX's own floor check is still the backstop, and a stats
 * endpoint being down is not a reason to block a swap the user approved.
 */
export async function staleSwapFloor(
  step: ProposalStep,
  mcp: Pick<MCPClient, "call">,
  trader: string,
  signal: AbortSignal,
  slippageAccepted = false,
): Promise<StaleFloorVerdict> {
  const unchanged: StaleFloorVerdict = { kind: "unchanged" };
  // Re-quote ANY swap venue, not just Aquarius. A price that moved between the plan and
  // the approval is the normal case, and a Soroswap leg that skipped this carried its
  // plan-time floor all the way to signing — which is how a floor sized at oracle parity
  // reached the wallet against a pool paying less than half of it (16 Sep, live).
  const swapVenue = typeof step.args.venue === "string" ? step.args.venue : "";
  if (step.op !== "swap" || (swapVenue !== "aquarius" && swapVenue !== "soroswap")) return unchanged;
  const tokenIn = typeof step.args.token_in === "string" ? step.args.token_in : "";
  const tokenOut = typeof step.args.token_out === "string" ? step.args.token_out : "";
  const amountIn = typeof step.args.amount_in === "string" ? step.args.amount_in : "";
  const minOut = typeof step.args.min_out === "string" ? step.args.min_out : "";
  if (!tokenIn || !tokenOut || !amountIn || !minOut) return unchanged;
  let reserves: PoolReserves | null = null;
  try {
    const payload = await interruptible(
      () => mcp.call(
        swapVenue === "soroswap" ? "vanna_get_soroswap_pool_stats" : "vanna_get_aquarius_pool_stats",
        { token_a: tokenIn, token_b: tokenOut },
        trader,
      ),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
    // `swap_killed` is the AMM API's description of a pool, not the chain's answer, and
    // refusing on it blocked swaps that settle — see the note in plan.ts. The re-quote
    // below is the real check: it refuses when the pool cannot actually fill the floor.
    reserves = poolReservesFrom(payload);
  } catch { return step.targetOut ? { kind: "refuse", message: "The live pool could not be re-quoted for the exact output you approved. Nothing was submitted." } : unchanged; }
  if (!reserves) return step.targetOut ? { kind: "refuse", message: "The live pool reserves are unavailable for the exact output you approved. Nothing was submitted." } : unchanged;
  let quoted: bigint | null;
  let floorWad: bigint;
  try {
    const { inWad, outWad, feeWad } = reservesForDirection(reserves, tokenIn.toUpperCase() === "XLM");
    quoted = constantProductOut(decimalWad(amountIn), inWad, outWad, feeWad);
    floorWad = decimalWad(minOut);
  } catch { return step.targetOut ? { kind: "refuse", message: "The exact-output quote could not be checked. Nothing was submitted." } : unchanged; }
  if (quoted === null) return step.targetOut ? { kind: "refuse", message: "The exact-output quote could not be checked. Nothing was submitted." } : unchanged;
  if (step.targetOut && quoted < decimalWad(step.targetOut)) {
    return { kind: "refuse", message: `The pool now offers about ${formatWad(quoted)} ${tokenOut} for ${amountIn} ${tokenIn}, below the ${step.targetOut} ${tokenOut} you approved. Nothing was submitted; ask for a fresh quote.` };
  }
  if (step.targetOut) return unchanged;
  if (quoted >= floorWad) return unchanged;

  // The pool pays less than approved. Whether that is fine or dangerous is not a question
  // the pool's own reserves can answer — it needs the oracle, the same way the propose-time
  // guard does, so both ends of the same trade are judged by the same yardstick.
  let inUsd: unknown, outUsd: unknown;
  try {
    [inUsd, outUsd] = await interruptible(
      () => Promise.all([
        mcp.call("vanna_get_price", { symbol: tokenIn }, trader),
        mcp.call("vanna_get_price", { symbol: tokenOut }, trader),
      ]),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
  } catch { return adjustedOrUnchanged(quoted, tokenIn, tokenOut, amountIn, minOut); }
  const inPriceWad = priceWadFrom(inUsd);
  const outPriceWad = priceWadFrom(outUsd);
  if (inPriceWad === null || outPriceWad === null) {
    return adjustedOrUnchanged(quoted, tokenIn, tokenOut, amountIn, minOut);
  }
  const inUsdWad = mulDown(decimalWad(amountIn), inPriceWad, WAD);
  const outUsdWad = mulDown(quoted, outPriceWad, WAD);
  // A user who accepted the loss gets the trade, re-quoted: the floor drops to what the
  // pool pays NOW, which is what "execute at whatever price" has to mean if it is to mean
  // anything safe. Sending no floor at all would leave the fill to whoever moves the pool
  // next in the same ledger, so the fresh quote — not nothing — becomes the floor.
  if (isDangerousFill(inUsdWad, outUsdWad) && !slippageAccepted) {
    return {
      kind: "refuse",
      message: `Not submitted — the pool's price moved after you approved this, and now fills at a loss: `
        + `${tokenIn} → ${tokenOut} would settle for about ${formatWad(quoted)} ${tokenOut} for ${amountIn} ${tokenIn}, `
        + `well below the ${minOut} ${tokenOut} floor you approved and below what ${tokenIn} is worth. `
        + `Ask again for a fresh quote, or say you accept the loss and it will be swapped as asked.`,
    };
  }
  return adjustedOrUnchanged(quoted, tokenIn, tokenOut, amountIn, minOut);
}

/** The pool moved but the fresh fill is still fair: adjust the floor down and say so, plainly. */
function adjustedOrUnchanged(quoted: bigint, tokenIn: string, tokenOut: string, amountIn: string, approvedMinOut: string): StaleFloorVerdict {
  const freshFloor = formatWad(slippageFloor(quoted));
  return {
    kind: "adjusted",
    minOut: freshFloor,
    note: `The pool's price moved after you approved this: ${tokenIn} → ${tokenOut} settled for about `
      + `${formatWad(quoted)} ${tokenOut} instead of the ${approvedMinOut} ${tokenOut} originally quoted for ${amountIn} ${tokenIn}.`,
  };
}

function priceWadFrom(response: unknown): bigint | null {
  if (!isRecord(response) || typeof response.price_usd !== "string") return null;
  try { return decimalWad(response.price_usd); } catch { return null; }
}

const REQUOTE_MS = 8_000;

/** Floor a WAD amount to Stellar token precision without ever rounding a spend upward. */
function tokenAmount(value: bigint, places = 7): string {
  const [whole, fraction = ""] = formatWad(value).split(".");
  let kept = fraction.slice(0, places);
  while (kept.endsWith("0")) kept = kept.slice(0, -1);
  return kept ? `${whole}.${kept}` : whole;
}

/**
 * "All of it" is a reading, so the write takes the reading again.
 *
 * ## The race this closes
 *
 * A full exit is sized from a position read, frozen into the proposal as a literal, and
 * then waits — for the proposal to build, for a person to press Approve, and with
 * auto-sign off for that person to sign. A Blend supply does not hold still through any
 * of that: the b-rate accrues, so the underlying the plan named is quietly no longer the
 * underlying the position holds. Send the frozen figure and the exit either leaves dust
 * behind or, when the balance moved the other way, reverts on chain — after signing,
 * which is the worst moment to learn it.
 *
 * Only steps whose sizing recorded `whole_position` are touched. A number the user stated
 * is never re-derived: "withdraw 100" means 100 even if the position grew, and that is the
 * distinction `StepSizing` exists to carry.
 *
 * Fails OPEN. A read that is unavailable, slow or shaped unexpectedly leaves the approved
 * amount alone — the protocol's own balance check is still the backstop, and a read being
 * down is not a reason to refuse an exit the user approved. A position that now reads ZERO
 * is the one hard stop: there is nothing to withdraw, and saying so beats a revert.
 */
export async function stalePositionAmount(
  step: ProposalStep,
  args: Record<string, unknown>,
  mcp: Pick<MCPClient, "call">,
  scope: InvestigationScope,
  signal: AbortSignal,
): Promise<StalePositionVerdict> {
  const unchanged: StalePositionVerdict = { kind: "unchanged" };
  const sizing = step.sizing;
  if (!sizing || sizing.basis !== "whole_position" || !isPositionRowRead(sizing.read)) return unchanged;
  // Only the plain `amount` field, which is how every position op that states a token
  // size names it. A tool whose size is called something else -- a swap's `amount_in` --
  // cannot take the re-read figure, and "adjusted" must never come back for a write whose
  // args this cannot actually change, or the note would describe an amount nobody sent.
  // Returning here rather than after the read also spares that write a pointless call.
  if (typeof args.amount !== "string") return unchanged;
  if (!scope.trader) return unchanged;
  const def = resolveAssetDef(step.asset);
  if (!def?.marginSymbol) return unchanged;

  let data: Record<string, unknown>;
  try {
    const read = resolveRead(sizing.read, {}, scope);
    const payload = await interruptible(
      () => mcp.call(read.tool, read.args, scope.trader!),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
    if (!isRecord(payload) || payload.error) return unchanged;
    data = payload;
  } catch { return unchanged; }

  // The protocol's own rendering of the balance: already at the token's precision, so it
  // is used as read rather than re-rounded against a decimals table this path cannot see.
  const amount = positionRowIn(data, POSITION_ROWS[sizing.read], def.marginSymbol, def.id);
  if (amount === null) return unchanged;
  let amountWad: bigint;
  try { amountWad = decimalWad(amount); } catch { return unchanged; }
  if (amountWad <= ZERO) {
    return {
      kind: "refuse",
      message: `There is no ${def.displayLabel ?? def.id} left in that position to withdraw. Nothing was submitted.`,
    };
  }
  let approvedWad: bigint;
  try { approvedWad = decimalWad(step.amount); } catch { return unchanged; }
  if (amountWad === approvedWad) return unchanged;
  return {
    kind: "adjusted",
    amount,
    note: `The whole position was ${step.amount} ${def.displayLabel ?? def.id} when this was prepared and is ${amount} now, so that is what was withdrawn.`,
  };
}

/** What measuring a removal's settled payout decided, immediately before the next write. */
export type SettledPayoutVerdict =
  | { kind: "unchanged" }
  | { kind: "adjusted"; amount: string; note: string }
  | { kind: "refuse"; message: string };

/** What reading the margin account immediately before a removal is submitted decided. */
export type RemovalBaselineVerdict =
  | { kind: "unchanged" }
  | { kind: "recorded"; balances: Record<string, string> }
  | { kind: "refuse"; message: string };

const PAYOUT_UNREAD_BEFORE = "The margin account balance could not be read before removing liquidity, so the payout cannot be measured. Nothing was submitted. Approve a new proposal to try again.";
const PAYOUT_UNREAD_AFTER = "The margin account balance could not be read after the removal settled, so this step was not submitted. Approve a new proposal to continue.";
const PAYOUT_UNRECORDED = "The balance from before the removal was not recorded, so this step was not submitted. Approve a new proposal to continue.";

function payoutDependents(proposal: WorkflowProposal, removalId: string): ProposalStep[] {
  return proposal.steps.filter((entry) => entry.sizing?.basis === "settled_payout" && entry.sizing.fromStep === removalId);
}

/**
 * One collateral read, parsed the same way the sizer reads a posted balance.
 * A missing row on a well-formed read is zero. An untrusted row or a failed call is a failure.
 */
async function readAccountBalances(
  assets: readonly string[],
  mcp: Pick<MCPClient, "call">,
  scope: InvestigationScope,
  signal: AbortSignal,
): Promise<{ ok: true; balances: Record<string, string> } | { ok: false }> {
  const trader = scope.trader;
  if (!trader || !scope.smartAccount || assets.length === 0) return { ok: false };
  let data: Record<string, unknown>;
  try {
    const read = resolveRead("account_collateral", {}, scope);
    const payload = await interruptible(
      () => mcp.call(read.tool, read.args, trader),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
    if (!isRecord(payload) || payload.error || !Array.isArray(payload.collateral)) return { ok: false };
    data = payload;
  } catch {
    return { ok: false };
  }
  const balances: Record<string, string> = {};
  for (const asset of assets) {
    const def = resolveAssetDef(asset);
    if (!def?.marginSymbol) return { ok: false };
    const rows = data.collateral as unknown[];
    const untrusted = rows.some((entry) => isRecord(entry)
      && (entry.symbol === def.marginSymbol || entry.symbol === def.id)
      && entry.balance_untrusted === true);
    if (untrusted) return { ok: false };
    const amount = positionRowIn(data, POSITION_ROWS.account_collateral, def.marginSymbol, def.id) ?? "0";
    try { decimalWad(amount); } catch { return { ok: false }; }
    balances[asset] = amount;
  }
  return { ok: true, balances };
}

/**
 * Read the margin-account balances a later leg will difference, immediately before
 * the removal is submitted. Planning reads are not reused. A removal with no
 * settled-payout dependent is left alone.
 */
export async function removalBalanceBaseline(
  step: ProposalStep,
  proposal: WorkflowProposal,
  mcp: Pick<MCPClient, "call">,
  scope: InvestigationScope,
  signal: AbortSignal,
): Promise<RemovalBaselineVerdict> {
  if (step.op !== "remove_liquidity") return { kind: "unchanged" };
  const dependents = payoutDependents(proposal, step.id);
  if (!dependents.length) return { kind: "unchanged" };
  const assets = [...new Set(dependents.map((entry) => entry.sizing?.basis === "settled_payout" ? entry.sizing.asset : entry.asset))];
  const read = await readAccountBalances(assets, mcp, scope, signal);
  if (!read.ok) return { kind: "refuse", message: PAYOUT_UNREAD_BEFORE };
  return { kind: "recorded", balances: read.balances };
}

/**
 * Spend what the removal actually paid in this leg's asset.
 *
 * The approved amount stays the pool-read estimate. The sent amount is the rise in
 * the margin-account balance of that asset since the read taken just before the
 * removal was submitted. The band is `SWAP_SLIPPAGE_BPS` on either side of the
 * estimate, the same margin `slippageFloor` applies below a quote. Outside that
 * band the leg is not submitted.
 *
 * Fails closed. A missing or unreadable balance does not fall back to the estimate.
 */
export async function settledRemovalPayout(
  step: ProposalStep,
  states: ReadonlyArray<{ id: string; balancesBefore?: Record<string, string> }>,
  args: Record<string, unknown>,
  mcp: Pick<MCPClient, "call">,
  scope: InvestigationScope,
  signal: AbortSignal,
): Promise<SettledPayoutVerdict> {
  const unchanged: SettledPayoutVerdict = { kind: "unchanged" };
  const sizing = step.sizing;
  if (!sizing || sizing.basis !== "settled_payout") return unchanged;
  if (typeof args.amount !== "string") return { kind: "refuse", message: PAYOUT_UNREAD_AFTER };
  const before = states.find((entry) => entry.id === sizing.fromStep)?.balancesBefore?.[sizing.asset];
  if (before === undefined) return { kind: "refuse", message: PAYOUT_UNRECORDED };
  const read = await readAccountBalances([sizing.asset], mcp, scope, signal);
  if (!read.ok) return { kind: "refuse", message: PAYOUT_UNREAD_AFTER };
  let beforeWad: bigint, afterWad: bigint, estimateWad: bigint;
  try {
    beforeWad = decimalWad(before);
    afterWad = decimalWad(read.balances[sizing.asset]);
    estimateWad = decimalWad(step.amount);
  } catch {
    return { kind: "refuse", message: PAYOUT_UNREAD_AFTER };
  }
  const label = resolveAssetDef(sizing.asset)?.displayLabel ?? sizing.asset;
  if (afterWad < beforeWad) {
    return {
      kind: "refuse",
      message: `The margin account balance of ${label} did not increase when liquidity was removed. Nothing was submitted. Approve a new proposal to continue.`,
    };
  }
  const payoutWad = afterWad - beforeWad;
  // `SWAP_SLIPPAGE_BPS` (0.5%) is the margin a quote is already held to. The same width sits on either side of the estimate.
  const band = (estimateWad * SWAP_SLIPPAGE_BPS) / BigInt(10_000);
  const lower = estimateWad > band ? estimateWad - band : ZERO;
  const upper = estimateWad + band;
  if (payoutWad < lower || payoutWad > upper) {
    return {
      kind: "refuse",
      message: `The removal paid ${tokenAmount(payoutWad)} ${label}, outside the approved estimate of ${step.amount} ${label}. Approve a new proposal for the amount that arrived. Nothing was submitted.`,
    };
  }
  const amount = tokenAmount(payoutWad);
  let sent: bigint;
  try { sent = decimalWad(amount); } catch { return { kind: "refuse", message: PAYOUT_UNREAD_AFTER }; }
  if (sent <= ZERO) {
    return { kind: "refuse", message: `The removal's payout of ${label} rounds to nothing, so this step was not submitted.` };
  }
  if (sent === estimateWad) return unchanged;
  return {
    kind: "adjusted",
    amount,
    note: `The removal paid ${amount} ${label}. The approved estimate was ${step.amount} ${label}, so this step spends the measured payout.`,
  };
}

/**
 * Refresh an LP leg's token ratio and share floor immediately before invoking the MCP.
 *
 * The proposal records maximum spends for both tokens. When the reserve ratio moves, the
 * fresh proportional pair is chosen inside those maxima: keep amount A when its newly
 * required B still fits, otherwise reduce A to fit the approved B. A refresh can therefore
 * make the deposit smaller, but can never authorize spending more of either token than the
 * user reviewed. The LP-share floor is then recomputed from the same fresh reserves.
 */
export async function staleLiquidityAmounts(
  step: ProposalStep,
  mcp: Pick<MCPClient, "call">,
  trader: string,
  signal: AbortSignal,
): Promise<StaleLiquidityVerdict> {
  const unchanged: StaleLiquidityVerdict = { kind: "unchanged" };
  if (step.op !== "add_liquidity") return unchanged;
  const venue = typeof step.args.venue === "string" ? step.args.venue : "";
  if (venue !== "aquarius" && venue !== "soroswap") return unchanged;
  const tokenA = typeof step.args.token_a === "string" ? step.args.token_a : "";
  const tokenB = typeof step.args.token_b === "string" ? step.args.token_b : "";
  const approvedA = typeof step.args.amount_a === "string" ? step.args.amount_a : "";
  const approvedB = typeof step.args.amount_b === "string" ? step.args.amount_b : "";
  if (!tokenA || !tokenB || !approvedA || !approvedB) return unchanged;

  let reserves: PoolReserves | null = null;
  // Why the refresh failed. The refusal below is unchanged; this only keeps the cause, which
  // was swallowed: 23 Sep, X10 leg 5 said "reserves could not be refreshed" and the reason
  // (a swapped token_0 and an empty fee in the MCP payload) had to be dug out of the MCP.
  let why = "";
  try {
    const payload = await interruptible(
      () => mcp.call(
        venue === "soroswap" ? "vanna_get_soroswap_pool_stats" : "vanna_get_aquarius_pool_stats",
        { token_a: tokenA, token_b: tokenB },
        trader,
      ),
      AbortSignal.any([signal, AbortSignal.timeout(REQUOTE_MS)]),
    );
    reserves = poolReservesFrom(payload);
    // MCP errors often arrive as a 200 with an error body, so an unreadable payload is kept too.
    if (!reserves) why = `unusable payload: ${JSON.stringify(payload).slice(0, 400)}`;
  } catch (error) {
    why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  if (!reserves) {
    console.warn("[copilot] LP reserves refresh failed", { venue, tokenA, tokenB, why });
    return { kind: "refuse", message: "The pool's live reserves could not be refreshed, so stale liquidity amounts were not submitted. Prepare the plan again." };
  }

  try {
    const aIsXlm = tokenA.toUpperCase() === "XLM";
    const bIsXlm = tokenB.toUpperCase() === "XLM";
    if (aIsXlm === bIsXlm) {
      return { kind: "refuse", message: "The live LP pair could not be matched to its reserves. Nothing was submitted." };
    }
    const reserveA = decimalWad(aIsXlm ? reserves.xlm : reserves.paired);
    const reserveB = decimalWad(bIsXlm ? reserves.xlm : reserves.paired);
    const maxA = decimalWad(approvedA);
    const maxB = decimalWad(approvedB);
    if (reserveA <= ZERO || reserveB <= ZERO || maxA <= ZERO || maxB <= ZERO) {
      return { kind: "refuse", message: "The refreshed LP ratio did not produce positive deposit amounts. Nothing was submitted." };
    }

    const bForMaxA = (maxA * reserveB) / reserveA;
    const freshA = bForMaxA <= maxB ? maxA : (maxB * reserveA) / reserveB;
    const freshB = bForMaxA <= maxB ? bForMaxA : maxB;
    const amountA = tokenAmount(freshA);
    const amountB = tokenAmount(freshB);
    const amountAWad = decimalWad(amountA);
    const amountBWad = decimalWad(amountB);
    if (amountAWad <= ZERO || amountBWad <= ZERO) {
      return { kind: "refuse", message: "The refreshed LP amounts round below token precision. Nothing was submitted." };
    }
    const sharesFromA = (amountAWad * decimalWad(reserves.totalShare)) / reserveA;
    const sharesFromB = (amountBWad * decimalWad(reserves.totalShare)) / reserveB;
    const expectedShares = sharesFromA < sharesFromB ? sharesFromA : sharesFromB;
    const minLiquidityOut = tokenAmount(slippageFloor(expectedShares));
    if (decimalWad(minLiquidityOut) <= ZERO) {
      return { kind: "refuse", message: "The refreshed LP share floor rounds to zero. Nothing was submitted." };
    }
    return {
      kind: "adjusted",
      amountA,
      amountB,
      minLiquidityOut,
      note: `The pool ratio was refreshed immediately before execution: the liquidity deposit used ${amountA} ${tokenA} + ${amountB} ${tokenB}, within the amounts you approved.`,
    };
  } catch {
    return { kind: "refuse", message: "The live LP ratio could not be calculated safely. Nothing was submitted." };
  }
}

function hashOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

export async function readyForStep(proposal: WorkflowProposal, step: ProposalStep): Promise<StepReadiness> {
  const reason = await validateWorkflowRisk({ ...proposal, steps: [step] }, getMcpClient(), AbortSignal.timeout(45_000));
  return reason ? { kind: "stop", reason } : { kind: "ready" };
}

export async function lookupTransaction(hash: string): Promise<{ found: true; success: boolean; ledger: number } | { found: false }> {
  try {
    const [StellarSdk, { SOROBAN_RPC_URL }] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("@/lib/stellar-utils"),
    ]);
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const tx = await interruptible(() => server.getTransaction(hash), AbortSignal.timeout(10_000));
    if (tx.status !== "SUCCESS" && tx.status !== "FAILED") return { found: false };
    const ledger = Number(tx.ledger);
    if (!Number.isSafeInteger(ledger) || ledger <= 0) return { found: false };
    return { found: true, success: tx.status === "SUCCESS", ledger };
  } catch { /* RPC unavailable — leave the step submitted */ }
  return { found: false };
}

async function settleSubmitted(
  journal: ReturnType<typeof workflowJournal>,
  id: string,
  identity: { scope: WorkflowProposal["scope"]; server: string },
  lookup: LedgerLookup,
  note?: string,
) {
  const stored = await journal.read(id, identity);
  const step = stored.value.steps.find((entry) => entry.status === "submitted" && entry.txHash);
  if (!step?.txHash) return stored.value;
  const outcome = await lookup(step.txHash);
  if (!outcome.found) return stored.value;
  return journal.settled(id, identity, step.id, step.txHash, outcome.ledger, outcome.success, note);
}

export async function advanceWorkflow(input: {
  id: string;
  subject: string;
  secret: string;
  server: string;
  network: string;
  mcp: Pick<MCPClient, "call">;
  signal: AbortSignal;
  ready?: typeof readyForStep;
  lookupTx?: LedgerLookup;
}): Promise<WorkflowView> {
  const journal = workflowJournal(input.secret);
  // Where an execution's seconds go (25 Sep: a card sat on its in-flight line long enough to
  // be reported). One line per phase, keyed by workflow, so a slow run can be read back.
  const startedAt = Date.now();
  let lastAt = startedAt;
  const phase = (name: string, extra?: Record<string, unknown>) => {
    const now = Date.now();
    console.info("[copilot] workflow phase", { id: input.id, phase: name, ms: now - lastAt, total: now - startedAt, ...extra });
    lastAt = now;
  };
  const stored = await journal.lookup(input.id, input.subject);
  const expected = stored.value.proposal.scope;
  if (stored.value.proposal.server !== input.server || expected.network !== input.network)
    throw new ResearchError("context_expired", "The execution environment changed. Prepare a new proposal.");
  const scope = await resolveInvestigationScope({
    subject: input.subject, wallet: expected.trader, network: input.network,
  }, input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  if (scope.subject !== expected.subject || scope.trader !== expected.trader ||
    scope.smartAccount !== expected.smartAccount || scope.network !== expected.network) {
    throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
  }
  phase("scope");
  const identity = identityOf(stored.value.proposal);
  const lookup = input.lookupTx ?? lookupTransaction;
  let record = await settleSubmitted(journal, input.id, identity, lookup);
  phase("settle_previous");
  if (record.steps.some(s => ["submitted", "invoking", "submitting"].includes(s.status))) return workflowView(record);
  if (["completed", "blocked", "cancelled", "uncertain", "awaiting_signature"].includes(record.status)) {
    return workflowView(record);
  }
  if (!["approved", "running"].includes(record.status)) {
    return workflowView(record);
  }

  let step: ProposalStep;
  try {
    step = await journal.claimNext(input.id, identity, input.ready ?? readyForStep);
    phase("claim", { tool: step.tool });
  } catch (error) {
    if (error instanceof WorkflowConflict && error.message === "no_pending_step") {
      return workflowView((await journal.read(input.id, identity)).value);
    }
    if (error instanceof WorkflowConflict) {
      throw new ResearchError(error.message, journalMessage(error.message), 409);
    }
    throw error;
  }

  if (!WRITE_TOOLS.has(step.tool) || !scope.trader || (!WALLET_TOOLS.has(step.tool) && !scope.smartAccount)) {
    record = await journal.invocationResult(input.id, identity, step.id, {
      kind: "failed", message: "This step is not an allowed write for the connected account. Nothing was submitted.",
    });
    return workflowView(record);
  }

  let invocation: ReturnType<typeof allowedInvocation>;
  try { invocation = allowedInvocation(step, scope); }
  catch {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, {
      kind: "failed", message: "The protocol operation did not match the approved arguments. Nothing was submitted.",
    }));
  }
  /**
   * Re-quote the pool before spending the user's approval on a price that has already moved.
   * A moved price alone does not stop the write — only a fill that would itself be a bad
   * trade does (`staleSwapFloor`'s own "refuse" case). Otherwise the floor is sent as
   * approved, or lowered to what the pool actually offers with a note recording it — never
   * a silent substitution the user only discovers from their balance afterward.
   */
  const acceptedLoss = stored.value.proposal.slippageAccepted === true;
  const stale = await staleSwapFloor(step, input.mcp, scope.trader, input.signal, acceptedLoss);
  if (stale.kind === "refuse") {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: stale.message }));
  }
  const liquidity = await staleLiquidityAmounts(step, input.mcp, scope.trader, input.signal);
  if (liquidity.kind === "refuse") {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: liquidity.message }));
  }
  /**
   * An amount that WAS the whole position is re-read from the same source that produced
   * it. The position accrues while the plan waits for a click, and the frozen figure is
   * the one that leaves dust or reverts.
   */
  const position = await stalePositionAmount(step, invocation.args, input.mcp, scope, input.signal);
  if (position.kind === "refuse") {
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: position.message }));
  }
  const positionArgs = position.kind === "adjusted"
    ? { ...invocation.args, amount: position.amount }
    : invocation.args;
  const swapAdjustedArgs = stale.kind === "adjusted" ? { ...positionArgs, min_out: stale.minOut } : positionArgs;
  const adjustedArgs = liquidity.kind === "adjusted"
    ? {
        ...swapAdjustedArgs,
        amount_a: liquidity.amountA,
        amount_b: liquidity.amountB,
        min_liquidity_out: liquidity.minLiquidityOut,
      }
    : swapAdjustedArgs;
  // Tell the MCP a human was shown this fill and took it. Its own impact gate withholds
  // auto-sign otherwise, which for an accepted trade is the same confirmation twice.
  const live = await journal.read(input.id, identity);
  const payout = await settledRemovalPayout(step, live.value.steps, adjustedArgs, input.mcp, scope, input.signal);
  if (payout.kind === "refuse") {
    return workflowView(await journal.pauseForReapproval(input.id, identity, step.id, payout.message));
  }
  const payoutArgs = payout.kind === "adjusted" ? { ...adjustedArgs, amount: payout.amount } : adjustedArgs;
  const invocationArgs = acceptedLoss && step.op === "swap"
    ? { ...payoutArgs, acknowledged_price_impact: true }
    : payoutArgs;
  const note = [
    stale.kind === "adjusted" ? stale.note : null,
    liquidity.kind === "adjusted" ? liquidity.note : null,
    position.kind === "adjusted" ? position.note : null,
    payout.kind === "adjusted" ? payout.note : null,
  ].filter((value): value is string => !!value).join(" ") || null;

  const baseline = await removalBalanceBaseline(step, live.value.proposal, input.mcp, scope, input.signal);
  if (baseline.kind === "refuse") {
    return workflowView(await journal.pauseForReapproval(input.id, identity, step.id, baseline.message));
  }
  if (baseline.kind === "recorded") {
    await journal.noteBalancesBefore(input.id, identity, step.id, baseline.balances);
  }

  phase("prewrite_checks");
  let build: Record<string, unknown>;
  try {
    const raw = await interruptible(() => input.mcp.call(invocation.tool, invocationArgs, scope.trader!),
      AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]));
    if (!isRecord(raw)) throw new Error("invalid_write_result");
    build = raw;
    phase("mcp_write", { tool: invocation.tool });
  } catch (error) {
    // This catch used to be silent: a step went "uncertain" with nothing in any log
    // explaining why, so a timeout, a transport error and a malformed payload were
    // indistinguishable from the outside. `error` is never a broadcast proof either way,
    // so the outcome is unchanged — only the diagnostic trail is new.
    console.warn("[copilot] write call failed, step marked uncertain", {
      tool: invocation.tool,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" }));
  }
  const hash = hashOf(build.tx_hash);
  const unsigned = typeof build.unsigned_xdr === "string" ? build.unsigned_xdr : null;
  /**
   * `signing_status` is the MCP saying what it did, and it outranks `error`.
   *
   * A write it could not auto-sign is not a write that failed: `maybe_auto_sign` keeps the
   * built envelope and annotates it `signing_status: "needs_wallet_sign"` with the reason
   * auto-sign was unavailable in `error` — an unbound wallet, a dead session, a cap. This
   * line used to read `unsigned && !build.error`, so any reason at all disqualified a
   * perfectly signable transaction from the wallet-sign route below and dropped it into
   * "error", where `preBroadcastRejection` reported the MCP's own signing instructions to
   * the user as a protocol rejection. A Freighter wallet has no Sign Service session by
   * construction, so that was every write it ever made.
   */
  const needsWalletSign = build.signing_status === "needs_wallet_sign";
  const result = { status: hash ? "signed_and_submitted" : unsigned && (needsWalletSign || !build.error) ? "needs_wallet_sign" : "error", build,
    submitted: null, unsigned_xdr: unsigned };

  /**
   * The MCP's error envelope (`mcp_server/error_handling.py`) attaches `reason`, `code`
   * or `contract_diagnostic` only to failures it classified INSIDE the tool — simulation
   * and validation, before anything was submitted — and a submitted transaction always
   * carries its hash. Such an envelope is a rejection with a reason, and the reason is
   * the one line the user needs; filing it as "uncertain" hid it (13 Sep deposit).
   */
  const rejection = preBroadcastRejection(build, hash, step);
  if (rejection) {
    console.warn("[copilot] write rejected before broadcast", { tool: invocation.tool, error: build.error, code: build.code, reason: build.reason, message: rejection.slice(0, 300) });
    return workflowView(await journal.invocationResult(input.id, identity, step.id, { kind: "failed", message: rejection }));
  }

  if (result.status === "signed_and_submitted") {
    const txHash = hash;
    if (!txHash) {
      record = await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" });
      return workflowView(record);
    }
    record = await journal.invocationResult(input.id, identity, step.id, { kind: "submitted", txHash, note: note ?? undefined });
    record = await settleSubmitted(journal, input.id, identity, lookup, note ?? undefined);
    phase("settle", { settled: record.steps.find(s => s.id === step.id)?.status === "settled" });
    persistRun(record, input.subject);
    return workflowView(record);
  }

  if (result.status === "needs_wallet_sign" && result.unsigned_xdr) {
    /**
     * Auto sign was armed and the transaction still came back unsigned — the Sign
     * Service refused this one. Say why.
     *
     * Its reason is the thing the user needs and the only thing that tells them what to
     * do next: a spend over the per-tx or daily cap is fixed by raising the cap, an
     * unallowlisted contract by re-enabling, a dead session by enabling again. Without
     * it the card said "sign this in your wallet" for every one of those, and a user who
     * had armed a budget precisely so they would not have to was left with a popup and
     * no idea which of their own limits had stopped it.
     *
     * The text is MCP's own (`sign_tools.maybe_auto_sign`), passed through rather than
     * re-derived here: the Sign Service owns that vocabulary, it grows on their side,
     * and a copy of it here would be a list to keep in step and get wrong.
     */
    const refusal = autoSignRefusal(build);
    record = await journal.invocationResult(input.id, identity, step.id, {
      kind: "unsigned", unsignedXdr: result.unsigned_xdr,
      note: [note, refusal].filter(Boolean).join(" ") || undefined,
    });
    return workflowView(record);
  }

  // A returned error can occur after broadcasting. Without a transaction reference
  // or a proven pre-broadcast rejection, don't claim that nothing was submitted.
  record = await journal.invocationResult(input.id, identity, step.id, { kind: "uncertain" });
  return workflowView(record);
}

/**
 * Why auto sign did not sign this one — MCP's own sentence, or null when it signed or
 * was never armed.
 *
 * `auto_sign` is the Sign Service's verdict on this transaction: "on" when it signed,
 * and anything else ("rejected" over a cap or an allowlist, "disabled" with no session,
 * "unavailable" when unreachable) when it did not. Only the refusals carry a message,
 * and it is passed through verbatim — which reason exists, and what to do about each,
 * is the Sign Service's to say, not something this file should keep its own copy of.
 */
export function autoSignRefusal(build: Record<string, unknown>): string | null {
  const verdict = typeof build.auto_sign === "string" ? build.auto_sign : null;
  if (!verdict || verdict === "on") return null;
  const message = typeof build.message === "string" ? build.message.trim() : "";
  return message || null;
}

/** The MCP's own message when its envelope proves nothing was broadcast; null otherwise. */
export function preBroadcastRejection(
  build: Record<string, unknown>,
  hash: string | null,
  step?: { op?: string; args?: Record<string, unknown> },
): string | null {
  if (hash || typeof build.error !== "string" || !build.error) return null;
  /**
   * A transaction the wallet can still sign was not rejected. `maybe_auto_sign` returns
   * the built envelope with `signing_status: "needs_wallet_sign"` and puts the reason
   * auto-sign was unavailable in `error`; reading that as a refusal discarded the
   * envelope and told the user the protocol had turned them down.
   */
  if (build.signing_status === "needs_wallet_sign"
    && typeof build.unsigned_xdr === "string" && build.unsigned_xdr.length > 20) return null;
  const classified = typeof build.contract_diagnostic === "string" || typeof build.reason === "string" || typeof build.code === "string" || build.simulation_success === false;
  if (!classified) return null;
  const message = typeof build.message === "string" && build.message.trim() ? build.message.trim() : `${build.error}${build.reason ? ` (${String(build.reason).replaceAll("_", " ")})` : ""}`;
  const note = swapFloorNote(step, message);
  return `Not submitted — the protocol rejected this step before broadcast: ${message}${note ? ` ${note}` : ""}`;
}

/**
 * A swap carries a floor (`min_out`) the DEX must meet or the call reverts, and the raw
 * revert is a bare contract code — "HostError #2006" told the user nothing (15 Sep, live).
 * The floor is the one thing about that failure we can state as fact, so it is named, and
 * the likeliest reading of it is offered AS a reading, not as a diagnosis: the error codes
 * belong to the DEX's own contract, not to Vanna's, so their meanings are not ours to
 * assert.
 *
 * This is now the SECOND line of defence, not the first: `staleSwapFloor` re-quotes the
 * pool before the write and states "the price moved" in plain words with both figures.
 * A rejection that still reaches here is one that re-quote could not foresee — the pool
 * read was unavailable, the pair is not Aquarius, or the pool moved inside the last moment.
 */
function swapFloorNote(step: { op?: string; args?: Record<string, unknown> } | undefined, message: string): string | null {
  if (step?.op !== "swap") return null;
  const floor = typeof step.args?.min_out === "string" ? step.args.min_out : null;
  const bought = typeof step.args?.token_out === "string" ? step.args.token_out : null;
  if (!floor || !bought || !/contract|hosterror|simulation/i.test(message)) return null;
  return `This swap would only settle for at least ${floor} ${bought}; a DEX refuses the call outright when its pool cannot meet that, which is the most likely reading here — the code itself belongs to the DEX's contract, so it is not proof.`;
}

export async function confirmWorkflow(input: {
  id: string;
  txHash: string;
  subject: string;
  secret: string;
  server: string;
  network: string;
  mcp: Pick<MCPClient, "call">;
  signal: AbortSignal;
  lookupTx?: LedgerLookup;
}): Promise<WorkflowView> {
  const txHash = hashOf(input.txHash);
  if (!txHash) throw new ResearchError("invalid_request", "Send the submitted transaction hash only.", 400);
  const journal = workflowJournal(input.secret);
  const stored = await journal.lookup(input.id, input.subject);
  const expected = stored.value.proposal.scope;
  if (stored.value.proposal.server !== input.server || expected.network !== input.network)
    throw new ResearchError("context_expired", "The execution environment changed. Prepare a new proposal.");
  const scope = await resolveInvestigationScope({
    subject: input.subject, wallet: expected.trader, network: input.network,
  }, input.mcp, AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  if (scope.subject !== expected.subject || scope.trader !== expected.trader ||
    scope.smartAccount !== expected.smartAccount || scope.network !== expected.network) {
    throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
  }
  const identity = identityOf(stored.value.proposal);
  const waiting = stored.value.steps.find((step) => step.status === "awaiting_signature");
  if (!waiting) {
    throw new ResearchError("step_changed", "This plan is not waiting for a wallet signature.", 409);
  }
  let record = await journal.acceptSubmittedHash(input.id, identity, waiting.id, txHash);
  record = await settleSubmitted(journal, input.id, identity, input.lookupTx ?? lookupTransaction);
  return workflowView(record);
}

export async function submitWorkflow(input: {
  id: string; signedXdr: string; subject: string; secret: string; server: string; network: string;
  mcp: Pick<MCPClient, "call">; signal: AbortSignal;
}): Promise<WorkflowView> {
  const journal = workflowJournal(input.secret);
  const stored = await journal.lookup(input.id, input.subject);
  const expected = stored.value.proposal;
  if (expected.server !== input.server || expected.scope.network !== input.network) throw new ResearchError("context_expired", "The execution environment changed.");
  const scope = await resolveInvestigationScope({ subject: input.subject, wallet: expected.scope.trader, network: input.network }, input.mcp,
    AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]));
  const identity = { scope, server: input.server };
  const checked = await journal.read(input.id, identity);
  const waiting = checked.value.steps.find(s => s.status === "awaiting_signature");
  const step = expected.steps.find(s => s.id === waiting?.id);
  if (!waiting || !step) throw new ResearchError("step_changed", "This plan is not waiting for a signature.");
  const reason = await validateWorkflowRisk({ ...expected, steps: [step] }, input.mcp,
    AbortSignal.any([input.signal, AbortSignal.timeout(25_000)]));
  if (reason) throw new ResearchError("risk_validation_failed", reason);
  const baseline = await removalBalanceBaseline(step, expected, input.mcp, scope, input.signal);
  if (baseline.kind === "refuse") throw new ResearchError("step_not_ready", baseline.message);
  if (baseline.kind === "recorded") await journal.noteBalancesBefore(input.id, identity, step.id, baseline.balances);
  const record = await journal.acceptSignedEnvelope(input.id, identity, step.id, input.signedXdr);
  try {
    const [sdk, config] = await Promise.all([import("@stellar/stellar-sdk"), import("@/lib/stellar-utils")]);
    await interruptible(() => new sdk.rpc.Server(config.SOROBAN_RPC_URL).sendTransaction(
      sdk.TransactionBuilder.fromXDR(input.signedXdr, sdk.Networks.TESTNET)), AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]));
  } catch { return workflowView(record); }
  return workflowView(await settleSubmitted(journal, input.id, identity, lookupTransaction));
}

function journalMessage(code: string): string {
  switch (code) {
    case "workflow_not_runnable": return "This plan cannot run yet. Approve it first, or prepare a new one.";
    case "step_already_claimed": return "This step is already in progress.";
    case "step_not_ready": return "Conditions moved. This step was not submitted. Prepare a new plan.";
    case "no_pending_step": return "There is no remaining step to run.";
    default: return "This plan could not advance. Prepare a new one if it is stuck.";
  }
}

/**
 * Identity args come from the re-resolved scope, not the browser. Earn wants `lender`
 * on the G-wallet and rejects the margin overlay Blend writes need.
 */
export function invocationArgs(step: ProposalStep, scope: { trader: string | null; smartAccount: string | null }): Record<string, unknown> {
  if (WALLET_TOOLS.has(step.tool)) {
    return { symbol: step.args.symbol, amount: step.amount, lender: scope.trader };
  }
  return { ...step.args, amount: step.amount, smart_account: scope.smartAccount, trader: scope.trader };
}
