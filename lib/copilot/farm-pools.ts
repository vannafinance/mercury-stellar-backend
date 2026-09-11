/**
 * Vanna's farmable Aquarius pairs. Must mirror `AQUARIUS_POOLS` in
 * lib/aquarius-utils.ts, which is the source of truth — it carries the actual
 * pool contract addresses the app transacts against.
 *
 * XLM/AQUA is deliberately absent: the protocol has no XLM/AQUA pool (confirmed
 * by the contracts owner, and `AQUARIUS_POOLS` holds only XLM/USDC and XLM/USDT).
 * It was previously listed here from the test-prompt doc, and because the filter
 * below matches against Aquarius's *whole* public API dump, an unrelated AQUA pool
 * satisfied the pair and got presented as farmable — with blank APY and liquidity,
 * since Vanna has no position or address for it.
 */
export const VANNA_AQUARIUS_FARM_PAIRS: Array<{ pair: string; a: string; b: string }> = [
  { pair: "XLM/USDC", a: "XLM", b: "USDC" },
  { pair: "XLM/USDT", a: "XLM", b: "USDT" },
];

function normalizeTokenLabel(t: string): string {
  const u = t.toUpperCase().replace(/^MOCK\s+/, "").trim();
  if (u === "NATIVE" || u === "XLM") return "XLM";
  if (u.includes("AQUA") && !u.includes("USDC")) return "AQUA";
  if (u.includes("USDT") || u === "MOCK USDT") return "USDT";
  if (u.includes("USDC") || u === "TUSDC") return "USDC";
  return u.split(/[:\s]/)[0] || u;
}

function tokensMatchPair(tokens: string[], a: string, b: string): boolean {
  const set = new Set(tokens.map(normalizeTokenLabel));
  return set.has(a) && set.has(b);
}

/**
 * Filter MCP Aquarius API dump down to the 3 Vanna-farmable pairs (PDF F9).
 * When multiple API pools share a pair, keep the highest total APY.
 */
export function filterAquariusFarmPools(raw: Record<string, unknown>): {
  pools: Array<Record<string, unknown>>;
} {
  const list = Array.isArray(raw.pools) ? (raw.pools as Record<string, unknown>[]) : [];
  const out: Array<Record<string, unknown>> = [];
  for (const want of VANNA_AQUARIUS_FARM_PAIRS) {
    const candidates = list.filter((p) => {
      const tokens = Array.isArray(p.tokens)
        ? (p.tokens as unknown[]).map((t) => String(t))
        : Array.isArray(p.tokens_raw)
          ? (p.tokens_raw as unknown[]).map((t) => String(t).split(":")[0])
          : [];
      return tokensMatchPair(tokens, want.a, want.b);
    });
    candidates.sort(
      (x, y) =>
        Number(y.total_apy_pct ?? y.apy_pct ?? 0) - Number(x.total_apy_pct ?? x.apy_pct ?? 0),
    );
    const best = candidates[0];
    if (best) {
      out.push({
        pair: want.pair,
        token_a: want.a,
        token_b: want.b,
        total_apy_pct: best.total_apy_pct ?? best.apy_pct ?? null,
        apy_pct: best.apy_pct ?? null,
        liquidity_usd: best.liquidity_usd ?? null,
        pool_address: best.pool_address ?? null,
        fee: best.fee ?? null,
        pool_type: best.pool_type ?? null,
      });
    } else {
      out.push({
        pair: want.pair,
        token_a: want.a,
        token_b: want.b,
        total_apy_pct: null,
        note: "No live API match for this pair on testnet right now.",
      });
    }
  }
  return { pools: out };
}
