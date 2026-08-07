/* ═══════════════════════════════════════════════════════════════════════
 * Lite-mode position registry (localStorage)
 *
 * Lite positions are user-initiated leveraged-yield strategies opened from
 * the "Deposit & Deploy" tab. They route through Vanna's margin account so
 * the borrow leg shows up alongside any Pro-mode debt in
 * borrowedBalances — but the user thinks of them as separate, scoped to a
 * specific Blend / Aquarius / Soroswap pool.
 *
 * The Lite "Position" tab needs to render ONLY positions opened via Lite,
 * not arbitrary Pro-mode borrows. We track them here, keyed by margin
 * account address, with the metadata needed to rebuild a LitePosition row
 * without consulting the margin store (which doesn't know which pool a
 * borrow was deployed into). On full exit we drop the record.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * One Lite-mode leveraged-yield position, persisted to localStorage. Carries
 * the open-time snapshot (amounts + USD values + APR assumptions) needed to
 * render a position row without re-deriving which pool a margin borrow funded.
 */
export interface LitePositionRecord {
  id: string;                   // unique id for this strategy deployment
  marginAccountAddress: string; // owning margin account
  poolId: string;               // e.g. "xlm-blend"
  poolLabel: string;            // e.g. "XLM"
  protocol: string;             // "Blend" / "Aquarius" / "Soroswap"
  poolVersion: string;          // "V1" / "DEX"
  poolType: "single" | "lp";
  poolTokens: string[];         // ["XLM"] or ["XLM","USDC"]
  collateralAsset: string;
  collateralAmount: number;     // initial deposit, asset units
  collateralUsdAtOpen: number;  // priced at deployment time
  borrowAsset: string;
  borrowAmount: number;         // initial borrow, asset units
  borrowUsdAtOpen: number;
  /** Extra same-asset-as-collateral borrow (LP leverage > 1 only) — scales
   *  the collateral leg to stay on the pool's ratio; see one-click-strategy.ts. */
  collateralBorrowAmount?: number;
  collateralBorrowUsdAtOpen?: number;
  leverage: number;
  supplyApr: number;
  vannaFeeApr: number;
  liquidationLtv: number;
  isSameAsset: boolean;
  openedAt: number;             // ms timestamp
  txHash?: string;
}

const STORAGE_KEY = "vanna_lite_positions_v1";

const isBrowser = () => typeof window !== "undefined";

const readAll = (): LitePositionRecord[] => {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === "object") : [];
  } catch {
    return [];
  }
};

const CHANGE_EVENT = "vanna:lite-positions-changed";

const writeAll = (records: LitePositionRecord[]): void => {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  // Same-tab listeners: localStorage's `storage` event only fires on OTHER
  // tabs, so subscribers in this tab need a custom event to re-render.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
};

/**
 * Subscribe to Lite-position changes. Listens to both the same-tab custom event
 * and cross-tab `storage` events. Returns an unsubscribe function; no-op on the
 * server (SSR-safe).
 */
export const subscribeLitePositions = (cb: () => void): (() => void) => {
  if (!isBrowser()) return () => {};
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
};

/**
 * Persist a new Lite position. Fills in `id` and `openedAt` when not supplied,
 * appends to the stored list, and notifies subscribers. Returns the full record
 * (with generated fields). No-op on the server.
 */
export const appendLitePosition = (record: Omit<LitePositionRecord, "id" | "openedAt"> & { id?: string; openedAt?: number }): LitePositionRecord => {
  const full: LitePositionRecord = {
    ...record,
    id: record.id ?? `lite-${record.marginAccountAddress}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    openedAt: record.openedAt ?? Date.now(),
  };
  writeAll([...readAll(), full]);
  return full;
};

/**
 * Return the Lite positions for one margin account, newest first. Empty array
 * for a null/undefined address or on the server.
 */
export const getLitePositions = (marginAccountAddress: string | null | undefined): LitePositionRecord[] => {
  if (!marginAccountAddress) return [];
  return readAll()
    .filter((r) => r.marginAccountAddress === marginAccountAddress)
    .sort((a, b) => b.openedAt - a.openedAt);
};

/**
 * Apply a partial / full exit to a tracked position. Removes the record on
 * full exit; on partial exit, scales collateral/borrow down by `(1 - pct)`.
 */
export const applyLiteExit = (id: string, exitPct: number): void => {
  const all = readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const pct = Math.max(0, Math.min(100, exitPct));
  if (pct >= 100) {
    all.splice(idx, 1);
  } else {
    const remaining = (100 - pct) / 100;
    const r = all[idx];
    all[idx] = {
      ...r,
      collateralAmount: r.collateralAmount * remaining,
      collateralUsdAtOpen: r.collateralUsdAtOpen * remaining,
      borrowAmount: r.borrowAmount * remaining,
      borrowUsdAtOpen: r.borrowUsdAtOpen * remaining,
      collateralBorrowAmount: r.collateralBorrowAmount ? r.collateralBorrowAmount * remaining : r.collateralBorrowAmount,
      collateralBorrowUsdAtOpen: r.collateralBorrowUsdAtOpen ? r.collateralBorrowUsdAtOpen * remaining : r.collateralBorrowUsdAtOpen,
    };
  }
  writeAll(all);
};

/** Delete a single tracked position by id (regardless of exit state). */
export const removeLitePosition = (id: string): void => {
  writeAll(readAll().filter((r) => r.id !== id));
};

/** Delete every tracked position for a given margin account. */
export const clearLitePositions = (marginAccountAddress: string): void => {
  writeAll(readAll().filter((r) => r.marginAccountAddress !== marginAccountAddress));
};
