/**
 * Blend / Aquarius / Soroswap positions are tracked via the Registry tracking-token
 * contract. The smart account lists those symbols in CollateralTokensList but often
 * keeps CollateralBalanceWAD at 0 — Farm UIs read tracking balances instead.
 * Analytics merges the same farm-style reads so Margin Breakdown aToken / LP buckets match Farm.
 */

import { BlendService } from "@/lib/blend-utils";
import { AquariusService } from "@/lib/aquarius-utils";
import { SoroswapService } from "@/lib/soroswap-utils";
import { fetchTokenPrice } from "@/lib/oracle-price";

const DUST = 1e-8;

/** USD-valued rows for margin store (`getCollateralBalances` / refreshBorrowedBalances). */
export async function mergeFarmTrackingCollateralIntoBalances(
  marginAccountAddress: string,
  balances: Record<string, { amount: string; usdValue: string }>,
): Promise<Record<string, { amount: string; usdValue: string }>> {
  const out: Record<string, { amount: string; usdValue: string }> = { ...balances };

  try {
    const blend = await BlendService.getAllUserBlendPositions(marginAccountAddress);
    for (const sym of ["XLM", "USDC"] as const) {
      const pos = blend[sym];
      const underlying = parseFloat(pos?.underlyingValue ?? "0");
      if (underlying <= DUST) continue;
      const trackSym = sym === "XLM" ? "BLEND_XLM" : "BLEND_USDC";
      const price = await fetchTokenPrice(sym);
      out[trackSym] = {
        amount: underlying.toFixed(7),
        usdValue: (underlying * price).toFixed(2),
      };
    }
  } catch (e) {
    console.warn("[farmTrackingCollateral] Blend enrichment failed:", e);
  }

  try {
    const aq = parseFloat(await AquariusService.getLpBalance(marginAccountAddress, "XLM", "USDC"));
    if (aq > DUST) {
      const price = await fetchTokenPrice("AQ_XLM_USDC");
      out.AQ_XLM_USDC = {
        amount: aq.toFixed(7),
        usdValue: (aq * price).toFixed(2),
      };
    }
  } catch (e) {
    console.warn("[farmTrackingCollateral] Aquarius enrichment failed:", e);
  }

  try {
    const ss = parseFloat(await SoroswapService.getLpBalance(marginAccountAddress));
    if (ss > DUST) {
      const price = await fetchTokenPrice("SS_XLM_USDC");
      out.SS_XLM_USDC = {
        amount: ss.toFixed(7),
        usdValue: (ss * price).toFixed(2),
      };
    }
  } catch (e) {
    console.warn("[farmTrackingCollateral] Soroswap enrichment failed:", e);
  }

  return out;
}

/** Human amounts for protocol-wide snapshot builder (`allMarginAccounts`). */
export async function fetchFarmTrackingCollateralAmountMap(
  marginAccountAddress: string,
): Promise<Map<string, number>> {
  const m = new Map<string, number>();

  try {
    const blend = await BlendService.getAllUserBlendPositions(marginAccountAddress);
    for (const sym of ["XLM", "USDC"] as const) {
      const underlying = parseFloat(blend[sym]?.underlyingValue ?? "0");
      if (underlying <= DUST) continue;
      m.set(sym === "XLM" ? "BLEND_XLM" : "BLEND_USDC", underlying);
    }
  } catch (e) {
    console.warn("[farmTrackingCollateral] Blend map failed:", e);
  }

  try {
    const aq = parseFloat(await AquariusService.getLpBalance(marginAccountAddress, "XLM", "USDC"));
    if (aq > DUST) m.set("AQ_XLM_USDC", aq);
  } catch (e) {
    console.warn("[farmTrackingCollateral] Aquarius map failed:", e);
  }

  try {
    const ss = parseFloat(await SoroswapService.getLpBalance(marginAccountAddress));
    if (ss > DUST) m.set("SS_XLM_USDC", ss);
  } catch (e) {
    console.warn("[farmTrackingCollateral] Soroswap map failed:", e);
  }

  return m;
}
