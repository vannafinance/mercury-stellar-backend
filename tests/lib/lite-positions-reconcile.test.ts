import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression guard for the Lite-position cache resilience fix.
 *
 * lib/lite-positions.ts's localStorage cache is a HINT, not a source of
 * truth: reconcileLiteLpPositionsWithChain validates it against live chain
 * state every time the Lite Position tab loads.
 *   - Self-heal: a cached position whose pool now has ~0 real LP balance
 *     (closed some other way) must be dropped — otherwise it's a permanent
 *     ghost position that survives forever.
 *   - Recover: a pool with a real, nonzero LP balance but nothing cached
 *     (cleared cache / different device) must be reconstructed from chain
 *     data alone, marked `recovered: true`, so it's still visible/manageable.
 *
 * The test environment has no `window` (plain Node), so lite-positions.ts's
 * own localStorage calls would silently no-op without this stub.
 */
const mocks = vi.hoisted(() => ({
  getUserLpBalance: vi.fn(),
  getAquariusPoolStats: vi.fn(),
  getLpBalance: vi.fn(),
  getPoolStats: vi.fn(),
  fetchTokenPrice: vi.fn(),
}));

vi.mock("@/lib/aquarius-utils", () => ({
  AquariusService: {
    getUserLpBalance: mocks.getUserLpBalance,
    getAquariusPoolStats: mocks.getAquariusPoolStats,
  },
  AQUARIUS_POOLS: [{ id: "aquarius-xlm-usdc", poolAddress: "CPOOLAQ", tokens: ["XLM", "USDC"] }],
  aquariusLpUnderlyingAmounts: (lp: number, stats: { totalShares: string; reserveA: string; reserveB: string }) => {
    const total = parseFloat(stats.totalShares);
    const ratio = total > 0 ? lp / total : 0;
    return { amountA: ratio * parseFloat(stats.reserveA), amountB: ratio * parseFloat(stats.reserveB) };
  },
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: {
    getLpBalance: mocks.getLpBalance,
    getPoolStats: mocks.getPoolStats,
  },
}));
vi.mock("@/lib/oracle-price", () => ({
  fetchTokenPrice: mocks.fetchTokenPrice,
}));

function stubBrowserStorage() {
  const store = new Map<string, string>();
  const listeners = new Set<() => void>();
  const win = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    dispatchEvent: () => {
      for (const l of listeners) l();
    },
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("CustomEvent", class {} as unknown as typeof CustomEvent);
  return store;
}

import {
  reconcileLiteLpPositionsWithChain,
  getLitePositions,
  appendLitePosition,
  type LitePositionRecord,
} from "@/lib/lite-positions";

const MARGIN_ACCOUNT = "CACCT";

const baseRecord = (): Omit<LitePositionRecord, "id" | "openedAt"> => ({
  marginAccountAddress: MARGIN_ACCOUNT,
  poolId: "xlm-usdc-aquarius",
  poolLabel: "XLM/USDC",
  protocol: "Aquarius",
  poolVersion: "AMM",
  poolType: "lp",
  poolTokens: ["XLM", "USDC"],
  collateralAsset: "XLM",
  collateralAmount: 10,
  collateralUsdAtOpen: 1.6,
  borrowAsset: "USDC",
  borrowAmount: 0.26,
  borrowUsdAtOpen: 0.26,
  collateralBorrowAmount: 10,
  collateralBorrowUsdAtOpen: 1.6,
  leverage: 2,
  supplyApr: 6,
  vannaFeeApr: 4,
  liquidationLtv: 82,
  isSameAsset: false,
});

describe("reconcileLiteLpPositionsWithChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubBrowserStorage();
    // No Soroswap position in any of these tests — real balance 0.
    mocks.getLpBalance.mockResolvedValue("0");
    mocks.getPoolStats.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("self-heals: drops a cached position whose real LP balance is now 0 (closed elsewhere)", async () => {
    appendLitePosition(baseRecord());
    expect(getLitePositions(MARGIN_ACCOUNT)).toHaveLength(1);

    mocks.getUserLpBalance.mockResolvedValue("0"); // closed via some other path

    await reconcileLiteLpPositionsWithChain(MARGIN_ACCOUNT);

    expect(getLitePositions(MARGIN_ACCOUNT)).toHaveLength(0);
  });

  it("leaves a cached position alone when its real LP balance is still nonzero", async () => {
    appendLitePosition(baseRecord());
    mocks.getUserLpBalance.mockResolvedValue("6.87");

    await reconcileLiteLpPositionsWithChain(MARGIN_ACCOUNT);

    const positions = getLitePositions(MARGIN_ACCOUNT);
    expect(positions).toHaveLength(1);
    expect(positions[0].recovered).toBeFalsy();
    expect(positions[0].leverage).toBe(2); // untouched — the precise cached record wins
  });

  it("recovers: reconstructs a position from live chain data when nothing is cached for a real position", async () => {
    expect(getLitePositions(MARGIN_ACCOUNT)).toHaveLength(0);

    mocks.getUserLpBalance.mockResolvedValue("6.87");
    mocks.getAquariusPoolStats.mockResolvedValue({
      totalShares: "12263.08",
      reserveA: "107341.13",
      reserveB: "1413.34",
    });
    mocks.fetchTokenPrice.mockImplementation((sym: string) => Promise.resolve(sym === "XLM" ? 0.16 : 1));

    await reconcileLiteLpPositionsWithChain(MARGIN_ACCOUNT);

    const positions = getLitePositions(MARGIN_ACCOUNT);
    expect(positions).toHaveLength(1);
    expect(positions[0].recovered).toBe(true);
    expect(positions[0].poolId).toBe("xlm-usdc-aquarius");
    expect(positions[0].collateralAsset).toBe("XLM");
    // 6.87/12263.08 * 107341.13 ≈ 60.16 XLM underlying
    expect(positions[0].collateralAmount).toBeCloseTo((6.87 / 12263.08) * 107341.13, 2);
    // Split unrecoverable from current state alone — best-effort defaults.
    expect(positions[0].collateralBorrowAmount).toBe(0);
    expect(positions[0].leverage).toBe(1);
  });

  it("does not duplicate a recovered position on repeated reconciliation calls", async () => {
    mocks.getUserLpBalance.mockResolvedValue("6.87");
    mocks.getAquariusPoolStats.mockResolvedValue({
      totalShares: "12263.08",
      reserveA: "107341.13",
      reserveB: "1413.34",
    });
    mocks.fetchTokenPrice.mockResolvedValue(1);

    await reconcileLiteLpPositionsWithChain(MARGIN_ACCOUNT);
    await reconcileLiteLpPositionsWithChain(MARGIN_ACCOUNT);

    expect(getLitePositions(MARGIN_ACCOUNT)).toHaveLength(1);
  });

  it("does nothing when there is neither a cached record nor a real position", async () => {
    mocks.getUserLpBalance.mockResolvedValue("0");

    await reconcileLiteLpPositionsWithChain(MARGIN_ACCOUNT);

    expect(getLitePositions(MARGIN_ACCOUNT)).toHaveLength(0);
  });
});
