/**
 * Quote a DEX swap the same way Trade/Spot does: the venue router, not the
 * oracle and not a naive reserve ratio.
 *
 * Spot's SwapCard calls AquariusService.getSwapQuote / SoroswapService.getSwapQuote
 * (`router_get_amounts_out` / `estimate_swap_routed`). Those include pool fee and
 * size impact. reserveOther/reserveXlm is the *spot* ratio and understated a real
 * 100 XLM → SOUSDC fill (~16.6 vs ~28.35).
 */
export function dexWireSymbol(token: string): "XLM" | "USDC" | null {
  const u = token.toUpperCase();
  if (u === "XLM") return "XLM";
  if (u === "USDC" || u === "AQUSDC" || u === "SOUSDC") return "USDC";
  return null;
}

export type DexQuote = {
  expected: number;
  /** expected / amountIn — 1 tokenIn ≈ rate tokenOut */
  rate: number;
};

export async function quoteDexSwap(opts: {
  amountIn: number;
  tokenIn: string;
  tokenOut: string;
  venue: "aquarius" | "soroswap";
  simulator: string;
}): Promise<DexQuote | null> {
  const { amountIn, venue, simulator } = opts;
  if (!(amountIn > 0) || !simulator) return null;
  const tokenIn = dexWireSymbol(opts.tokenIn);
  const tokenOut = dexWireSymbol(opts.tokenOut);
  if (!tokenIn || !tokenOut || tokenIn === tokenOut) return null;
  try {
    let raw: string | null = null;
    if (venue === "soroswap") {
      const { SoroswapService } = await import("@/lib/soroswap-utils");
      raw = await SoroswapService.getSwapQuote(amountIn, tokenIn, simulator, tokenOut);
    } else {
      const { AquariusService } = await import("@/lib/aquarius-utils");
      raw = await AquariusService.getSwapQuote(amountIn, tokenIn, simulator, tokenOut);
    }
    const expected = raw != null ? Number.parseFloat(raw) : NaN;
    if (!Number.isFinite(expected) || !(expected > 0)) return null;
    return { expected, rate: expected / amountIn };
  } catch {
    return null;
  }
}

/** `1 XLM ≈ 0.261694 SOUSDC` — the fill rate Trade/Spot shows, not oracle USD. */
export function swapFillRateLabel(
  amountIn: number,
  expectedOut: number,
  tokenIn: string,
  tokenOut: string,
): string | null {
  if (!(amountIn > 0) || !(expectedOut > 0) || !tokenIn || !tokenOut) return null;
  const rate = expectedOut / amountIn;
  return `1 ${tokenIn} ≈ ${formatCrossRate(rate)} ${tokenOut}`;
}

/** Trade/Spot header rate: oracle XLM/$ ÷ out/$, not the thin-pool fill. */
export function oracleSwapRateLabel(
  tokenIn: string,
  tokenOut: string,
  priceInUsd: number,
  priceOutUsd: number,
): string | null {
  if (!tokenIn || !tokenOut || !(priceInUsd > 0) || !(priceOutUsd > 0)) return null;
  return `1 ${tokenIn} ≈ ${formatCrossRate(priceInUsd / priceOutUsd)} ${tokenOut}`;
}

function formatCrossRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0";
  if (rate >= 100) return rate.toFixed(2);
  if (rate >= 1) return rate.toFixed(4);
  return rate.toFixed(6);
}

/** Farm-style `30 BLUSDC ≈ $30.01` — live oracle USD next to the tx hash. */
export function liveUsdLabel(amount: number, asset: string, priceUsd: number): string | null {
  if (!(amount > 0) || !asset || !(priceUsd > 0)) return null;
  const usd = amount * priceUsd;
  return `${amount} ${asset} ≈ $${usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
