// Single source of truth for a margin account's derived stats (HF, collateral,
// borrowed, net-available, borrow rate). Pure + server-safe — no Zustand, no
// browser APIs — so it powers BOTH the cached /api/account/[addr] route and the
// client store (refreshBorrowedBalances), keeping the HF math in one place.
//
// Parallelization (D25, audit item 1): the borrow-rate pool-stats fetch is
// INDEPENDENT of collateral, so it runs concurrently with the farm→SAC chain
// instead of after it. farm-merge and SAC-reconcile stay ordered because they
// both mutate the shared collateralBalances object.

import { MarginAccountService } from "@/lib/margin-utils";
import { fetchTokenPrices, getCachedTokenPrice } from "@/lib/oracle-price";
import { ContractService, ASSET_TYPES, type AssetType } from "@/lib/stellar-utils";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";
import {
  mergeFarmTrackingCollateralIntoBalances,
  reconcileMarginRawSacCollateral,
  sumCollateralBalancesUsd,
  MARGIN_SAC_BALANCE_KEYS,
} from "@/lib/analytics/stellar/farmTrackingCollateral";
import { deriveMarginHealth } from "@/lib/margin-health";
import { ACTIVE_ASSETS } from "@/lib/analytics/stellar/canon";

// "USDC" is the canonical peg the three USDC-flavoured collateral variants
// (BLUSDC/AQUSDC/SOUSDC, already in ACTIVE_ASSETS) resolve to on-chain — kept
// as its own priced symbol since Reflector exposes it as a real feed.
const PRICEABLE_TOKENS = ["USDC", ...ACTIVE_ASSETS] as const;
export const USD_DUST_EPSILON = 0.01;

const tokenPrice = (token: string): number => getCachedTokenPrice(token);

// Hard deadline on the whole snapshot computation. Without this, one hung
// Soroban RPC call (soroban-testnet.stellar.org ECONNRESET retries have been
// measured taking 90s+) blocks every caller sharing `snapshotInflight` below —
// /api/account/[addr] and Copilot's own account-position read among them — with
// no way to abort. This does not cancel the underlying RPC calls (no
// AbortController is threaded through Stellar SDK's rpc.Server here); it only
// bounds how long ANY caller waits, and — critically — makes the shared inflight
// promise REJECT so the entry is cleared (see the `finally` below) instead of
// leaving the next caller to join the same hung promise.
const SNAPSHOT_HARD_TIMEOUT_MS = 12_000;

/** Firing at 12s is correct. Callers that handle this must not log it at error level. */
export class SnapshotTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "SnapshotTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SnapshotTimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const canonicalMarginToken = (token: string): string => {
  const n = token.toUpperCase();
  if (n === "BLEND_USDC" || n === "USDC") return "BLUSDC";
  if (n === "AQUIRESUSDC" || n === "AQUARIUS_USDC") return "AQUSDC";
  if (n === "SOROSWAPUSDC" || n === "SOROSWAP_USDC") return "SOUSDC";
  return n;
};

const debtSymbolToAssetType = (symbol: string): AssetType | null => {
  switch (symbol.toUpperCase()) {
    case "XLM": return ASSET_TYPES.XLM;
    case "BLUSDC": return ASSET_TYPES.USDC;
    case "AQUSDC": return ASSET_TYPES.AQUARIUS_USDC;
    case "SOUSDC": return ASSET_TYPES.SOROSWAP_USDC;
    default: return null;
  }
};

/**
 * Is this balance key a farm TRACKING position rather than a plain token holding?
 *
 * `BLEND_XLM` is XLM supplied into Blend; `AQ_XLM_USDC` is an Aquarius LP receipt.
 * Both are denominated in an underlying the user can name, and neither is that
 * underlying sitting as collateral. Exported because the copilot answers "how much XLM
 * collateral do I have" off these same balances and must draw the line in the same
 * place the margin page does — a second copy of this rule is how the two surfaces come
 * to disagree about one account.
 */
export const isTrackingSymbol = (sym: string): boolean => {
  const u = sym.toUpperCase();
  return (
    u.startsWith("BLEND_") || u.startsWith("AQ_") || u.startsWith("SS_") ||
    u.endsWith("_LP") || u.includes("AQUARIUS") || u.includes("SOROSWAP")
  );
};

type Balance = { amount: string; usdValue: string };
type Balances = Record<string, Balance>;

/**
 * Full derived view of a margin account: per-token borrowed/collateral balances
 * plus the rolled-up USD totals and health figures (HF, debt limit, net
 * available) from {@link deriveMarginHealth}. `grossCollateralValue` is the
 * risk-weighted collateral the HF math uses; `totalCollateralValue` is the raw
 * sum. USD fields are JS numbers; the per-balance `usdValue` strings are pre-formatted.
 */
export type MarginSnapshot = {
  borrowedBalances: Balances;
  collateralBalances: Balances;
  totalBorrowedValue: number;
  totalCollateralValue: number;
  grossCollateralValue: number;
  totalValue: number;
  avgHealthFactor: number;
  collateralLeftBeforeLiquidation: number;
  netAvailableCollateral: number;
  borrowRate: number;
  debtLimit: number;
  /** true when one or more debt legs failed to read even after retry — every
   *  figure derived from `totalBorrowedValue` (HF, net available, etc.) may
   *  be UNDERSTATING real debt. UI should treat this account's risk figures
   *  as unverified rather than silently trusting them. */
  debtDataIncomplete: boolean;
};

// Multiple mounted surfaces can request the same account snapshot at once
// (Copilot, the right rail, Margin, and Portfolio). Share the active read by
// address so those surfaces do not launch overlapping Soroban scans. This is
// in-flight deduplication only; completed snapshots are not retained here, so
// mutation-driven refreshes still get fresh chain data.
const snapshotInflight = new Map<string, Promise<MarginSnapshot>>();

/**
 * Early slice of a {@link MarginSnapshot} emitted via `onPartial` once the fast
 * debt/collateral totals are known, before the heavier farm/SAC/rate reads —
 * lets the client render progressively. Carries a PROVISIONAL health set
 * derived from the raw collateral total so the health factor can never lag the
 * debt it's emitting (otherwise the store shows fresh debt next to a stale ∞).
 * The full snapshot refines these once gross collateral (SAC/farm) is known.
 */
export type PartialSnapshot = Pick<
  MarginSnapshot,
  | "borrowedBalances"
  | "collateralBalances"
  | "totalBorrowedValue"
  | "avgHealthFactor"
  | "grossCollateralValue"
  | "netAvailableCollateral"
  | "collateralLeftBeforeLiquidation"
>;

/** Borrow rate for the largest debt asset (independent of collateral reads). */
async function fetchBorrowRate(borrowedBalances: Balances, effectiveDebtValue: number): Promise<number> {
  if (effectiveDebtValue <= 0) return 0;
  const primaryDebtSymbol = Object.entries(borrowedBalances)
    .map(([symbol, b]) => ({ symbol, usd: parseFloat(b.usdValue) || 0 }))
    .sort((a, b) => b.usd - a.usd)[0]?.symbol;
  const assetType = primaryDebtSymbol ? debtSymbolToAssetType(primaryDebtSymbol) : null;
  if (!assetType) return 0;
  try {
    const stats = await ContractService.getPoolStats(assetType);
    return parseFloat(computeBorrowApr(parseFloat(stats.utilizationRate) || 0).toFixed(2));
  } catch (e) {
    console.warn("[account-snapshot] borrow rate fetch failed:", e);
    return 0;
  }
}

/**
 * Compute a margin account's full derived snapshot. `onPartial` (optional) fires
 * once the fast debt/collateral totals are known, before the heavier farm/SAC/
 * rate work — the client store uses it for progressive render; the route ignores it.
 */
export async function computeMarginSnapshot(
  marginAccountAddress: string,
  opts?: { onPartial?: (p: PartialSnapshot) => void },
): Promise<MarginSnapshot> {
  const label = `computeMarginSnapshot(${marginAccountAddress})`;
  // Progressive callers need their own onPartial callback. The route and
  // Copilot all use the no-callback form and can safely share one read.
  if (opts?.onPartial) {
    return withTimeout(computeMarginSnapshotUncached(marginAccountAddress, opts), SNAPSHOT_HARD_TIMEOUT_MS, label);
  }
  const existing = snapshotInflight.get(marginAccountAddress);
  if (existing) return existing;
  const run = withTimeout(computeMarginSnapshotUncached(marginAccountAddress), SNAPSHOT_HARD_TIMEOUT_MS, label);
  snapshotInflight.set(marginAccountAddress, run);
  try {
    return await run;
  } finally {
    if (snapshotInflight.get(marginAccountAddress) === run) {
      snapshotInflight.delete(marginAccountAddress);
    }
  }
}

async function computeMarginSnapshotUncached(
  marginAccountAddress: string,
  opts?: { onPartial?: (p: PartialSnapshot) => void },
): Promise<MarginSnapshot> {
  const [borrowedResult, collateralResult] = await Promise.all([
    MarginAccountService.getCurrentBorrowedBalances(marginAccountAddress, { includePrices: false }),
    MarginAccountService.getCollateralBalances(marginAccountAddress, {
      includeFarm: false,
      includePrices: false,
    }),
    fetchTokenPrices([...PRICEABLE_TOKENS]),
  ]);

  let totalBorrowedValue = 0;
  let totalCollateralValue = 0;
  const borrowedBalances: Balances = {};
  const collateralBalances: Balances = {};

  // A `partial` result still carries whatever debt legs WERE read
  // successfully — use them (never worse than before), but the account's
  // real debt may be higher than what's shown here; `debtDataIncomplete`
  // (set below) carries that uncertainty through to the caller.
  const debtDataIncomplete = borrowedResult.partial === true;
  if (borrowedResult.data) {
    const deduped: Record<string, Balance> = {};
    Object.entries(borrowedResult.data).forEach(([token, { amount, usdValue }]) => {
      const canonical = canonicalMarginToken(token);
      const current = deduped[canonical];
      if (!current || parseFloat(amount) > parseFloat(current.amount)) deduped[canonical] = { amount, usdValue };
    });
    Object.entries(deduped).forEach(([token, { amount }]) => {
      const usd = parseFloat(amount) * tokenPrice(token);
      totalBorrowedValue += usd;
      borrowedBalances[token] = { amount, usdValue: usd.toFixed(2) };
    });
  }

  if (collateralResult.success && collateralResult.data) {
    const deduped: Record<string, string> = {};
    Object.entries(collateralResult.data).forEach(([token, { amount }]) => {
      const canonical = canonicalMarginToken(token);
      const current = deduped[canonical];
      if (!current || parseFloat(amount) > parseFloat(current)) deduped[canonical] = amount;
    });
    Object.entries(deduped).forEach(([token, amount]) => {
      const usd = parseFloat(amount) * tokenPrice(token);
      totalCollateralValue += usd;
      collateralBalances[token] = { amount, usdValue: usd.toFixed(2) };
    });
  }

  const effectiveDebtValue = totalBorrowedValue > USD_DUST_EPSILON ? totalBorrowedValue : 0;

  // Provisional health from the raw collateral total (gross is refined below by
  // the SAC/farm reads). Emitting it alongside the debt keeps the health factor
  // coherent with the debt at every render — never a stale ∞ over fresh debt.
  const provisional = deriveMarginHealth({
    grossCollateralValue: totalCollateralValue,
    effectiveDebtValue,
    totalBorrowedValue,
  });

  opts?.onPartial?.({
    borrowedBalances: { ...borrowedBalances },
    collateralBalances: { ...collateralBalances },
    totalBorrowedValue,
    avgHealthFactor: provisional.avgHealthFactor,
    grossCollateralValue: totalCollateralValue,
    netAvailableCollateral: provisional.netAvailableCollateral,
    collateralLeftBeforeLiquidation: provisional.collateralLeftBeforeLiquidation,
  });

  // All three remaining reads are independent — run them concurrently:
  //  • borrow rate  (uses borrowedBalances only)
  //  • farm enrichment (writes BLEND_/AQ_/SS_ tracking keys)
  //  • SAC reconcile   (writes XLM/BLUSDC raw balances)
  // farm and SAC touch disjoint keys, so concurrent writes don't collide.
  const [borrowRate, enriched, rawAssetValue] = await Promise.all([
    fetchBorrowRate(borrowedBalances, effectiveDebtValue),
    mergeFarmTrackingCollateralIntoBalances(marginAccountAddress, collateralBalances, tokenPrice).catch(
      (e): Record<string, { amount: string; usdValue: string }> => {
        console.warn("[account-snapshot] farm tracking enrichment failed:", e);
        return {};
      },
    ),
    reconcileMarginRawSacCollateral(
      marginAccountAddress,
      collateralBalances,
      tokenPrice,
    ).catch((e) => {
      console.warn("[account-snapshot] raw SAC reconcile failed:", e);
      return 0;
    }),
  ]);

  // Apply farm tracking keys only — every MARGIN_SAC_BALANCE_KEYS entry is
  // owned by the SAC reconcile above, not just XLM/BLUSDC.
  for (const [sym, val] of Object.entries(enriched)) {
    if (MARGIN_SAC_BALANCE_KEYS.includes(sym)) continue;
    const existingUsd = parseFloat(collateralBalances[sym]?.usdValue ?? "0");
    const newUsd = parseFloat(val.usdValue);
    if (newUsd > existingUsd) collateralBalances[sym] = val;
  }
  totalCollateralValue = sumCollateralBalancesUsd(collateralBalances);

  const farmPositionValue = Object.entries(collateralBalances)
    .filter(([sym]) => isTrackingSymbol(sym))
    .reduce((sum, [, bal]) => sum + parseFloat(bal.usdValue), 0);

  // Excludes every SAC-reconciled key (not just XLM/BLUSDC) so AQUSDC/SOUSDC
  // — already summed into rawAssetValue above — aren't counted a second
  // time here. The prior XLM/BLUSDC-only exclusion let a margin account's
  // own AQUSDC/SOUSDC balance (including freshly-borrowed debt sitting in
  // the account) get double-counted as collateral, artificially propping up
  // the displayed Net Health Factor as more was borrowed.
  const nonSacCollateralValue = Object.entries(collateralBalances)
    .filter(([sym]) => !MARGIN_SAC_BALANCE_KEYS.includes(sym) && !isTrackingSymbol(sym))
    .reduce((sum, [, bal]) => sum + (parseFloat(bal.usdValue) || 0), 0);

  let grossCollateralValue = farmPositionValue + rawAssetValue + nonSacCollateralValue;
  if (grossCollateralValue <= USD_DUST_EPSILON && totalCollateralValue > USD_DUST_EPSILON) {
    grossCollateralValue = totalCollateralValue;
  }

  const {
    avgHealthFactor,
    collateralLeftBeforeLiquidation,
    netAvailableCollateral,
    totalValue,
    debtLimit,
  } = deriveMarginHealth({ grossCollateralValue, effectiveDebtValue, totalBorrowedValue });

  return {
    borrowedBalances,
    collateralBalances,
    totalBorrowedValue,
    totalCollateralValue,
    grossCollateralValue,
    totalValue,
    avgHealthFactor,
    collateralLeftBeforeLiquidation,
    netAvailableCollateral,
    borrowRate,
    debtLimit,
    debtDataIncomplete,
  };
}
