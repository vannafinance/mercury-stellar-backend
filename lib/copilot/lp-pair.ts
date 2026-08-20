/**
 * Aquarius / Soroswap LP is always XLM + the venue's USDC, sized at the live
 * reserve ratio — the same rule as the Farm add-liquidity form (one input fills
 * the other; both sides independently is not a valid AMM add).
 *
 * Used by the multi-leg pause ("pick XLM or AQUSDC") and by resume so a number
 * typed against either side becomes a full on-ratio pair.
 */
export function lpStableFor(tokenOrVenue: string | null | undefined): "AQUSDC" | "SOUSDC" {
  const t = String(tokenOrVenue ?? "").toUpperCase();
  if (t.includes("SORO") || t === "SOUSDC") return "SOUSDC";
  return "AQUSDC";
}

export function lpSides(
  asset?: string | null,
  tokenB?: string | null,
  venue?: string | null,
): ["XLM", "AQUSDC" | "SOUSDC"] {
  return ["XLM", lpStableFor(tokenB || asset || venue)];
}

/** `otherPerXlm` = reserve(other) / reserve(XLM), same as Farm's "1 XLM ≈ N AQUSDC". */
export function pairedFromSelected(
  selected: string,
  amount: number,
  otherPerXlm: number,
): { xlm: number; other: number } {
  if (!(amount > 0) || !(otherPerXlm > 0)) {
    return { xlm: 0, other: 0 };
  }
  if (selected.toUpperCase() === "XLM") {
    return { xlm: amount, other: amount * otherPerXlm };
  }
  return { xlm: amount / otherPerXlm, other: amount };
}

export type LpFill = {
  asset: string;
  amount: number;
  token_a?: string | null;
  token_b?: string | null;
  venue?: string | null;
};

/** Stamp an unsized add_liquidity write with the side the user picked on the plan card. */
export function applyLpFillToSteps<
  T extends {
    op?: string;
    asset?: string | null;
    amount?: number | null;
    args?: Record<string, unknown>;
  },
>(steps: T[], fill: LpFill): T[] {
  if (!(fill.amount > 0)) return steps;
  return steps.map((s) => {
    if (s.op !== "add_liquidity") return s;
    const sides = lpSides(
      fill.asset,
      fill.token_b || (typeof s.args?.token_b === "string" ? s.args.token_b : null),
      fill.venue || (typeof s.args?.venue === "string" ? s.args.venue : null),
    );
    const selected = fill.asset.toUpperCase() === "XLM" ? "XLM" : sides[1];
    const amount_a = selected === "XLM" ? fill.amount : null;
    const amount_b = selected !== "XLM" ? fill.amount : null;
    return {
      ...s,
      asset: selected,
      amount: fill.amount,
      args: {
        ...(s.args || {}),
        token_a: sides[0],
        token_b: sides[1],
        amount: fill.amount,
        amount_a,
        amount_b,
        asset: selected,
      },
    };
  });
}

/** Live AMM ratio: other-per-XLM. Null if the pool cannot be read. */
export async function readAmmOtherPerXlm(other: string): Promise<number | null> {
  try {
    if (other.toUpperCase() === "SOUSDC") {
      const { SoroswapService } = await import("@/lib/soroswap-utils");
      const stats = await SoroswapService.getPoolStats();
      const xlm = stats ? Number.parseFloat(stats.reserveXLM) : NaN;
      const usd = stats ? Number.parseFloat(stats.reserveUSDC) : NaN;
      if (xlm > 0 && usd > 0) return usd / xlm;
      return null;
    }
    const [{ AquariusService, AQUARIUS_POOLS }, { CONTRACT_ADDRESSES }] = await Promise.all([
      import("@/lib/aquarius-utils"),
      import("@/lib/stellar-utils"),
    ]);
    const poolAddress =
      AQUARIUS_POOLS.find((p) => p.id === "aquarius-xlm-usdc")?.poolAddress ??
      CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL;
    const stats = poolAddress ? await AquariusService.getAquariusPoolStats(poolAddress) : null;
    const xlm = stats ? Number.parseFloat(stats.reserveA) : NaN;
    const usd = stats ? Number.parseFloat(stats.reserveB) : NaN;
    if (xlm > 0 && usd > 0) return usd / xlm;
    return null;
  } catch {
    return null;
  }
}
