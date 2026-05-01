export type FarmProtocol = "blend" | "aquarius" | "soroswap";
export type FarmAction = "add" | "remove";

export interface FarmHistoryEntry {
  id: string;
  protocol: FarmProtocol;
  poolKey: string;
  marginAccountAddress: string;
  action: FarmAction;
  amountDisplay: string;
  txHash: string;
  timestamp: number;
}

const STORAGE_KEY = "vanna_farm_history_v1";
const MAX_ITEMS = 100;

const isBrowser = () => typeof window !== "undefined";

export const buildFarmPoolKey = (tokenA: string, tokenB?: string) => {
  const first = tokenA.toUpperCase();
  if (!tokenB) return first;
  return [first, tokenB.toUpperCase()].sort().join("-");
};

const readAll = (): FarmHistoryEntry[] => {
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

const writeAll = (entries: FarmHistoryEntry[]) => {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ITEMS)));
};

export const appendFarmHistory = (
  entry: Omit<FarmHistoryEntry, "id" | "timestamp"> & Partial<Pick<FarmHistoryEntry, "timestamp">>
) => {
  if (!isBrowser()) return;
  const next: FarmHistoryEntry = {
    ...entry,
    id: `${entry.protocol}:${entry.poolKey}:${entry.txHash || Date.now().toString(36)}`,
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

export const getFarmHistory = ({
  protocol,
  poolKey,
  marginAccountAddress,
}: {
  protocol: FarmProtocol;
  poolKey: string;
  marginAccountAddress: string | null | undefined;
}) => {
  if (!marginAccountAddress) return [];
  return readAll()
    .filter(
      (item) =>
        item.protocol === protocol &&
        item.poolKey === poolKey &&
        item.marginAccountAddress === marginAccountAddress
    )
    .sort((a, b) => b.timestamp - a.timestamp);
};
