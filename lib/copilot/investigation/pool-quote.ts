/**
 * What a DEX pool actually pays — its own reserves, its own fee, its own curve.
 *
 * ## Why this exists
 *
 * A swap's floor (`min_out`) used to be priced at ORACLE PARITY: the USD value of what is
 * spent, converted to the bought token at the oracle's price, less a slippage margin. A
 * pool does not fill at the oracle's price. It fills at its own curve, after its own fee,
 * and its price drifts from the oracle's between arbitrages. 15 Sep, live: a 1,000 XLM →
 * AQUSDC swap was refused by the DEX outright (HostError #2006) because the floor demanded
 * oracle-parity output the pool was never going to pay — while the identical swap, quoted
 * against the pool itself, filled fine.
 *
 * Both the propose-time floor and the broadcast-time re-check read through here, so the
 * number shown on the card and the number checked against the live pool are produced by
 * one formula rather than two that can drift apart.
 */

import { decimalWad, mulDown, WAD, ZERO } from "./fixed";
import { isRecord } from "./decision";

export interface PoolReserves {
  /** Human decimal strings, exactly as the pool stats read states them. */
  xlm: string;
  paired: string;
  totalShare: string;
  /** The pool's fee as a FRACTION, not basis points: "0.0030" is 0.30%. */
  fee: string;
}

/**
 * The reserves of one Aquarius pool from a `vanna_get_aquarius_pool_stats` payload.
 *
 * The reserves dict is keyed by the AMM API's OWN token label, not our registry spelling
 * ("USDC", not "AQUSDC") — the same venue-vs-registry mismatch documented throughout this
 * codebase — so this reads by position (the "XLM" key is always exactly that; whichever
 * other key remains is the paired side) rather than assume the paired token's key matches
 * `marginSymbol` literally.
 *
 * Null whenever any part of it cannot be trusted: no pool, no reserves, an unparseable
 * figure, or a fee outside [0, 1). A quote is never guessed from a partial payload.
 */
export function poolReservesFrom(data: unknown): PoolReserves | null {
  if (!isRecord(data) || data.found !== true) return null;
  const pool = data.pool;
  if (!isRecord(pool) || pool.available === false || !isRecord(pool.reserves)) return null;
  if (pool.reserves_source === "amm_api") return null;
  const entries = Object.entries(pool.reserves);
  const xlm = entries.find(([key]) => key === "XLM")?.[1];
  const paired = entries.find(([key]) => key !== "XLM")?.[1];
  const totalShare = pool.total_share;
  const fee = pool.fee;
  if (!isNumeric(xlm) || !isNumeric(paired) || !isNumeric(totalShare) || !isNumeric(fee)) return null;
  try {
    decimalWad(String(xlm)); decimalWad(String(paired)); decimalWad(String(totalShare));
    const feeWad = decimalWad(String(fee));
    if (feeWad < ZERO || feeWad >= WAD) return null;
    return { xlm: String(xlm), paired: String(paired), totalShare: String(totalShare), fee: String(fee) };
  } catch { return null; }
}

function isNumeric(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * What a constant-product pool pays for `amountIn` — the Uniswap-V2 formula every such
 * pool settles by, which Aquarius's own contract implements:
 *
 *   out = reserveOut x inAfterFee / (reserveIn + inAfterFee),  inAfterFee = in x (1 - fee)
 *
 * Ignoring the fee would promise more than the pool pays and set a floor the pool can
 * never meet — the same failure in a different disguise — so the fee is required, not
 * defaulted. Null when any input makes the quote meaningless rather than returning a zero
 * a caller could mistake for a real answer.
 */
export function constantProductOut(
  amountInWad: bigint,
  reserveInWad: bigint,
  reserveOutWad: bigint,
  feeWad: bigint,
): bigint | null {
  if (amountInWad <= ZERO || reserveInWad <= ZERO || reserveOutWad <= ZERO) return null;
  if (feeWad < ZERO || feeWad >= WAD) return null;
  const inAfterFeeWad = mulDown(amountInWad, WAD - feeWad, WAD);
  if (inAfterFeeWad <= ZERO) return null;
  // Both operands are WAD-scaled, and the denominator is too, so the WADs cancel to one.
  return (reserveOutWad * inAfterFeeWad) / (reserveInWad + inAfterFeeWad);
}

/**
 * The most a swap may lose against the oracle's valuation before it is refused, in percent.
 *
 * THE SAME NUMBER THE WEBSITE'S OWN SWAP CARD BLOCKS ON — `components/spot/
 * spot-nonorderbook/SwapCard.tsx` (`isHighPriceImpact`, `pct > 5`), with the same formula:
 * impact = (in_usd - out_usd) / in_usd. The copilot must not accept a trade the site's own
 * UI would refuse to let through, so if that threshold moves, this moves with it.
 *
 * Why a floor alone is not enough: the floor says "settle at no worse than this", and a
 * pool-quoted floor is by construction always meetable — so on a pool too thin for the
 * size, a correct floor happily authorises a catastrophic fill. 15 Sep, live: the protocol's
 * own Aquarius XLM/AQUSDC pool held ~1,571 AQUSDC against ~133,000 XLM, so 1,000 XLM
 * (~$190) quoted ~11.7 AQUSDC — a 94% loss, which the website itself flags as "this pool's
 * liquidity is too thin for this trade size".
 */
export const MAX_PRICE_IMPACT_PCT = 5;

/**
 * How far a quoted fill sits below the oracle's valuation of what is spent, as a WAD
 * fraction (WAD/20 is 5%). Negative when the pool pays MORE than the oracle says, which is
 * not a loss and never refused. Null when either side cannot be valued.
 */
export function priceImpactWad(inUsdWad: bigint, outUsdWad: bigint): bigint | null {
  if (inUsdWad <= ZERO || outUsdWad < ZERO) return null;
  return ((inUsdWad - outUsdWad) * WAD) / inUsdWad;
}

/** True when a fill's price impact against the oracle exceeds the refuse threshold. */
export function isDangerousFill(inUsdWad: bigint, outUsdWad: bigint): boolean {
  const impact = priceImpactWad(inUsdWad, outUsdWad);
  return impact !== null && impact * BigInt(100) > WAD * BigInt(MAX_PRICE_IMPACT_PCT);
}

/**
 * The floor a fresh quote gets held to: SWAP_SLIPPAGE_BPS below the quote itself. One
 * constant for the propose-time floor and the approve-time re-quote, so "the number on the
 * card" and "the number the write is allowed to settle for" are never two different margins.
 */
export const SWAP_SLIPPAGE_BPS = BigInt(50); // 0.5%
export function slippageFloor(quotedOutWad: bigint): bigint {
  return (quotedOutWad * (BigInt(10_000) - SWAP_SLIPPAGE_BPS)) / BigInt(10_000);
}

/**
 * The input a constant-product pool needs for an EXACT output — the same curve as
 * `constantProductOut`, solved backwards:
 *
 *   inAfterFee = out x reserveIn / (reserveOut - out),  in = inAfterFee / (1 - fee)
 *
 * Null whenever the output cannot be sized honestly: non-positive inputs, a fee outside
 * [0, 1), or an output at or past the pool's own reserve of it (which does not fill at
 * any finite price — a pool cannot pay out more than it holds).
 */
export function exactOutputIn(
  amountOutWad: bigint,
  reserveInWad: bigint,
  reserveOutWad: bigint,
  feeWad: bigint,
): bigint | null {
  if (amountOutWad <= ZERO || reserveInWad <= ZERO || reserveOutWad <= ZERO) return null;
  if (feeWad < ZERO || feeWad >= WAD) return null;
  if (amountOutWad >= reserveOutWad) return null;
  const inAfterFeeWad = (amountOutWad * reserveInWad) / (reserveOutWad - amountOutWad);
  if (inAfterFeeWad <= ZERO) return null;
  return (inAfterFeeWad * WAD) / (WAD - feeWad);
}

/** The reserve of each side of a pool for a given spend direction, by registry id. */
export function reservesForDirection(
  reserves: PoolReserves,
  spentIsXlm: boolean,
): { inWad: bigint; outWad: bigint; feeWad: bigint } {
  return {
    inWad: decimalWad(spentIsXlm ? reserves.xlm : reserves.paired),
    outWad: decimalWad(spentIsXlm ? reserves.paired : reserves.xlm),
    feeWad: decimalWad(reserves.fee),
  };
}
