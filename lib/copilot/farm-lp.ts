/**
 * Live AMM LP share count — the same read Farm's LP page uses.
 *
 * Farm Aquarius shows `AquariusService.getUserLpBalance` (pool `get_user_shares`
 * when the Registry tracking token is empty). MCP `vanna_farm_lp` looks up
 * `AQ_XLM_USDC` and reports no position / no-ops a remove even when Farm shows
 * 12.64 LP. Copilot must size and execute against this number, not MCP's tracker.
 */
export async function readFarmAmmLpShares(opts: {
  smartAccount: string;
  tokenB?: string | null;
  venue?: string | null;
}): Promise<{ shares: number; venue: "aquarius" | "soroswap"; label: string }> {
  const b = String(opts.tokenB || "").toUpperCase();
  const v = String(opts.venue || "").toLowerCase();
  const soroswap = b === "SOUSDC" || v.includes("soro");
  if (soroswap) {
    const { SoroswapService } = await import("@/lib/soroswap-utils");
    const raw = await SoroswapService.getLpBalance(opts.smartAccount);
    const shares = Number.parseFloat(raw) || 0;
    return { shares, venue: "soroswap", label: "XLM/SOUSDC" };
  }
  const [{ AquariusService, AQUARIUS_POOLS }, { CONTRACT_ADDRESSES }] = await Promise.all([
    import("@/lib/aquarius-utils"),
    import("@/lib/stellar-utils"),
  ]);
  const pool =
    AQUARIUS_POOLS.find((p) => p.id === "aquarius-xlm-usdc")?.poolAddress ??
    CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL;
  const raw = pool
    ? await AquariusService.getUserLpBalance(opts.smartAccount, pool, "XLM", "USDC")
    : "0";
  const shares = Number.parseFloat(raw) || 0;
  return { shares, venue: "aquarius", label: "XLM/AQUSDC" };
}
