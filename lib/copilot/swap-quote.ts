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

/** Invert the venue's own forward quote when the user fixed the receive amount. */
export async function quoteDexExactOut(opts: {
  targetOut: number; tokenIn: string; tokenOut: string;
  venue: "aquarius" | "soroswap"; simulator: string;
}): Promise<{ amountIn: number; expectedOut: number } | null> {
  if (!(opts.targetOut > 0)) return null;
  const forward = (amountIn: number) => quoteDexSwap({ ...opts, amountIn });
  const unit = await forward(1);
  if (!unit) return null;
  let low = 0;
  let high = Math.max(1, opts.targetOut / unit.expected);
  let highQuote = await forward(high);
  for (let i = 0; i < 6 && (!highQuote || highQuote.expected < opts.targetOut); i++) {
    low = high;
    high *= highQuote?.expected ? Math.max(1.05, opts.targetOut / highQuote.expected * 1.01) : 2;
    highQuote = await forward(high);
  }
  if (!highQuote || highQuote.expected < opts.targetOut) return null;
  for (let i = 0; i < 8; i++) {
    const middle = (low + high) / 2;
    const quote = await forward(middle);
    if (!quote) return null;
    if (quote.expected >= opts.targetOut) high = middle;
    else low = middle;
  }
  // The executable path spends a buffered input. This is a display estimate only.
  const amountIn = Math.ceil(high * 1e7) / 1e7;
  const finalQuote = await forward(amountIn);
  return finalQuote ? { amountIn, expectedOut: finalQuote.expected } : null;
}

/**
 * Price-impact bands. Same formula and thresholds as MCP `vanna_swap`
 * (`SWAP_IMPACT_WARN_PCT` / `SWAP_IMPACT_CONFIRM_PCT`):
 * impact = (in_usd − out_usd) / in_usd against oracle prices.
 */
export const SWAP_IMPACT_WARN_PCT = 2;
export const SWAP_IMPACT_CONFIRM_PCT = 10;

export type SwapImpactLevel = "low" | "warn" | "high" | "unknown";

export type SwapPriceImpact = {
  pct: number | null;
  level: SwapImpactLevel;
  warning: string | null;
};

/**
 * How far a quoted fill sits below oracle fair value.
 *
 * An unreadable price is `unknown`, never 0% — "no warning" and "no data"
 * must not look alike. MCP withholds auto-sign at `high` (≥ 10%) unless the
 * caller sets `acknowledged_price_impact` after a human was shown this figure.
 */
export function swapPriceImpact(opts: {
  amountIn: number;
  expectedOut: number;
  tokenIn: string;
  tokenOut: string;
  priceInUsd: number | null;
  priceOutUsd: number | null;
}): SwapPriceImpact {
  const { amountIn, expectedOut, tokenIn, tokenOut, priceInUsd, priceOutUsd } = opts;
  if (
    !(amountIn > 0) ||
    !(expectedOut > 0) ||
    priceInUsd == null ||
    priceOutUsd == null ||
    !(priceInUsd > 0) ||
    !(priceOutUsd > 0)
  ) {
    return { pct: null, level: "unknown", warning: null };
  }
  const inUsd = amountIn * priceInUsd;
  const outUsd = expectedOut * priceOutUsd;
  if (!(inUsd > 0)) return { pct: null, level: "unknown", warning: null };
  const pct = ((inUsd - outUsd) / inUsd) * 100;
  const level: SwapImpactLevel =
    pct >= SWAP_IMPACT_CONFIRM_PCT ? "high" : pct >= SWAP_IMPACT_WARN_PCT ? "warn" : "low";
  const quantized = Math.round(pct * 100) / 100;
  if (level === "low") return { pct: quantized, level, warning: null };
  return {
    pct: quantized,
    level,
    warning:
      `This pool pays about ${quantized}% below oracle fair value: ${amountIn} ${tokenIn} ` +
      `is worth ~$${inUsd.toFixed(2)}, and this fill returns ~$${outUsd.toFixed(2)} of ${tokenOut}.`,
  };
}

/** Read a USD price out of `vanna_get_prices_batch`, including USDC-family aliases. */
export function usdPriceFromOracleBatch(
  batch: Record<string, unknown> | null | undefined,
  symbol: string,
): number | null {
  if (!batch) return null;
  const prices = (batch.prices || batch) as Record<string, { price_usd?: string | number }>;
  const u = symbol.toUpperCase();
  const aliases = u === "AQUSDC" || u === "SOUSDC" || u === "BLUSDC" ? [u, "USDC"] : [u];
  for (const key of aliases) {
    const n = Number(prices[key]?.price_usd ?? prices[key.toLowerCase()]?.price_usd);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
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
