/**
 * Margin-account reads against the credit layer (testnet redeploy 2026-11-06).
 *
 * One place that turns the new contract surface into the symbol-keyed
 * `{ amount, usdValue }` maps the margin UI has always consumed:
 *   - plain token holdings: margin.assets() Token entries -> SAC balance(margin)
 *   - LP holdings held directly by the margin: Soroswap pair token and the
 *     Aquarius XLM/AQUSDC share token -> balance(margin), priced by the oracle
 *   - Blend venue: BLEND_VALUER.positions(BLEND_POOL, margin) for the per-token
 *     split, oracle.get_price(BLEND_POOL, margin) for the whole position's USD
 *   - debts: margin.debts() -> reserve.debt_of(margin) (WAD)
 *   - health: CreditLayer.margin_value(margin) -> (collateral USD, debt USD)
 *
 * Balance keys stay the ones the UI already renders: XLM, USDC + BLUSDC (Blend
 * USDC, mirrored), AQUSDC, SOUSDC, BLEND_XLM / BLEND_USDC (Blend supply),
 * SS_XLM_USDC (Soroswap LP), AQ_XLM_USDC (Aquarius LP).
 *
 * Every read is a simulation (no signature). Nothing is cached in browser
 * storage.
 */
import {
  CREDIT_ASSETS,
  CREDIT_LAYER_ADDRESSES,
  HEALTH_THRESHOLD,
  creditAssetForToken,
  debtOf,
  marginAssets,
  marginDebts,
  marginValue,
  oraclePriceWad,
  readOr,
  sc,
  simulateRead,
  tokenBalance,
  wadToNumber,
  type CreditAsset,
} from './credit-layer';
import { CONTRACT_ADDRESSES } from './stellar-utils';

export type BalanceRow = { amount: string; usdValue: string };
export type BalanceMap = Record<string, BalanceRow>;

const DUST = 1e-9;
const NATIVE_DECIMALS = 7;

/** Symbol the margin UI / history uses for a credit asset. Blend USDC is "USDC" (mirrored to BLUSDC in balance maps). */
const UI_SYMBOL: Record<CreditAsset, string> = {
  XLM: 'XLM',
  BLUSDC: 'USDC',
  AQUSDC: 'AQUSDC',
  SOUSDC: 'SOUSDC',
};

/** Balance keys of the LP / venue rows (all derived from real reads, never from a ledger). */
export const SOROSWAP_LP_KEY = 'SS_XLM_USDC';
export const AQUARIUS_LP_KEY = 'AQ_XLM_USDC';
export const BLEND_KEYS: Record<string, string> = { XLM: 'BLEND_XLM', USDC: 'BLEND_USDC' };

/** UI symbol for a token contract address (credit asset, LP token or Blend pool), or the address itself. */
export function symbolForToken(token: string): string {
  const a = creditAssetForToken(token);
  if (a) return UI_SYMBOL[a];
  if (token === CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL) return SOROSWAP_LP_KEY;
  if (token === CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_SHARE) return AQUARIUS_LP_KEY;
  if (token === CONTRACT_ADDRESSES.BLEND_POOL) return 'BLEND';
  return token;
}

const nativeToNumber = (v: bigint | string | number, decimals = NATIVE_DECIMALS): number => {
  const b = BigInt(v as any);
  const base = BigInt(10) ** BigInt(decimals);
  return Number(b / base) + Number(b % base) / Number(base);
};

/** Mirror Blend USDC under both USDC and BLUSDC so every UI key resolves. */
export function addUsdcAliases(balances: BalanceMap): BalanceMap {
  if (balances.USDC && !balances.BLUSDC) balances.BLUSDC = { ...balances.USDC };
  else if (balances.BLUSDC && !balances.USDC) balances.USDC = { ...balances.BLUSDC };
  return balances;
}

/** Oracle USD price of a token (Liquidation mode) as a number; 0 on failure. */
export async function priceUsd(token: string, account?: string): Promise<number> {
  try {
    return wadToNumber(await oraclePriceWad(token, account));
  } catch {
    return 0;
  }
}

export interface BlendVenueRow {
  token: string;
  symbol: string;
  /** Supplied amount, token units. */
  owned: number;
  /** Borrowed from Blend, token units (the credit layer only supplies, so normally 0). */
  owed: number;
}

/** BLEND_VALUER.positions(BLEND_POOL, margin) decoded to token units. */
export async function blendPositions(margin: string): Promise<BlendVenueRow[]> {
  const raw = await readOr<any[]>(
    CREDIT_LAYER_ADDRESSES.BLEND_VALUER,
    'positions',
    [sc.address(CONTRACT_ADDRESSES.BLEND_POOL), sc.address(margin)],
    [],
  );
  return (raw || []).map((p: any) => ({
    token: String(p.token),
    symbol: symbolForToken(String(p.token)),
    owned: nativeToNumber(p.owned ?? 0),
    owed: nativeToNumber(p.owed ?? 0),
  }));
}

export interface MarginPortfolio {
  /** Plain token holdings keyed by UI symbol (USDC mirrored to BLUSDC). */
  tokens: BalanceMap;
  /** LP + Blend rows keyed SS_XLM_USDC / AQ_XLM_USDC / BLEND_XLM / BLEND_USDC. */
  venues: BalanceMap;
  /** tokens + venues in one map (what getCollateralBalances returns). */
  collateral: BalanceMap;
  /** Per-token debts keyed by UI symbol (USDC mirrored to BLUSDC). */
  debts: BalanceMap;
  /** Exact debt WAD per UI symbol. */
  debtWad: Record<string, bigint>;
  /** Contract-side valuation (Liquidation prices); null when the read failed. */
  collateralUsd: number | null;
  debtUsd: number | null;
  /** collateral / debt; Infinity with no debt; null when unknown. */
  healthFactor: number | null;
  /** Token prices used (UI symbol -> USD). */
  prices: Record<string, number>;
}

/**
 * Full margin read. `includePrices: false` skips oracle reads (usdValue "0.00").
 * Debt reads that fail are reported through `debtsPartial`.
 */
export async function readMarginPortfolio(
  margin: string,
  options: { includePrices?: boolean; includeVenues?: boolean; includeValue?: boolean } = {},
): Promise<MarginPortfolio & { debtsPartial: boolean }> {
  const includePrices = options.includePrices !== false;
  const includeVenues = options.includeVenues !== false;
  const includeValue = options.includeValue !== false;

  const [listed, debtTokens, value] = await Promise.all([
    marginAssets(margin),
    marginDebts(margin),
    includeValue ? marginValue(margin).catch(() => null) : Promise.resolve(null),
  ]);

  // Always read all four credit assets: a token can sit in the account without
  // being listed (e.g. leftovers from a venue call), and the read is cheap.
  const tokenAddrs = Array.from(
    new Set([...listed.tokens.filter((t) => creditAssetForToken(t)), ...Object.values(CREDIT_ASSETS).map((a) => a.token)]),
  );

  const prices: Record<string, number> = {};
  const priceOf = async (token: string): Promise<number> => {
    const sym = symbolForToken(token);
    if (prices[sym] !== undefined) return prices[sym];
    const p = includePrices ? await priceUsd(token) : 0;
    prices[sym] = p;
    return p;
  };

  const tokens: BalanceMap = {};
  await Promise.all(
    tokenAddrs.map(async (token) => {
      const bal = await tokenBalance(token, margin);
      const amount = nativeToNumber(bal);
      if (!(amount > DUST)) return;
      const px = await priceOf(token);
      tokens[symbolForToken(token)] = { amount: amount.toFixed(7), usdValue: (amount * px).toFixed(2) };
    }),
  );

  const venues: BalanceMap = {};
  if (includeVenues) {
    const lpTokens = [CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL, CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_SHARE];
    await Promise.all([
      ...lpTokens.map(async (lp) => {
        const bal = await tokenBalance(lp, margin);
        const amount = nativeToNumber(bal);
        if (!(amount > DUST)) return;
        const px = includePrices ? await priceUsd(lp) : 0;
        venues[symbolForToken(lp)] = { amount: amount.toFixed(7), usdValue: (amount * px).toFixed(2) };
      }),
      (async () => {
        if (!listed.venues.includes(CONTRACT_ADDRESSES.BLEND_POOL)) return;
        const rows = await blendPositions(margin);
        for (const r of rows) {
          if (!(r.owned > DUST)) continue;
          const key = BLEND_KEYS[r.symbol] ?? `BLEND_${r.symbol}`;
          const px = await priceOf(r.token);
          venues[key] = { amount: r.owned.toFixed(7), usdValue: (r.owned * px).toFixed(2) };
        }
      })(),
    ]);
  }

  const debts: BalanceMap = {};
  const debtWad: Record<string, bigint> = {};
  let debtsPartial = false;
  await Promise.all(
    debtTokens.map(async (token) => {
      const asset = creditAssetForToken(token);
      if (!asset) return;
      try {
        const wad = await readDebtWadWithRetry(asset, margin);
        if (wad <= BigInt(0)) return;
        const sym = UI_SYMBOL[asset];
        const amount = wadToNumber(wad);
        const px = await priceOf(token);
        debtWad[sym] = wad;
        debts[sym] = { amount: amount.toFixed(7), usdValue: (amount * px).toFixed(2) };
      } catch {
        debtsPartial = true;
      }
    }),
  );
  if (debtWad.USDC !== undefined) debtWad.BLUSDC = debtWad.USDC;

  addUsdcAliases(tokens);
  addUsdcAliases(debts);

  const collateralUsd = value ? wadToNumber(value.collateralWad) : null;
  const debtUsd = value ? wadToNumber(value.debtWad) : null;
  const healthFactor = value ? healthFactorOf(collateralUsd!, debtUsd!) : null;

  return {
    tokens,
    venues,
    collateral: { ...tokens, ...venues },
    debts,
    debtWad,
    collateralUsd,
    debtUsd,
    healthFactor,
    prices,
    debtsPartial,
  };
}

async function readDebtWadWithRetry(asset: CreditAsset, margin: string, attempt = 0): Promise<bigint> {
  // debtOf() swallows errors into 0 — read the reserve directly so a failed
  // read is not mistaken for "no debt" (that would overstate health).
  try {
    return BigInt(await simulateRead<bigint>(CREDIT_ASSETS[asset].reserve, 'debt_of', [sc.address(margin)]));
  } catch (e) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      return readDebtWadWithRetry(asset, margin, attempt + 1);
    }
    throw e;
  }
}

/** Exact debt WAD for one asset (0 when none). Thin wrapper kept for callers. */
export async function debtWadFor(symbol: string, margin: string): Promise<bigint> {
  return debtOf(symbol, margin);
}

/** HF = collateral / debt; Infinity when there is no debt. */
export function healthFactorOf(collateralUsd: number, debtUsd: number): number {
  if (!(debtUsd > 0)) return Infinity;
  return collateralUsd / debtUsd;
}

/**
 * Largest extra borrow (USD) that keeps the account healthy. Borrowed funds
 * land in the margin account, so they count on both sides:
 *   (C + B) / (D + B) > L   <=>   B < (C - L·D) / (L - 1)
 * where L is the credit layer's `borrow_limit` (1.2 unless the admin moved it;
 * pass the live value from getHealthLimits()). Contracts: credit_layer
 * health::meets_limit + shared math::is_healthy, strict >.
 * `buffer` (default 0.5%) keeps the estimate just inside the strict bound.
 */
export function maxBorrowUsd(collateralUsd: number, debtUsd: number, buffer = 0.005, limit = HEALTH_THRESHOLD): number {
  const t = limit;
  const room = (collateralUsd - t * debtUsd) / (t - 1);
  return Math.max(0, room * (1 - buffer));
}

/**
 * Largest withdrawal (USD) that keeps the account healthy:
 *   (C - W) / D > L   <=>   W < C - L·D   (no debt => everything),
 * with L the credit layer's `borrow_limit` (see maxBorrowUsd).
 */
export function maxWithdrawUsd(collateralUsd: number, debtUsd: number, buffer = 0.005, limit = HEALTH_THRESHOLD): number {
  if (!(debtUsd > 0)) return Math.max(0, collateralUsd);
  return Math.max(0, (collateralUsd - limit * debtUsd) * (1 - buffer));
}
