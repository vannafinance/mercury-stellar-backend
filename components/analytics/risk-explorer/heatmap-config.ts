import type { WalletPosition } from "./constants";

export const LEVERAGE_RANGES = [
  { label: "1–2x", min: 1, max: 2 },
  { label: "2–3x", min: 2, max: 3 },
  { label: "3–5x", min: 3, max: 5 },
  { label: "5–7x", min: 5, max: 7 },
  { label: "7–10x", min: 7, max: 10 },
] as const;

const VOL_DROPS = [-5, -10, -15, -20, -25, -30, -40, -50, -60] as const;
const STABLE_DROPS = [-1, -2, -3, -5, -8, -10, -13, -15, -20] as const;

/** Heatmap tabs: must align with how wallets tag `primaryAsset`. */
export const HEATMAP_ASSETS = [
  {
    symbol: "ETH",
    label: "ETH",
    drops: [...VOL_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "ETH",
  },
  {
    symbol: "WBTC",
    label: "WBTC",
    drops: [...VOL_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "WBTC",
  },
  {
    symbol: "weETH",
    label: "weETH",
    drops: [...VOL_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "weETH",
  },
  {
    symbol: "USDC",
    label: "USDC",
    drops: [...STABLE_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "USDC",
  },
  {
    symbol: "USDT",
    label: "USDT",
    drops: [...STABLE_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "USDT",
  },
  {
    symbol: "DAI",
    label: "DAI",
    drops: [...STABLE_DROPS],
    matchFn: (w: WalletPosition) => w.primaryAsset === "DAI",
  },
] as const;

export type HeatmapSelection = {
  assetTabIndex: number;
  row: number;
  col: number;
};
