export interface MarginHistoryEntry {
  id: string;
  marginAccountAddress: string;
  type: "deposit" | "borrow" | "repay" | "transfer-in" | "transfer-out";
  asset: string;
  amount: string;
  timestamp: number;
  hash: string;
}

const STORAGE_KEY = "vanna_margin_history_v1";
const MAX_ITEMS = 200;

const isBrowser = () => typeof window !== "undefined";

const readAll = (): MarginHistoryEntry[] => {
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

const writeAll = (entries: MarginHistoryEntry[]) => {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ITEMS)));
};

export const appendMarginHistory = (entry: Omit<MarginHistoryEntry, "id" | "timestamp"> & { timestamp?: number }) => {
  if (!isBrowser()) return;

  const next: MarginHistoryEntry = {
    ...entry,
    id: `${entry.marginAccountAddress}:${entry.type}:${entry.hash || Date.now().toString(36)}`,
    timestamp: entry.timestamp ?? Date.now(),
  };

  const current = readAll();
  const withoutDuplicate = current.filter(
    (item) =>
      !(
        item.hash &&
        next.hash &&
        item.hash === next.hash &&
        item.marginAccountAddress === next.marginAccountAddress &&
        item.type === next.type &&
        item.asset === next.asset
      )
  );
  writeAll([next, ...withoutDuplicate]);
};

export const getMarginHistoryByAccount = (marginAccountAddress?: string | null): MarginHistoryEntry[] => {
  if (!marginAccountAddress) return [];
  return readAll()
    .filter((item) => item.marginAccountAddress === marginAccountAddress)
    .sort((a, b) => b.timestamp - a.timestamp);
};
