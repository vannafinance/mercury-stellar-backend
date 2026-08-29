/**
 * Blend / Aquarius / Soroswap positions are tracked via the Registry tracking-token
 * contract. The smart account lists those symbols in CollateralTokensList but often
 * keeps CollateralBalanceWAD at 0 — Farm UIs read tracking balances instead.
 * Analytics merges the same farm-style reads so Margin Breakdown aToken / LP buckets match Farm.
 */

import { BlendService } from "@/lib/blend-utils";
import {
  AquariusService,
  AQUARIUS_POOLS,
  aquariusLpUnderlyingAmounts,
} from "@/lib/aquarius-utils";
import { SoroswapService } from "@/lib/soroswap-utils";
import { fetchTokenPrice } from "@/lib/oracle-price";

const DUST = 1e-8;

/** Raw Stellar assets held by the margin smart account (not tracking tokens).
 *  AQUSDC/SOUSDC are included alongside XLM/USDC because their on-chain
 *  collateral ledger has the exact same staleness problem: depositing AQUSDC
 *  then deploying it into an Aquarius LP (e.g. via the Lite one-click flow)
 *  never updates CollateralBalanceWAD, so without this raw-balance overlay
 *  the ledger keeps reporting the original deposit as still-free collateral
 *  long after it's actually sitting in the LP — surfacing as phantom
 *  "Collateral Deposited: AQUSDC" once same-token debt drops below it. */
const MARGIN_SAC_TOKENS = [
  { sac: "XLM" as const, balanceKey: "XLM" },
  { sac: "USDC" as const, balanceKey: "BLUSDC" },
  { sac: "AQUSDC" as const, balanceKey: "AQUSDC" },
  { sac: "SOUSDC" as const, balanceKey: "SOUSDC" },
];

/** balanceKeys `reconcileMarginRawSacCollateral` already owns — callers that
 *  re-derive their own collateral total from the same `collateralBalances`
 *  object must exclude every one of these, not just XLM/BLUSDC, or a token
 *  reconciled here gets summed a second time as if it were separate
 *  collateral (it previously didn't, causing AQUSDC/SOUSDC to double-count
 *  into gross collateral value and mask an unhealthy account's real HF). */
export const MARGIN_SAC_BALANCE_KEYS: readonly string[] = MARGIN_SAC_TOKENS.map(
  (t) => t.balanceKey,
);

/**
 * Read live XLM/USDC SAC balances on the margin account and overlay them onto
 * `collateralBalances`. The on-chain collateral ledger (CollateralBalanceWAD)
 * does not update when the user swaps via Aquarius/Soroswap — only raw balances
 * reflect the post-swap portfolio, so HF must use these for display.
 */
export async function reconcileMarginRawSacCollateral(
  marginAccountAddress: string,
  balances: Record<string, { amount: string; usdValue: string }>,
  priceForToken: (token: string) => number,
  borrowedBalances?: Record<string, { amount: string; usdValue: string }>,
): Promise<number> {
  let rawUsdTotal = 0;
  try {
    const amounts = await Promise.all(
      MARGIN_SAC_TOKENS.map(({ sac }) =>
        BlendService.getMarginAccountTokenBalance(marginAccountAddress, sac),
      ),
    );
    MARGIN_SAC_TOKENS.forEach(({ balanceKey }, i) => {
      const rawAmount = parseFloat(amounts[i]) || 0;
      const borrowedAmount = borrowedBalances?.[balanceKey]
        ? parseFloat(borrowedBalances[balanceKey]!.amount) || 0
        : 0;
      // The SAC balance is the total token balance held by the smart account. When
      // borrowed cash is still sitting there, it is included in that number but is
      // not additional collateral. Keep the old raw overlay for callers that do not
      // have debt available, while the margin snapshot passes its authoritative debt
      // map and anchors collateral on the net amount.
      const amount = Math.max(0, rawAmount - borrowedAmount);
      const price = priceForToken(balanceKey);
      const usd = amount * price;
      rawUsdTotal += usd;
      balances[balanceKey] = {
        amount: amount.toFixed(7),
        usdValue: usd.toFixed(2),
      };
    });
  } catch (e) {
    console.warn("[farmTrackingCollateral] raw SAC reconcile failed:", e);
  }
  return rawUsdTotal;
}

export function sumCollateralBalancesUsd(
  balances: Record<string, { amount: string; usdValue: string }>,
): number {
  return Object.values(balances).reduce(
    (sum, b) => sum + (parseFloat(b.usdValue) || 0),
    0,
  );
}

/**
 * LP share USD = pro-rata pool reserves priced at XLM/USDC oracle (same as Farm UI).
 * Do not use the LP receipt oracle stub ($0.4/share) — that collapses HF after add-liquidity.
 */
async function resolvePrice(
  sym: string,
  priceForToken?: (token: string) => number,
): Promise<number> {
  if (priceForToken) {
    const cached = priceForToken(sym);
    if (cached > 0) return cached;
  }
  try {
    return await fetchTokenPrice(sym);
  } catch {
    return 0;
  }
}

async function soroswapLpCollateralRow(
  marginAccountAddress: string,
  priceForToken?: (token: string) => number,
): Promise<{ amount: string; usdValue: string } | null> {
  const lp = parseFloat(await SoroswapService.getLpBalance(marginAccountAddress));
  if (!(lp > DUST)) return null;

  const stats = await SoroswapService.getPoolStats();
  const totalShares = parseFloat(stats?.totalShares ?? "0");
  if (!(totalShares > DUST) || !stats) return null;

  const ratio = lp / totalShares;
  const xlm = ratio * parseFloat(stats.reserveXLM ?? "0");
  const usdc = ratio * parseFloat(stats.reserveUSDC ?? "0");
  const [xlmPx, usdcPx] = await Promise.all([
    resolvePrice("XLM", priceForToken),
    resolvePrice("USDC", priceForToken),
  ]);
  const usd = xlm * xlmPx + usdc * usdcPx;

  return {
    amount: lp.toFixed(7),
    usdValue: usd.toFixed(2),
  };
}

async function aquariusLpCollateralRow(
  marginAccountAddress: string,
  tokenA: string,
  tokenB: string,
  poolAddress: string,
  priceForToken?: (token: string) => number,
): Promise<{ amount: string; usdValue: string } | null> {
  // `getLpBalance` only reads the Registry's tracking-token balance, which goes stale
  // the same way other tracked positions here do. `getUserLpBalance` falls back to the
  // pool contract's own `get_user_shares()` when the tracking token reads zero/stale —
  // the same fallback-capable read the Farm page's own Positions tab and this file's
  // sibling `farmPositionAnswer` (lib/copilot/handle.ts) already use, which is why a
  // real Aquarius LP position showed there but never here.
  const lp = parseFloat(
    await AquariusService.getUserLpBalance(marginAccountAddress, poolAddress, tokenA, tokenB),
  );
  if (!(lp > DUST)) return null;

  const stats = await AquariusService.getAquariusPoolStats(poolAddress);
  const totalShares = parseFloat(stats?.totalShares ?? "0");
  if (!(totalShares > DUST) || !stats) return null;

  const { amountA: amtA, amountB: amtB } = aquariusLpUnderlyingAmounts(
    lp,
    stats,
    tokenA,
    tokenB,
  );
  const [pxA, pxB] = await Promise.all([
    resolvePrice(tokenA, priceForToken),
    resolvePrice(tokenB, priceForToken),
  ]);
  const usd = amtA * pxA + amtB * pxB;

  return {
    amount: lp.toFixed(7),
    usdValue: usd.toFixed(2),
  };
}

/** USD-valued rows for margin store (`getCollateralBalances` / refreshBorrowedBalances). */
export async function mergeFarmTrackingCollateralIntoBalances(
  marginAccountAddress: string,
  balances: Record<string, { amount: string; usdValue: string }>,
  priceForToken?: (token: string) => number,
): Promise<Record<string, { amount: string; usdValue: string }>> {
  const out: Record<string, { amount: string; usdValue: string }> = { ...balances };

  // The three protocol reads are independent and write disjoint keys
  // (BLEND_* / AQ_* / SS_*), so run them concurrently instead of serially.
  await Promise.all([
    (async () => {
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
    })(),
    (async () => {
      try {
        const xlmUsdcPool = AQUARIUS_POOLS.find((p) => p.id === "aquarius-xlm-usdc");
        if (xlmUsdcPool) {
          const row = await aquariusLpCollateralRow(
            marginAccountAddress,
            xlmUsdcPool.tokens[0],
            xlmUsdcPool.tokens[1],
            xlmUsdcPool.poolAddress,
            priceForToken,
          );
          if (row) out.AQ_XLM_USDC = row;
        }
      } catch (e) {
        console.warn("[farmTrackingCollateral] Aquarius enrichment failed:", e);
      }
    })(),
    (async () => {
      try {
        const row = await soroswapLpCollateralRow(marginAccountAddress, priceForToken);
        if (row) out.SS_XLM_USDC = row;
      } catch (e) {
        console.warn("[farmTrackingCollateral] Soroswap enrichment failed:", e);
      }
    })(),
  ]);

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
