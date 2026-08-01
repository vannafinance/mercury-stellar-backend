import type { WalletPosition } from "./constants";

export const LEVERAGE_RANGES = [
  { label: "1–2x", min: 1, max: 2 },
  { label: "2–3x", min: 2, max: 3 },
  { label: "3–5x", min: 3, max: 5 },
  { label: "5–7x", min: 5, max: 7 },
  { label: "7–10x", min: 7, max: 10 },
] as const;

// Volatile-asset drops apply to XLM (real market risk, not a
// peg). Stable drops apply to USDC — depegs are tighter.
const VOL_DROPS = [-5, -10, -15, -20, -25, -30, -40, -50, -60] as const;
const STABLE_DROPS = [-1, -2, -3, -5, -8, -10, -13, -15, -20] as const;

/** Heatmap tabs match wallet `primaryAsset` exactly. Stellar-only — no
 *  EVM tabs (ETH/WBTC/weETH) and no stables we don't actually support.
 *  Kept in sync with `lib/analytics/stellar/canon.ts`'s `ACTIVE_ASSETS` —
 *  this array doesn't derive from it automatically, so a newly-onboarded
 *  token needs an entry added here too. */
export const HEATMAP_ASSETS = [
  {
    symbol: "XLM",
    label: "XLM",
    drops: [...VOL_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "XLM",
  },
  {
    symbol: "USDC",
    label: "USDC",
    drops: [...STABLE_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "USDC",
  },
] as const;

export type HeatmapSelection = {
  assetTabIndex: number;
  row: number;
  col: number;
};
