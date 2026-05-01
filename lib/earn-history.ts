import type { AssetType } from "@/lib/stellar-utils";

export interface EarnHistoryEntry {
  id: string;
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
  if (value === "BLUSDC" || value === "USDC") return "USDC";
  if (value === "AqUSDC" || value === "AQUIRESUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SOROSWAPUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  return (value?.toUpperCase?.() || "XLM") as AssetType;
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
  asset: AssetType;
  type: "supply" | "withdraw";
  amount: string;
  hash: string;
  status?: "success";
  timestamp?: number;
}) => {
  if (!isBrowser()) return;

  const next: EarnHistoryEntry = {
    id: `${entry.asset}:${entry.hash || Date.now().toString(36)}`,
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

export const getEarnHistoryByAsset = (asset: string): EarnHistoryEntry[] => {
  const normalized = normalizeAsset(asset);
  return readAll()
    .filter((item) => normalizeAsset(item.asset) === normalized)
    .sort((a, b) => b.timestamp - a.timestamp);
};
