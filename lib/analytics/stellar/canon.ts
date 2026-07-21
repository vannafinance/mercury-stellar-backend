// Single source of truth for Stellar-native analytics fixtures.
//
// All analytics charts/simulators must source asset symbols, protocol
// names, oracle metadata, and address formats from this module — never
// EVM artifacts (ETH/WBTC/Aave/Uniswap/Chainlink/0x...). The asset
// universe matches what Vanna's Soroban deployment actually supports
// today: contracts in `Protocol_V1_Soroban` + DropdownOptions in
// `lib/constants.ts`.

import { CONTRACT_ADDRESSES } from '../../stellar-utils';

export type StellarAsset =
  | "XLM"
  | "BLUSDC"
  | "AQUSDC"
  | "SOUSDC"
  | "EURC"
  | "BLND"
  | "AQUA"
  | "WETH";

/** Tracking collateral symbols emitted by SmartAccount when a user
 *  deposits into Blend / Aquarius / Soroswap. UI may surface them as
 *  separate rows even though they price-resolve to underlying. */
export type TrackingSymbol =
  | "BLEND_XLM"
  | "BLEND_USDC"
  | "BLEND_EURC"
  | "BLEND_WETH"
  | "AQ_XLM_USDC"
  | "AQ_WETH_AQUA"
  | "SS_XLM_USDC"
  | "SS_XLM_EURC";

export type StellarSymbol = StellarAsset | TrackingSymbol;

export type StellarProtocol = "Blend" | "Aquarius" | "Soroswap";

// User-selectable assets (matches earn ALL_ASSETS / DropdownOptions).
export const ACTIVE_ASSETS: StellarAsset[] = [
  "XLM", "BLUSDC", "AQUSDC", "SOUSDC", "BLND", "AQUA", "WETH", "EURC",
];

export const PROTOCOLS: StellarProtocol[] = ["Blend", "Aquarius", "Soroswap"];

/** Reflector is the only oracle wrapper deployed by the protocol. Risk
 *  Explorer / Oracles page reference this name and contract id directly. */
export const ORACLE = {
  name: "Reflector",
  description: "Soroban oracle aggregator (Reflector network) wrapped by the protocol's Oracle contract",
  contractAddress: CONTRACT_ADDRESSES.ORACLE,
  expectedHeartbeatSec: 60,
} as const;

/** Conservative testnet reference prices used as fallbacks when the
 *  Reflector RPC probe hasn't returned yet. Real values are read from
 *  `lib/oracle-price.ts` during runtime. */
export const FALLBACK_PRICES: Record<StellarSymbol, number> = {
  XLM: 0.16,
  USDC: 1.0 as never, // listed for readability — see resolveUsdAlias
  BLUSDC: 1.0,
  AQUSDC: 1.0,
  SOUSDC: 1.0,
  EURC: 1.08,
  BLND: 0.05,
  AQUA: 0.01,
  WETH: 3000,
  BLEND_XLM: 0.16,
  BLEND_USDC: 1.0,
  BLEND_EURC: 1.08,
  BLEND_WETH: 3000,
  AQ_XLM_USDC: 0.4, // LP token rough geometric-mean reference
  AQ_WETH_AQUA: 30,
  SS_XLM_USDC: 0.4,
  SS_XLM_EURC: 0.4,
} as Record<StellarSymbol, number>;

/** Maps every variant to its underlying price symbol, mirroring the
 *  contract-side `canonical_price_symbol` in `risk_engine.rs`. */
export function resolveUsdAlias(sym: string): "XLM" | "USDC" | "EURC" {
  const u = (sym || "").toUpperCase();
  if (u === "XLM" || u === "BLEND_XLM" || u === "BLXLM") return "XLM";
  if (u === "EURC" || u === "BLEND_EURC") return "EURC";
  return "USDC";
}

export type CanonicalUsdSymbol = ReturnType<typeof resolveUsdAlias>;

/** Fallback USD unit price for resolveUsdAlias buckets (USDC → BLUSDC peg). */
export function fallbackPriceForCanonical(c: CanonicalUsdSymbol): number {
  if (c === "XLM") return FALLBACK_PRICES.XLM;
  if (c === "EURC") return FALLBACK_PRICES.EURC;
  return FALLBACK_PRICES.BLUSDC;
}

/** Fallback USD unit price for raw event/token symbols before canonical merge. */
export function fallbackPriceForSymbol(sym: string): number | undefined {
  const u = (sym || "").toUpperCase();
  switch (u) {
    case "XLM":
      return FALLBACK_PRICES.XLM;
    case "EURC":
      return FALLBACK_PRICES.EURC;
    case "BLND":
      return FALLBACK_PRICES.BLND;
    case "AQUA":
      return FALLBACK_PRICES.AQUA;
    case "WETH":
      return FALLBACK_PRICES.WETH;
    case "BLUSDC":
      return FALLBACK_PRICES.BLUSDC;
    case "AQUSDC":
      return FALLBACK_PRICES.AQUSDC;
    case "SOUSDC":
      return FALLBACK_PRICES.SOUSDC;
    case "BLEND_XLM":
      return FALLBACK_PRICES.BLEND_XLM;
    case "BLEND_USDC":
      return FALLBACK_PRICES.BLEND_USDC;
    case "BLEND_EURC":
      return FALLBACK_PRICES.BLEND_EURC;
    case "BLEND_WETH":
      return FALLBACK_PRICES.BLEND_WETH;
    case "AQ_XLM_USDC":
      return FALLBACK_PRICES.AQ_XLM_USDC;
    case "AQ_WETH_AQUA":
      return FALLBACK_PRICES.AQ_WETH_AQUA;
    case "SS_XLM_USDC":
      return FALLBACK_PRICES.SS_XLM_USDC;
    case "SS_XLM_EURC":
      return FALLBACK_PRICES.SS_XLM_EURC;
    case "USDC":
      return FALLBACK_PRICES.BLUSDC;
    default:
      return undefined;
  }
}

/** True for tracking-token collateral that doesn't have its own oracle
 *  feed (matches `is_unpriced_collateral` in risk_engine.rs). */
export function isTrackingSymbol(sym: string): boolean {
  const u = (sym || "").toUpperCase();
  return (
    u === "BLEND_XLM" ||
    u === "BLEND_USDC" ||
    u === "BLEND_EURC" ||
    u === "BLEND_WETH" ||
    u === "AQ_XLM_USDC" ||
    u === "AQ_WETH_AQUA" ||
    u === "SS_XLM_USDC" ||
    u === "SS_XLM_EURC" ||
    u === "AQ_XLM_AQUA" ||
    u === "AQ_XLM_USDT"
  );
}

/** Which protocol does this tracking-collateral belong to? Used to tag
 *  position rows / margin composition / simulator scenarios. */
export function protocolFor(sym: string): StellarProtocol | null {
  const u = (sym || "").toUpperCase();
  if (u.startsWith("BLEND_") || u === "BLUSDC") return "Blend";
  if (u.startsWith("AQ_") || u === "AQUSDC") return "Aquarius";
  if (u.startsWith("SS_") || u === "SOUSDC") return "Soroswap";
  return null;
}

/** Asset metadata for UI dropdowns / icons / risk-explorer asset picker. */
export const ASSET_META: Record<StellarAsset, {
  symbol: StellarAsset;
  name: string;
  icon: string;
  decimals: number;
  /** Pool contract id from stellar-utils CONTRACT_ADDRESSES (informational). */
  poolKey: string;
}> = {
  XLM: { symbol: "XLM", name: "Stellar Lumens", icon: "/coins/xlmbg.png", decimals: 7, poolKey: "LENDING_PROTOCOL_XLM" },
  BLUSDC: { symbol: "BLUSDC", name: "Blend USDC", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_BLEND_USDC" },
  AQUSDC: { symbol: "AQUSDC", name: "Aquarius USDC", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_AQUARIUS_USDC" },
  SOUSDC: { symbol: "SOUSDC", name: "Soroswap USDC", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_SOROSWAP_USDC" },
  EURC: { symbol: "EURC", name: "Euro Coin", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_EURC" },
  BLND: { symbol: "BLND", name: "Blend", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_BLND" },
  AQUA: { symbol: "AQUA", name: "Aquarius", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_AQUA" },
  WETH: { symbol: "WETH", name: "Wrapped Ether", icon: "/icons/usdc-icon.svg", decimals: 7, poolKey: "LENDING_PROTOCOL_WETH" },
};

// ─────────────────────────────────────────────────────────────────────
// Synthetic Stellar address helpers
// ─────────────────────────────────────────────────────────────────────

/** Stellar G-accounts are 56 chars base32 starting with G. We don't need
 *  cryptographic validity for chart keys — uniqueness + visual cue. */
export function syntheticGAccount(seed: number): string {
  const tail = Math.abs(Math.floor(Math.sin(seed * 9301 + 49297) * 1e12))
    .toString(36)
    .toUpperCase()
    .padStart(50, "0")
    .slice(0, 50);
  return `G${tail}`;
}

/** Stellar contract addresses are 56 chars base32 starting with C. */
export function syntheticCAccount(seed: number): string {
  const tail = Math.abs(Math.floor(Math.cos(seed * 7919 + 31337) * 1e12))
    .toString(36)
    .toUpperCase()
    .padStart(50, "0")
    .slice(0, 50);
  return `C${tail}`;
}

/** Pretty short form for tables — matches the explorer.stellar.org pattern. */
export function shortStellar(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Stellar-native simulator presets (replaces ETH/Black-Thursday EVM presets)
// ─────────────────────────────────────────────────────────────────────

export type StellarStressPreset = {
  id: string;
  name: string;
  description: string;
  /** Asset whose price gets shocked. Stables → simulates depeg. */
  asset: StellarAsset;
  direction: "up" | "down";
  /** Magnitude in % (positive number). */
  priceChangePct: number;
  /** Optional protocol tag for scenario grouping in the UI. */
  protocol?: StellarProtocol | "Reflector" | "Network";
};

export const STELLAR_STRESS_PRESETS: StellarStressPreset[] = [
  {
    id: "xlm-flash-crash",
    name: "XLM Flash Crash",
    description: "XLM −35% in 1h: cascading liquidations across XLM-denominated debt and Blend/Aquarius/Soroswap LPs.",
    asset: "XLM",
    direction: "down",
    priceChangePct: 35,
    protocol: "Network",
  },
  {
    id: "xlm-bear",
    name: "XLM Sustained Drawdown",
    description: "Macro risk-off: XLM −20% over a week. Tests insurance fund coverage at moderate stress.",
    asset: "XLM",
    direction: "down",
    priceChangePct: 20,
    protocol: "Network",
  },
  {
    id: "blusdc-depeg",
    name: "Blend USDC Depeg",
    description: "Blend's USDC reserve depegs to $0.95 — collateral and debt both reprice.",
    asset: "BLUSDC",
    direction: "down",
    priceChangePct: 5,
    protocol: "Blend",
  },
  {
    id: "aqusdc-depeg",
    name: "Aquarius USDC Depeg",
    description: "Aquarius pool USDC slips to $0.93 — mainly affects AQUSDC LP collateral.",
    asset: "AQUSDC",
    direction: "down",
    priceChangePct: 7,
    protocol: "Aquarius",
  },
  {
    id: "sousdc-depeg",
    name: "Soroswap USDC Depeg",
    description: "Soroswap-deployed USDC drops to $0.94 — concentrated impact on SOUSDC borrowers/LPs.",
    asset: "SOUSDC",
    direction: "down",
    priceChangePct: 6,
    protocol: "Soroswap",
  },
  {
    id: "reflector-outage",
    name: "Reflector Oracle Outage",
    description: "Oracle stale > 5 min for XLM — Risk Engine fails open: borrows/withdraws blocked, existing positions untouched (proxy: −15% XLM).",
    asset: "XLM",
    direction: "down",
    priceChangePct: 15,
    protocol: "Reflector",
  },
  {
    id: "stellar-network-halt",
    name: "Stellar Network Halt",
    description: "Soroban produces no new ledgers for 60 min — liquidators can't act, debt accrues. Proxy: −10% XLM under no-action.",
    asset: "XLM",
    direction: "down",
    priceChangePct: 10,
    protocol: "Network",
  },
  {
    id: "blend-pool-exploit",
    name: "Blend Pool Exploit",
    description: "Catastrophic external event in Blend pool — BLEND_XLM/BLEND_USDC tracking collateral impaired (proxy: XLM −50%).",
    asset: "XLM",
    direction: "down",
    priceChangePct: 50,
    protocol: "Blend",
  },
  {
    id: "aquarius-il",
    name: "Aquarius LP Impermanent Loss",
    description: "Sharp XLM/USDC divergence on Aquarius — leveraged LPs see HF collapse from IL. Proxy: −18% XLM.",
    asset: "XLM",
    direction: "down",
    priceChangePct: 18,
    protocol: "Aquarius",
  },
];
