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
 *
 * This cache is a HINT, not a source of truth: for the two LP pools
 * (Aquarius/Soroswap XLM-USDC), `reconcileLiteLpPositionsWithChain` below
 * validates it against live on-chain state every time the Lite Position tab
 * loads — dropping stale records the position was actually closed
 * elsewhere, and reconstructing a best-effort position from chain data alone
 * when the cache is missing one that's real. A cleared cache (or a
 * different browser/device) degrades to a less precise view of a real
 * position, never a permanently-lost or unmanageable one.
 * ═══════════════════════════════════════════════════════════════════════ */

import { AquariusService, AQUARIUS_POOLS, aquariusLpUnderlyingAmounts } from "@/lib/aquarius-utils";
import { SoroswapService } from "@/lib/soroswap-utils";
import { fetchTokenPrice } from "@/lib/oracle-price";

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
  /** True for a position reconstructed live from chain state because no
   *  local record existed (cache cleared / different device). The
   *  collateral-vs-top-up-borrow split and true leverage can't be recovered
   *  from current state alone, so these are best-effort (leverage defaults
   *  to 1x, collateralBorrowAmount to 0) — real LP balance and current debt
   *  are still accurate, so it's fully manageable, just imprecise. */
  recovered?: boolean;
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

const LP_DUST = 1e-6;

/** The two Lite-manageable LP pools — matches POOL_OPTIONS in one-click-strategy.tsx. */
const LITE_LP_POOLS = [
  { poolId: "xlm-usdc-aquarius", protocol: "Aquarius", poolVersion: "AMM" },
  { poolId: "xlm-usdc-soroswap", protocol: "Soroswap", poolVersion: "DEX" },
] as const;

/** Real LP balance for one of the two Lite-manageable pools, human-readable. */
async function fetchRealLpBalance(poolId: string, marginAccountAddress: string): Promise<number> {
  if (poolId === "xlm-usdc-aquarius") {
    const bal = await AquariusService.getUserLpBalance(
      marginAccountAddress,
      AQUARIUS_POOLS.find((p) => p.id === "aquarius-xlm-usdc")?.poolAddress ?? "",
      "XLM",
      "USDC",
    );
    return parseFloat(bal) || 0;
  }
  const bal = await SoroswapService.getLpBalance(marginAccountAddress);
  return parseFloat(bal) || 0;
}

/** Underlying {xlm, usdc} for a real LP balance, via each pool's live reserves. */
async function fetchLpUnderlying(poolId: string, lpBalance: number): Promise<{ xlm: number; usdc: number }> {
  if (poolId === "xlm-usdc-aquarius") {
    const poolAddress = AQUARIUS_POOLS.find((p) => p.id === "aquarius-xlm-usdc")?.poolAddress ?? "";
    const stats = await AquariusService.getAquariusPoolStats(poolAddress);
    if (!stats) return { xlm: 0, usdc: 0 };
    const { amountA, amountB } = aquariusLpUnderlyingAmounts(lpBalance, stats, "XLM", "USDC");
    return { xlm: amountA, usdc: amountB };
  }
  const stats = await SoroswapService.getPoolStats();
  const totalShares = parseFloat(stats?.totalShares ?? "0");
  if (!stats || !(totalShares > 0)) return { xlm: 0, usdc: 0 };
  const ratio = lpBalance / totalShares;
  return {
    xlm: ratio * (parseFloat(stats.reserveXLM) || 0),
    usdc: ratio * (parseFloat(stats.reserveUSDC) || 0),
  };
}

/**
 * Reconciles the locally-cached Lite LP positions (Aquarius/Soroswap
 * XLM/USDC) against LIVE on-chain state for one margin account:
 *  - **Self-heals**: drops any cached record whose pool now has ~0 real LP
 *    balance — it was closed through some other path (e.g. a Pro-mode
 *    manual remove-liquidity), so keeping the stale record would show a
 *    permanent ghost position.
 *  - **Recovers**: when a pool has a real, nonzero LP balance but NO
 *    matching cached record (cache cleared, or opened from a different
 *    browser/device), synthesizes a best-effort position from live chain
 *    data alone, marked `recovered: true`. The collateral-vs-top-up-borrow
 *    split and true leverage can't be recovered from current state (only
 *    from the now-lost history of how it was opened) — leverage defaults to
 *    1x and the top-up leg to 0, but the real LP balance and its current
 *    underlying value are accurate, so the position is still fully visible
 *    and closable, just without the original leverage framing.
 *
 * Call this once when the Lite Position tab loads, before reading
 * {@link getLitePositions}. Never throws — a fetch failure just skips that
 * pool's reconciliation for this pass (the cached record, if any, still shows).
 */
export async function reconcileLiteLpPositionsWithChain(marginAccountAddress: string): Promise<void> {
  if (!marginAccountAddress) return;
  const cached = getLitePositions(marginAccountAddress);

  await Promise.all(
    LITE_LP_POOLS.map(async (pool) => {
      try {
        const realLp = await fetchRealLpBalance(pool.poolId, marginAccountAddress);
        const cachedForPool = cached.filter((r) => r.poolId === pool.poolId);

        if (!(realLp > LP_DUST)) {
          // Self-heal: no real position left, but the cache still thinks there is.
          for (const rec of cachedForPool) removeLitePosition(rec.id);
          return;
        }

        if (cachedForPool.length > 0) return; // cache already has it — trust the precise record

        // Recover: a real position exists with nothing cached for it.
        const { xlm, usdc } = await fetchLpUnderlying(pool.poolId, realLp);
        if (!(xlm > LP_DUST) && !(usdc > LP_DUST)) return;
        const [xlmPrice, usdcPrice] = await Promise.all([
          fetchTokenPrice("XLM").catch(() => 0),
          fetchTokenPrice("USDC").catch(() => 0),
        ]);
        const collateralUsd = xlm * xlmPrice;
        const borrowUsd = usdc * usdcPrice;

        appendLitePosition({
          id: `lite-recovered-${marginAccountAddress}-${pool.poolId}`,
          marginAccountAddress,
          poolId: pool.poolId,
          poolLabel: "XLM/USDC",
          protocol: pool.protocol,
          poolVersion: pool.poolVersion,
          poolType: "lp",
          poolTokens: ["XLM", "USDC"],
          collateralAsset: "XLM",
          collateralAmount: xlm,
          collateralUsdAtOpen: collateralUsd,
          borrowAsset: "USDC",
          borrowAmount: usdc,
          borrowUsdAtOpen: borrowUsd,
          collateralBorrowAmount: 0,
          collateralBorrowUsdAtOpen: 0,
          leverage: 1,
          supplyApr: 0,
          vannaFeeApr: 0,
          liquidationLtv: 82,
          isSameAsset: false,
          openedAt: Date.now(),
          recovered: true,
        });
      } catch (e) {
        console.warn(`[lite-positions] chain reconciliation failed for ${pool.poolId}:`, e);
      }
    }),
  );
}
