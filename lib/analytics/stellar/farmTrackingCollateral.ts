/**
 * Venue / LP collateral of a margin account, read straight from the chain.
 *
 * Credit layer (testnet redeploy 2026-11-06): there is no tracking token any
 * more. The margin account holds its LP tokens directly and its Blend supply
 * is a "Venue" asset:
 *   - Soroswap XLM/SOUSDC pair token  → pair.balance(margin)       → SS_XLM_USDC
 *   - Aquarius XLM/BLUSDC share token → share.balance(margin)      → AQ_XLM_USDC
 *   - Blend supply                    → BLEND_VALUER.positions(...) → BLEND_XLM / BLEND_USDC
 * LP rows are priced by the credit-layer oracle (the same price CreditLayer
 * margin_value uses); Blend rows at the underlying token's oracle price.
 *
 * The file name and exports are kept so existing callers (account snapshot,
 * analytics, margin store) keep working.
 */

import { CREDIT_ASSETS, tokenBalance } from "@/lib/credit-layer";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import {
  AQUARIUS_LP_KEY,
  BLEND_KEYS,
  SOROSWAP_LP_KEY,
  blendPositions,
  priceUsd,
} from "@/lib/margin-credit-reads";
import { fetchTokenPrice } from "@/lib/oracle-price";

const DUST = 1e-8;

/** Raw Stellar assets held by the margin account (plain token balances).
 *  `sac` is the credit-asset symbol, `balanceKey` the key the UI renders. */
const MARGIN_SAC_TOKENS = [
  { sac: "XLM" as const, balanceKey: "XLM" },
  { sac: "BLUSDC" as const, balanceKey: "BLUSDC" },
  { sac: "SOUSDC" as const, balanceKey: "SOUSDC" },
];

/** balanceKeys `reconcileMarginRawSacCollateral` already owns — callers that
 *  re-derive their own collateral total from the same `collateralBalances`
 *  object must exclude every one of these, or a reconciled token gets summed a
 *  second time as if it were separate collateral. */
export const MARGIN_SAC_BALANCE_KEYS: readonly string[] = MARGIN_SAC_TOKENS.map(
  (t) => t.balanceKey,
);

const toUnits = (native: bigint): number => Number(native) / 1e7;

/**
 * Read live SAC balances held by the margin account and overlay them onto
 * `collateralBalances`. These are exactly what CreditLayer margin_value counts
 * as token collateral (spendable balance × price).
 *
 * Do NOT net this against debt: borrowed funds land in the margin account and
 * the contract counts them as collateral (health.rs `value`).
 */
export async function reconcileMarginRawSacCollateral(
  marginAccountAddress: string,
  balances: Record<string, { amount: string; usdValue: string }>,
  priceForToken: (token: string) => number,
): Promise<number> {
  let rawUsdTotal = 0;
  try {
    const amounts = await Promise.all(
      MARGIN_SAC_TOKENS.map(({ sac }) => tokenBalance(CREDIT_ASSETS[sac].token, marginAccountAddress)),
    );
    MARGIN_SAC_TOKENS.forEach(({ balanceKey }, i) => {
      const amount = toUnits(amounts[i]);
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

/** LP token held directly by the margin account, valued at the oracle's LP price. */
async function lpCollateralRow(
  marginAccountAddress: string,
  lpToken: string,
): Promise<{ amount: string; usdValue: string } | null> {
  const lp = toUnits(await tokenBalance(lpToken, marginAccountAddress));
  if (!(lp > DUST)) return null;
  const px = await priceUsd(lpToken);
  return { amount: lp.toFixed(7), usdValue: (lp * px).toFixed(2) };
}

/** USD-valued venue rows for the margin store (`getCollateralBalances` / refreshBorrowedBalances). */
export async function mergeFarmTrackingCollateralIntoBalances(
  marginAccountAddress: string,
  balances: Record<string, { amount: string; usdValue: string }>,
  priceForToken?: (token: string) => number,
): Promise<Record<string, { amount: string; usdValue: string }>> {
  const out: Record<string, { amount: string; usdValue: string }> = { ...balances };

  // Independent reads writing disjoint keys (BLEND_* / AQ_* / SS_*).
  await Promise.all([
    (async () => {
      try {
        for (const r of await blendPositions(marginAccountAddress)) {
          if (!(r.owned > DUST)) continue;
          const key = BLEND_KEYS[r.symbol] ?? `BLEND_${r.symbol}`;
          const price = await resolvePrice(r.symbol, priceForToken);
          out[key] = { amount: r.owned.toFixed(7), usdValue: (r.owned * price).toFixed(2) };
        }
      } catch (e) {
        console.warn("[farmTrackingCollateral] Blend enrichment failed:", e);
      }
    })(),
    (async () => {
      try {
        const row = await lpCollateralRow(marginAccountAddress, CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_SHARE);
        if (row) out[AQUARIUS_LP_KEY] = row;
      } catch (e) {
        console.warn("[farmTrackingCollateral] Aquarius enrichment failed:", e);
      }
    })(),
    (async () => {
      try {
        const row = await lpCollateralRow(marginAccountAddress, CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL);
        if (row) out[SOROSWAP_LP_KEY] = row;
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
    for (const r of await blendPositions(marginAccountAddress)) {
      if (r.owned > DUST) m.set(BLEND_KEYS[r.symbol] ?? `BLEND_${r.symbol}`, r.owned);
    }
  } catch (e) {
    console.warn("[farmTrackingCollateral] Blend map failed:", e);
  }

  const lps: [string, string][] = [
    [AQUARIUS_LP_KEY, CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_SHARE],
    [SOROSWAP_LP_KEY, CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL],
  ];
  await Promise.all(
    lps.map(async ([key, token]) => {
      try {
        const v = toUnits(await tokenBalance(token, marginAccountAddress));
        if (v > DUST) m.set(key, v);
      } catch (e) {
        console.warn(`[farmTrackingCollateral] ${key} map failed:`, e);
      }
    }),
  );

  return m;
}
