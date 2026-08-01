import type { AssetType } from "@/lib/stellar-utils";

export interface EarnHistoryEntry {
  id: string;
  walletAddress: string;
  asset: AssetType;
  type: "supply" | "withdraw";
  amount: string;
  timestamp: number;
  hash: string;
  status: "success";
}

const STORAGE_KEY = "vanna_earn_history_v1";
const MAX_ITEMS = 200;

const isBrowser = () => typeof window !== "undefined";

const normalizeAsset = (value: string): AssetType => {
  const u = (value || "").toUpperCase();
  // Collapse legacy USDC variants + display aliases → Circle USDC
  if (
    u === "BLUSDC" || u === "USDC" || u === "BLEND_USDC" ||
    u === "AQUSDC" || u === "AQUSDC" || u === "AQUIRESUSDC" || u === "AQUARIUS_USDC" ||
    u === "SOUSDC" || u === "SOROSWAPUSDC" || u === "SOROSWAP_USDC" ||
    value === "AqUSDC" || value === "SoUSDC"
  ) return "USDC";
  return (u || "XLM") as AssetType;
};

const readAll = (): EarnHistoryEntry[] => {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object");
  } catch {
    return [];
  }
};

const writeAll = (entries: EarnHistoryEntry[]) => {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ITEMS)));
};

export const appendEarnHistory = (entry: {
  walletAddress: string;
  asset: AssetType;
  type: "supply" | "withdraw";
  amount: string;
  hash: string;
  status?: "success";
  timestamp?: number;
}) => {
  if (!isBrowser()) return;

  const next: EarnHistoryEntry = {
    id: `${entry.walletAddress}:${entry.asset}:${entry.hash || Date.now().toString(36)}`,
    walletAddress: entry.walletAddress,
    asset: normalizeAsset(entry.asset),
    type: entry.type,
    amount: entry.amount,
    hash: entry.hash,
    status: "success",
    timestamp: entry.timestamp ?? Date.now(),
  };

  const current = readAll();
  const withoutDup = current.filter((item) => !(item.hash && next.hash && item.hash === next.hash));
  writeAll([next, ...withoutDup]);
};

/**
 * Scoped to BOTH asset and wallet — the storage key (`vanna_earn_history_v1`)
 * is shared across every wallet ever connected in this browser. Without the
 * wallet filter, switching accounts showed whichever wallet's cached supply/
 * withdraw entries happened to be in localStorage for this asset, not the
 * currently connected one's (confirmed live: Portfolio's Position History
 * showed a different wallet's transactions entirely).
 */
export const getEarnHistoryByAsset = (asset: string, walletAddress?: string | null): EarnHistoryEntry[] => {
  if (!walletAddress) return [];
  const normalized = normalizeAsset(asset);
  return readAll()
    .filter((item) => normalizeAsset(item.asset) === normalized && item.walletAddress === walletAddress)
    .sort((a, b) => b.timestamp - a.timestamp);
};
