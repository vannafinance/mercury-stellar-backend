/**
 * How each venue turns its annual rate into the APY the product shows.
 *
 * Pure and dependency-free on purpose: `blend-utils.ts` pulls in the Stellar SDK and the
 * wallet adapter, so anything that needs this formula on the server (Copilot) cannot import
 * it from there. Both call sites use THIS function, so the Farm page and Copilot can never
 * quote the same reserve at two different rates.
 */

/**
 * Blend compounds its supply APR weekly — 52 periods a year — matching testnet.blend.capital.
 *
 * Verified 23 Sep against the live Farm page: an XLM supply APR of 173.3838% compounds to
 * 450.4%, and the page showed 450.29%.
 */
export function blendSupplyApyFromApr(aprDecimal: number): number {
  return Math.pow(1 + aprDecimal / 52, 52) - 1;
}
