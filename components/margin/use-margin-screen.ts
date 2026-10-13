"use client";

/**
 * Everything the V3 Margin screen reads, in one place:
 *
 * - `acct` / `model` / `now`: the RiskEngine-exact account model (`useV3Account`,
 *   lib/account-model.ts) — health factor, account leverage, liquidation buffer and every
 *   "after this action" preview;
 * - the margin store (`useMarginAccountInfoStore`), fed by the per-account `/api/account/[addr]`
 *   snapshot (see margin-page-content.tsx) and by the post-transaction `refreshBorrowedBalances`
 *   reads — per-token collateral / debt, the RiskEngine-aligned gross collateral and debt totals
 *   that the pre-sign borrow / withdraw checks use, and the borrow rate;
 * - wallet balances (user store) and on-chain oracle prices (`useTokenPrices`).
 *
 * Nothing here is persisted; every figure is a live chain read.
 *
 * Symbols: the action tabs use the app's dropdown symbols (`XLM`, `BLUSDC`, `AqUSDC`, `SoUSDC`);
 * the store keys collateral / debt by their canonical upper-case form (`XLM`, `BLUSDC`, `AQUSDC`,
 * `SOUSDC`). {@link ckey} maps one onto the other.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, type BorrowedBalance } from "@/store/margin-account-info-store";
import { useAccountSnapshot, type AccountSnapshot } from "@/hooks/use-account-snapshot";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useV3Account, type V3Account } from "@/hooks/use-v3-account";
import { accountNumbers, type AccountNumbers, type ModelState } from "@/lib/account-model";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";
import { USD_DUST_EPSILON } from "@/lib/account-snapshot";
import { NETWORK_PASSPHRASE } from "@/lib/stellar-utils";
import { EMPTY_STATE } from "./mg-sim";

/** Amounts below this are float dust (treated as zero). */
const DUST = 1e-9;

/** Every symbol the screen prices (aliases resolve to USDC inside the oracle module). */
export const PRICE_SYMBOLS = ["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC"];

/**
 * Canonical margin-store key of a UI / contract symbol — same mapping as the store's
 * `canonicalMarginToken` (BLEND_USDC / USDC → BLUSDC, AquiresUSDC → AQUSDC, …).
 */
export const ckey = (symbol: string): string => {
  const n = (symbol || "").toUpperCase();
  if (n === "BLEND_USDC" || n === "USDC") return "BLUSDC";
  if (n === "AQUIRESUSDC" || n === "AQUARIUS_USDC") return "AQUSDC";
  if (n === "SOROSWAPUSDC" || n === "SOROSWAP_USDC") return "SOUSDC";
  return n;
};

/** Stellar Expert base URL for the network the app is deployed on (testnet unless the passphrase says otherwise). */
const EXPLORER = `https://stellar.expert/explorer/${NETWORK_PASSPHRASE.includes("Test") ? "testnet" : "public"}`;
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerContract = (id: string) => `${EXPLORER}/contract/${id}`;

export interface MarginScreen {
  address: string | null;
  connected: boolean;
  /** The wallet has a margin account (snapshot first, store fallback). */
  hasAccount: boolean;
  /** Connected but the first snapshot hasn't arrived yet. */
  loading: boolean;
  marginAddress: string | null;
  acct: V3Account;
  /** The account model (an empty account when there is none / not loaded). */
  model: ModelState;
  now: AccountNumbers;
  snapshot: AccountSnapshot | undefined;
  snapshotError: string | null;
  /** Oracle USD price per symbol (any alias; 0 = unknown). */
  px: (symbol: string) => number;
  /** Raw price map from `useTokenPrices` (upper-case keys), for the tabs' exact pre-sign math. */
  prices: Record<string, number>;
  /** Wallet balance (UI units). */
  wbal: (symbol: string) => number;
  /** Margin-account balance (UI units; borrowed tokens included, farm receipts excluded). */
  vault: (symbol: string) => number;
  /** Outstanding debt (UI units). */
  debt: (symbol: string) => number;
  collateralBalances: Record<string, BorrowedBalance>;
  borrowedBalances: Record<string, BorrowedBalance>;
  /** RiskEngine-aligned gross collateral USD (store; snapshot fallback). */
  gross: number;
  /** Total debt USD (store; snapshot fallback). */
  borrowedUsd: number;
  /** Borrow APR of the largest loan's pool, percent. */
  borrowRate: number;
}

export function useMarginScreen(): MarginScreen {
  const { address, connected, tokenBalances } = useUserStore(
    useShallow((s) => ({ address: s.address, connected: s.isConnected, tokenBalances: s.tokenBalances })),
  );
  const st = useMarginAccountInfoStore(
    useShallow((s) => ({
      hasMarginAccount: s.hasMarginAccount,
      marginAccountAddress: s.marginAccountAddress,
      collateralBalances: s.collateralBalances,
      borrowedBalances: s.borrowedBalances,
      grossCollateralValue: s.grossCollateralValue,
      totalBorrowedValue: s.totalBorrowedValue,
      borrowRate: s.borrowRate,
    })),
  );
  const { snapshot, error } = useAccountSnapshot(address);
  const acct = useV3Account();
  const prices = useTokenPrices(PRICE_SYMBOLS);

  const hasAccount = Boolean(address) && (snapshot?.hasMarginAccount ?? st.hasMarginAccount);
  const model = acct.state ?? EMPTY_STATE;
  const now = useMemo(() => accountNumbers(model), [model]);

  return useMemo(() => {
    const clean = (v: number) => (Number.isFinite(v) && v > DUST ? v : 0);
    const amountOf = (m: Record<string, BorrowedBalance>, s: string) => parseFloat(m[ckey(s)]?.amount ?? "0") || 0;
    // Effective collateral = store when it has balances (live/optimistic), else the snapshot
    // baseline — so a transiently blanked store never reads as "no collateral".
    const storeHas = Object.values(st.collateralBalances).some((b) => parseFloat(b.amount) > 0);
    const coll = storeHas ? st.collateralBalances : ((snapshot?.collateralBalances as Record<string, BorrowedBalance> | undefined) ?? st.collateralBalances);
    const gross = st.grossCollateralValue > 0.01 ? st.grossCollateralValue : (snapshot?.grossCollateralValue ?? 0);
    const borrowedUsd = st.totalBorrowedValue > 0 ? st.totalBorrowedValue : (snapshot?.totalBorrowedValue ?? 0);
    const px = (s: string) => {
      const k = ckey(s);
      const p = prices[k] ?? prices[(s || "").toUpperCase()];
      return p && p > 0 ? p : 0;
    };
    const wbal = (s: string) => {
      if (!address) return 0;
      switch (ckey(s)) {
        case "BLUSDC":
          return clean(parseFloat(tokenBalances.USDC || tokenBalances.BLEND_USDC || "0"));
        case "AQUSDC":
          return clean(parseFloat(tokenBalances.AQUARIUS_USDC || "0"));
        case "SOUSDC":
          return clean(parseFloat(tokenBalances.SOROSWAP_USDC || "0"));
        default:
          return clean(parseFloat(tokenBalances.XLM || "0"));
      }
    };
    const vault = (s: string) => {
      if (!address) return 0;
      const k = ckey(s);
      const bal = coll[k];
      // Farm / Blend tracking receipts (BLEND_*, AQ_*, SS_*, *_LP) aren't margin balances.
      if (!bal || isTrackingSymbol(k) || parseFloat(bal.usdValue) <= USD_DUST_EPSILON) return 0;
      return clean(parseFloat(bal.amount));
    };
    return {
      address,
      connected: Boolean(address) && connected,
      hasAccount,
      loading: Boolean(address) && !snapshot,
      marginAddress: st.marginAccountAddress ?? snapshot?.marginAccountAddress ?? null,
      acct,
      model,
      now,
      snapshot,
      snapshotError: error,
      px,
      prices,
      wbal,
      vault,
      debt: (s: string) => (address ? clean(amountOf(st.borrowedBalances, s)) : 0),
      collateralBalances: coll,
      borrowedBalances: st.borrowedBalances,
      gross,
      borrowedUsd,
      borrowRate: snapshot?.borrowRate ?? st.borrowRate ?? 0,
    };
  }, [address, connected, hasAccount, snapshot, st, acct, model, now, error, prices, tokenBalances]);
}
