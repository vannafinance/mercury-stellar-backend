export type SpotProtocol = "aquarius" | "soroswap";

export interface SpotHistoryEntry {
  id: string;
  protocol: SpotProtocol;
  marginAccountAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  txHash: string;
  timestamp: number;
}

const STORAGE_KEY = "vanna_spot_history_v1";
const MAX_ITEMS = 200;

const isBrowser = () => typeof window !== "undefined";

const readAll = (): SpotHistoryEntry[] => {
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

const writeAll = (entries: SpotHistoryEntry[]) => {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ITEMS)));
};

/** Records one margin-account spot swap. Mirrors lib/farm-history.ts's shape
 * (local tx log, deduped by hash) so the Spot tab's history behaves the same
 * way Farm's and Lender's position history do. */
export const appendSpotHistory = (
  entry: Omit<SpotHistoryEntry, "id" | "timestamp"> & Partial<Pick<SpotHistoryEntry, "timestamp">>
) => {
  if (!isBrowser()) return;
  const next: SpotHistoryEntry = {
    ...entry,
    id: `${entry.protocol}:${entry.txHash || Date.now().toString(36)}`,
    timestamp: entry.timestamp ?? Date.now(),
  };

  const current = readAll();
  const withoutDuplicate = current.filter(
    (item) =>
      !(
        item.txHash &&
        next.txHash &&
        item.txHash === next.txHash &&
        item.marginAccountAddress === next.marginAccountAddress &&
        item.protocol === next.protocol
      )
  );

  writeAll([next, ...withoutDuplicate]);
};

export const getSpotHistory = (
  marginAccountAddress: string | null | undefined
): SpotHistoryEntry[] => {
  if (!marginAccountAddress) return [];
  return readAll()
    .filter((item) => item.marginAccountAddress === marginAccountAddress)
    .sort((a, b) => b.timestamp - a.timestamp);
};
