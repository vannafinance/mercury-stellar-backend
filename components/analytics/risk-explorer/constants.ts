// Risk-Explorer asset universe & wallet generator. STELLAR-NATIVE only —
// every symbol comes from `lib/analytics/stellar/canon.ts → ACTIVE_ASSETS`
// and every synthetic address is a Stellar G-account (56 chars base32).
// We never introduce assets that aren't already used in the live app.

import {
  ACTIVE_ASSETS,
  FALLBACK_PRICES,
  resolveUsdAlias,
  syntheticGAccount,
  type StellarAsset,
} from "@/lib/analytics/stellar/canon";
import type { AccountSnapshot } from "@/lib/analytics/onchain/types";

export interface WalletPosition {
  address: string;
  collateral: number;
  debt: number;
  hf: number;
  primaryAsset: StellarAsset;
  leverageX: number;
}

function walletPrimaryAsset(snapshot: AccountSnapshot): StellarAsset {
  const topCollateral = snapshot.collateral
    .slice()
    .sort((a, b) => b.usd - a.usd)[0]?.symbol;
  const symbol = (topCollateral || "USDC").toUpperCase();
  if (ACTIVE_ASSETS.includes(symbol as StellarAsset)) {
    return symbol as StellarAsset;
  }
  // Fallback for a tracking/alias symbol (e.g. BLEND_USDC, AQ_XLM_USDC)
  // that isn't itself an ACTIVE_ASSET — route it to its real underlying
  // bucket (XLM | USDC) via the same canonical resolution the contract uses.
  return resolveUsdAlias(symbol);
}

export function mapSnapshotsToWallets(snapshots: AccountSnapshot[]): WalletPosition[] {
  return snapshots
    .filter((s) => s.totalCollateralUsd > 0 || s.totalDebtUsd > 0)
    .map((s) => ({
      address: s.account,
      collateral: s.totalCollateralUsd,
      debt: s.totalDebtUsd,
      hf: Number.isFinite(s.healthFactor) ? s.healthFactor : 99,
      primaryAsset: walletPrimaryAsset(s),
      leverageX: Number.isFinite(s.leverage) ? s.leverage : 1,
    }))
    .sort((a, b) => a.hf - b.hf);
}

/** USD reference prices for simulator math. Mirrors the Reflector
 *  fallbacks so a fresh user (cold cache) sees consistent numbers
 *  before live oracle prices land. */
export const TOKEN_PRICES: Record<StellarAsset, number> = {
  XLM: FALLBACK_PRICES.XLM,
  USDC: FALLBACK_PRICES.USDC,
};

/** Asset selector entries shown in the Risk Explorer side panel. */
export const SIM_ASSETS = [
  { symbol: "XLM", name: "Stellar Lumens", icon: "★" },
  { symbol: "USDC", name: "USD Coin", icon: "$" },
] as const;

const COLLATERAL_SYMBOLS: StellarAsset[] = ACTIVE_ASSETS;

/** Generate a deterministic synthetic-wallet population for the
 *  Risk Explorer simulator. The `chainId` argument is preserved for
 *  callsite compatibility but only used as a deterministic seed —
 *  this dashboard is single-chain (Stellar). */
export function generateWallets(chainId: number): WalletPosition[] {
  const seed = chainId * 7;
  const gen = (i: number) => {
    const r = Math.sin(seed + i * 13.7) * 10000;
    return Math.abs(r - Math.floor(r));
  };
  const pickAsset = (i: number) => COLLATERAL_SYMBOLS[i % COLLATERAL_SYMBOLS.length];
  const addr = (bucket: number, i: number) => syntheticGAccount(seed * 1000 + bucket * 100 + i);

  const wallets: WalletPosition[] = [];

  const underwaterCount = 2 + Math.floor(gen(0) * 3);
  for (let i = 0; i < underwaterCount; i++) {
    const coll = 20000 + gen(i + 100) * 300000;
    const hf = 0.75 + gen(i + 200) * 0.24;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: addr(1, i),
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const criticalCount = 3 + Math.floor(gen(1) * 4);
  for (let i = 0; i < criticalCount; i++) {
    const coll = 30000 + gen(i + 300) * 500000;
    const hf = 1.001 + gen(i + 400) * 0.098;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: addr(2, i),
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 2),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const warningCount = 5 + Math.floor(gen(2) * 6);
  for (let i = 0; i < warningCount; i++) {
    const coll = 25000 + gen(i + 500) * 600000;
    const hf = 1.1 + gen(i + 600) * 0.1;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: addr(3, i),
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 4),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const cautionCount = 12 + Math.floor(gen(3) * 8);
  for (let i = 0; i < cautionCount; i++) {
    const coll = 10000 + gen(i + 700) * 800000;
    const hf = 1.2 + gen(i + 800) * 0.3;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: addr(4, i),
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 1),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  const safeCount = 25 + Math.floor(gen(4) * 15);
  for (let i = 0; i < safeCount; i++) {
    const coll = 5000 + gen(i + 900) * 1000000;
    const hf = 1.5 + gen(i + 1000) * 3;
    const debt = (coll * 0.9) / hf;
    wallets.push({
      address: addr(5, i),
      collateral: coll,
      debt,
      hf,
      primaryAsset: pickAsset(i + 3),
      leverageX: coll / Math.max(coll - debt, 1),
    });
  }

  return wallets.sort((a, b) => a.hf - b.hf);
}
