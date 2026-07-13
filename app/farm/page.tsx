"use client";

import { Table } from "@/components/earn/table";
import { AccountStats } from "@/components/margin/account-stats";
import { Carousel } from "@/components/ui/carousel";
import {
  FARM_STATS_ITEMS,
  farmTableHeadings,
  singleAssetTableHeadings,
  positionsTableHeadings,
} from "@/lib/constants/farm";
import { useUserStore } from "@/store/user";
import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFarmStore } from "@/store/farm-store";
import { useBlendPoolStats, useUserBlendPositions, useAllAquariusPoolStats, useAllAquariusLpPositions } from "@/hooks/use-farm";
import { useAllSoroswapPoolStats, useSoroswapPoolStats, useSoroswapLpPosition } from "@/hooks/use-soroswap";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { AQUARIUS_POOLS, aquariusLpUnderlyingAmounts } from "@/lib/aquarius-utils";
import { useTokenPrices } from "@/hooks/use-token-prices";

function fmtNum(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(decimals)}B`;
  if (value >= 1_000_000)     return `${(value / 1_000_000).toFixed(decimals)}M`;
  if (value >= 1_000)         return `${(value / 1_000).toFixed(decimals)}K`;
  return value.toFixed(decimals);
}

// Pretty-print a pool_type from the Aquarius API into UI text. Soroswap is
// always xy=k (constant product), so its rows hardcode "Constant Product".
const formatPoolType = (raw?: string): string => {
  switch ((raw || "").toLowerCase()) {
    case "constant_product": return "Constant Product";
    case "stable":           return "Stable";
    case "concentrated":     return "Concentrated";
    default:                 return raw ? raw : "—";
  }
};

// Format an Aquarius API APY string (decimal, e.g. "0.0234") into "2.34%".
const formatApyDecimalString = (raw?: string): string => {
  const n = parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return "0%";
  return `${(n * 100).toFixed(2)}%`;
};

// Pools to hide from the LP table by default. The user can toggle them on
// via the "Hide pools" filter (renders as the "All Pools" dropdown).
// Only XLM/USDC pairs (Soroswap + Aquarius) are useful right now; the
// other Aquarius testnet pairs have stale/unrelated data.
const DEFAULT_HIDDEN_POOL_IDS = new Set<string>([
  "aquarius-xlm-aqua",
  "aquarius-xlm-usdt",
]);

export default function FarmPage() {
  const [activeFilterTab, setActiveFilterTab] = useState<string>("lending-single-assets");
  const [activePositionFilterTab, setActivePositionFilterTab] = useState<string>("current-position");
  const [activeTab, setActiveTab] = useState<string>("vaults");
  // When false (default), DEFAULT_HIDDEN_POOL_IDS are filtered out of the
  // LP table; the user flips this from the All Pools / Hide pools toggle.
  const [showHiddenPools, setShowHiddenPools] = useState(false);
  const userAddress = useUserStore((state) => state.address);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  // Blend
  const { stats: poolStats, isLoading: statsLoading } = useBlendPoolStats();
  const { positions: userPositions } = useUserBlendPositions();
  // Aquarius & Soroswap pool lists (all pools)
  const aquariusPools = useAllAquariusPoolStats();
  const soroswapPools = useAllSoroswapPoolStats();
  // User LP positions
  const { stats: ssStats } = useSoroswapPoolStats(Boolean(marginAccountAddress));
  const { lpBalance: ssLpBalanceRaw } = useSoroswapLpPosition(marginAccountAddress);
  const mySSLpBalance = parseFloat(ssLpBalanceRaw ?? '0');
  const { positions: aqLpPositions } = useAllAquariusLpPositions(marginAccountAddress);

  // Build real single-asset table rows from live pool data
  const singleAssetTableBody = useMemo(() => {
    const assets = ['XLM', 'USDC'] as const;
    const rows = assets.map((symbol) => {
      const s = poolStats[symbol];
      const loading = statsLoading;
      const fmt = (v: string | undefined, suffix = '') =>
        loading ? '...' : v ? `${v}${suffix}` : '0';

      return {
        cell: [
          { chain: symbol, title: symbol, tags: ['Blend', 'Supply'] },
          { title: 'Blend' },
          { title: s ? `${fmtNum(parseFloat(s.totalSupply))} ${symbol}` : (loading ? '...' : '0') },
          { title: s ? `${fmtNum(parseFloat(s.totalBorrow))} ${symbol}` : (loading ? '...' : '0') },
          { title: s ? fmt(s.supplyAPY, '%') : '0' },
          { title: s ? fmt(s.borrowAPY, '%') : '0' },
          { title: s ? fmt(s.utilizationRate, '%') : '0' },
        ],
      };
    });
    return { rows };
  }, [poolStats, statsLoading]);

  // Build positions table from user's Blend + Soroswap + Aquarius holdings
  const positionsTableBody = useMemo(() => {
    const rows: any[] = [];

    // Blend single-asset positions. Dust threshold (1e-4 token) hides
    // stroop-level rounding residue left over after 100% withdrawals so
    // the table doesn't show "0.00 LP / $0.00" ghost rows.
    const POSITION_DUST = 1e-4;
    (['XLM', 'USDC'] as const)
      .filter((sym) => parseFloat(userPositions[sym]?.underlyingValue ?? '0') > POSITION_DUST)
      .forEach((sym) => {
        const pos = userPositions[sym];
        rows.push({
          id: sym.toLowerCase(),
          cell: [
            { chain: sym, title: sym, tags: ['Blend', 'Supply'] },
            { title: 'Blend' },
            {
              title: pos.underlyingValue ? `${pos.underlyingValue} ${sym}` : '0',
              description: pos.bTokenBalance ? `${pos.bTokenBalance} b${sym}` : undefined,
            },
            { title: poolStats[sym]?.supplyAPY ? `${poolStats[sym]!.supplyAPY}%` : '0' },
          ],
        });
      });

    // Soroswap LP position
    if (mySSLpBalance > POSITION_DUST) {
      const totalShares = parseFloat(ssStats?.totalShares ?? '0');
      const ratio = totalShares > 0 ? mySSLpBalance / totalShares : 0;
      const xlmShare = (ratio * parseFloat(ssStats?.reserveXLM ?? '0')).toFixed(2);
      const usdcShare = (ratio * parseFloat(ssStats?.reserveUSDC ?? '0')).toFixed(2);
      rows.push({
        id: 'soroswap-xlm-usdc',
        cell: [
          { chain: 'XLM', titles: ['XLM', 'USDC'], tags: ['Soroswap', 'LP'] },
          { title: 'Soroswap' },
          {
            title: `${mySSLpBalance.toFixed(2)} LP`,
            description: `${xlmShare} XLM + ${usdcShare} USDC`,
          },
          { title: ssStats?.feeFraction ?? '0.30%' },
        ],
      });
    }

    // Aquarius LP positions
    AQUARIUS_POOLS.forEach((pool) => {
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? '0');
      if (lpBal <= POSITION_DUST) return;
      const aqPoolStats = aquariusPools.find((p) => p.pool.id === pool.id)?.stats ?? null;
      const totalShares = parseFloat(aqPoolStats?.totalShares ?? '0');
      const [tokenA, tokenB] = pool.tokens;
      const { amountA: shareA, amountB: shareB } = aquariusLpUnderlyingAmounts(
        lpBal,
        aqPoolStats ?? { reserveA: '0', reserveB: '0', totalShares: '0', feeFraction: '0.30%', feeRaw: 30 },
        tokenA,
        tokenB,
      );
      rows.push({
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Aquarius', 'LP'] },
          { title: 'Aquarius' },
          {
            title: `${lpBal.toFixed(2)} LP`,
            description: `${shareA.toFixed(2)} ${tokenA} + ${shareB.toFixed(2)} ${tokenB}`,
          },
          { title: aqPoolStats?.feeFraction ?? '0.30%' },
        ],
      });
    });

    return { rows };
  }, [userPositions, poolStats, mySSLpBalance, ssStats, aqLpPositions, aquariusPools]);

  // Build LP/Multiple Assets table from live Aquarius + Soroswap pool data.
  // Column order matches farmTableHeadings:
  //   Pool · DEX · DEX LP TVL · DEX TVL Token 0 · DEX TVL Token 1 ·
  //   Pool APR · 24h APY · Fees · Pool Type
  const lpTableBody = useMemo(() => {
    const aqRows = aquariusPools.map(({ pool, stats, isLoading }) => {
      const [tokenA, tokenB] = pool.tokens;
      const loading = isLoading;
      const tvlTokenA = stats ? `${fmtNum(parseFloat(stats.reserveA))} ${tokenA}` : (loading ? '...' : '0');
      const tvlTokenB = stats ? `${fmtNum(parseFloat(stats.reserveB))} ${tokenB}` : (loading ? '...' : '0');
      const fee = stats ? stats.feeFraction : (loading ? '...' : '0%');
      const shares = stats ? `${fmtNum(parseFloat(stats.totalShares))} LP` : (loading ? '...' : '0');
      // Pool APR uses the API's base trading APY (annualised from fees);
      // 24h APY shows total APY (base + incentives + rewards) which Aquarius
      // already exposes as a rolling figure on their dashboard.
      const poolApr = formatApyDecimalString(stats?.apy);
      const apy24h = formatApyDecimalString(stats?.totalApy);
      const poolType = formatPoolType(stats?.poolType);
      return {
        id: pool.id,
        cell: [
          // Single DEX name tag below the pool name — gives the row the same
          // visual height as the single-asset "Blend Supply" rows without
          // re-introducing the noisy "0.30% / Testnet" badges the user removed.
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Aquarius'] },
          { title: 'Aquarius' },
          { title: shares },
          { title: tvlTokenA },
          { title: tvlTokenB },
          { title: poolApr },
          { title: apy24h },
          { title: fee },
          { title: poolType },
        ],
      };
    });

    const ssRows = soroswapPools.map(({ pool, stats, isLoading }) => {
      const [tokenA, tokenB] = pool.tokens;
      const loading = isLoading;
      const tvlTokenA = stats ? `${fmtNum(parseFloat(stats.reserveXLM))} ${tokenA}` : (loading ? '...' : '0');
      const tvlTokenB = stats ? `${fmtNum(parseFloat(stats.reserveUSDC))} ${tokenB}` : (loading ? '...' : '0');
      const shares = stats ? `${fmtNum(parseFloat(stats.totalShares))} LP` : (loading ? '...' : '0');
      const fee = stats ? stats.feeFraction : (loading ? '...' : `${(pool.feeFraction / 100).toFixed(2)}%`);
      // Soroswap's public testnet API doesn't expose APY/volume yet, so
      // these show 0% until we wire it up; pool type is xy=k constant
      // product across all Soroswap pairs.
      return {
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Soroswap'] },
          { title: 'Soroswap' },
          { title: shares },
          { title: tvlTokenA },
          { title: tvlTokenB },
          { title: '0%' },
          { title: '0%' },
          { title: fee },
          { title: 'Constant Product' },
        ],
      };
    });

    const allRows = [...ssRows, ...aqRows];
    const visibleRows = showHiddenPools
      ? allRows
      : allRows.filter((r) => !DEFAULT_HIDDEN_POOL_IDS.has(r.id));
    return { rows: visibleRows };
  }, [aquariusPools, soroswapPools, showHiddenPools]);

  // Live USD prices for the assets that show up in farm positions. Aquarius
  // pools include AQUA and USDT alongside the XLM/USDC defaults; useTokenPrices
  // already aliases USDC variants (BLUSDC/AqUSDC/SoUSDC) to the USDC oracle
  // entry, so we only need to list the canonical symbols.
  const farmTokenPrices = useTokenPrices(["XLM", "USDC", "AQUA", "USDT"]);

  // Live farm stats values — sum across Blend + Soroswap + Aquarius, in USD
  // so the header card matches the margin page's dollar-denominated display.
  const farmStatsValues = useMemo(() => {
    const xlmPrice  = farmTokenPrices.XLM  ?? 0;
    const usdcPrice = farmTokenPrices.USDC ?? 1;
    const aquaPrice = farmTokenPrices.AQUA ?? 0;
    const usdtPrice = farmTokenPrices.USDT ?? 1;
    // Aquarius/Soroswap reserves come back symbol-neutral (reserveA/reserveB),
    // so we look up the price by the configured token symbol per pool.
    const priceFor = (sym: string): number => {
      const s = sym.toUpperCase();
      if (s === "XLM") return xlmPrice;
      if (s === "USDC" || s === "BLUSDC" || s === "AQUSDC" || s === "SOUSDC") return usdcPrice;
      if (s === "AQUA") return aquaPrice;
      if (s === "USDT") return usdtPrice;
      return 0;
    };

    const blendXlmUsd  = parseFloat(userPositions.XLM?.underlyingValue  ?? '0') * xlmPrice;
    const blendUsdcUsd = parseFloat(userPositions.USDC?.underlyingValue ?? '0') * usdcPrice;

    const ssTotalShares = parseFloat(ssStats?.totalShares ?? '0');
    const ssRatio = ssTotalShares > 0 ? mySSLpBalance / ssTotalShares : 0;
    const ssXlmUsd  = ssRatio * parseFloat(ssStats?.reserveXLM  ?? '0') * xlmPrice;
    const ssUsdcUsd = ssRatio * parseFloat(ssStats?.reserveUSDC ?? '0') * usdcPrice;

    let aqValueUsd = 0;
    aquariusPools.forEach(({ pool, stats }) => {
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? '0');
      if (lpBal > 0 && stats) {
        const totalShares = parseFloat(stats.totalShares);
        const ratio = totalShares > 0 ? lpBal / totalShares : 0;
        const [tokenA, tokenB] = pool.tokens;
        aqValueUsd +=
          ratio * parseFloat(stats.reserveA) * priceFor(tokenA) +
          ratio * parseFloat(stats.reserveB) * priceFor(tokenB);
      }
    });

    const totalUsd = blendXlmUsd + blendUsdcUsd + ssXlmUsd + ssUsdcUsd + aqValueUsd;
    return {
      depositTVL: totalUsd > 0
        ? `$${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '$0.00',
      earnings: '$0.00',
      netFarmApy: '0%',
      pendingRewards: '$0.00',
    };
  }, [userPositions, mySSLpBalance, ssStats, aqLpPositions, aquariusPools, farmTokenPrices]);


  // Get filter tab type options based on active tab
  const filterTabTypeOptions = useMemo(() => {
    if (activeTab === "positions") {
      return [
        { id: "current-position", label: "Current Position" },
        { id: "position-history", label: "Position History" }
      ];
    }
    return [
      { id: "lp-multiple-assets", label: "LP/Multiple Assets" },
      { id: "lending-single-assets", label: "Lending/Single Assets" }
    ];
  }, [activeTab]);

  const currentActiveFilterTab = useMemo(() => {
    if (activeTab === "positions") return activePositionFilterTab;
    return activeFilterTab;
  }, [activeTab, activeFilterTab, activePositionFilterTab]);

  const handleFilterTabChange = useCallback((tabId: string) => {
    if (activeTab === "positions") {
      setActivePositionFilterTab(tabId);
    } else {
      setActiveFilterTab(tabId);
    }
  }, [activeTab]);

  const router = useRouter();
  const setFarmData = useFarmStore((state) => state.set);

  const handleRowClick = useCallback((row: any, rowIndex: number) => {
    // Vaults tab: derive from which filter sub-tab is active (single vs LP).
    // Positions tab has no such sub-tab — derive from the row's own protocol
    // tag instead (Blend => single-asset supply, Soroswap/Aquarius => LP).
    const tabType = activeTab === "positions"
      ? (row.cell?.[0]?.tags?.includes("Blend") ? "single" : "multi")
      : (activeFilterTab === "lending-single-assets" ? "single" : "multi");
    const rowId = row.id ||
      row.cell?.[0]?.title?.toLowerCase().replace(/\s+/g, "-") ||
      row.cell?.[0]?.titles?.join("-").toLowerCase().replace(/\s+/g, "-") ||
      `row-${rowIndex}`;
    setFarmData({ selectedRow: row, tabType });
    router.push(`/farm/${rowId}`);
  }, [activeTab, activeFilterTab, router, setFarmData]);

  const tableData = useMemo(() => {
    if (activeTab === "positions") {
      return {
        headings: positionsTableHeadings,
        body: positionsTableBody,
      };
    }
    if (activeFilterTab === "lending-single-assets") {
      return { headings: singleAssetTableHeadings, body: singleAssetTableBody };
    }
    return { headings: farmTableHeadings, body: lpTableBody };
  }, [activeTab, activeFilterTab, singleAssetTableBody, positionsTableBody, lpTableBody]);

  const farmCarouselItems = [
    {
      icon: "",
      title: "Farm DeFi Yields",
      description:
        "Provide liquidity to LP pools and single-asset vaults. Earn trading fees, protocol rewards, and bonus APY — all in one place.",
    },
    {
      icon: "",
      title: "LP & Single Asset Strategies",
      description:
        "Choose from multi-asset LP positions or simple single-asset lending. Flexible strategies to match your risk appetite.",
    },
    {
      icon: "",
      title: "Powered by Vanna Protocol",
      description:
        "All farm strategies are built on audited, battle-tested smart contracts. Your capital is always in your control.",
    },
  ];

  return (
    <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Carousel */}
      <section className="w-full pt-4 sm:pt-6 pb-4">
        <Carousel items={farmCarouselItems} autoplayInterval={5000} />
      </section>

      {/* Farm stats — only shown when wallet connected */}
      {userAddress && FARM_STATS_ITEMS.length > 0 && (
        <section className="w-full mb-6">
          <AccountStats
            items={FARM_STATS_ITEMS}
            values={farmStatsValues}
            gridCols="grid-cols-4"
          />
        </section>
      )}

      {/* Pool Table */}
      <section className="w-full pb-8">
      {/* Show-hidden-pools toggle: only meaningful on the LP/Multiple Assets
          tab. By default the table only lists XLM/USDC pools (Soroswap +
          Aquarius); this toggle reveals XLM/AQUA and XLM/USDT. */}
      {activeTab === "vaults" && activeFilterTab === "lp-multiple-assets" && (
        <div className="w-full pb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setShowHiddenPools((v) => !v)}
            className="text-xs font-medium text-[#703AE6] hover:text-[#5b2cc7] underline-offset-2 hover:underline"
          >
            {showHiddenPools ? "Hide extra pools" : "Show all pools"}
          </button>
        </div>
      )}
      <Table
        filterDropdownPosition="left"
        heading={{
          tabsItems: [
            { label: "Vaults", id: "vaults" },
            { label: "Positions", id: "positions" }
          ],
          tabType: "underline"
        }}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        filters={{
          allChainDropdown: true,
          filters: activeTab === "positions"
            ? []
            : ["Vaults"],
          supplyApyTab: activeTab === "positions" ? false : true,
          supplyApyLabel: activeFilterTab === "lending-single-assets" ? "Total Borrow" : "Vanna TVL",
          filterTabType: activeTab === "positions" ? "solid" : "ghost"
        }}
        filterTabTypeOptions={filterTabTypeOptions}
        activeFilterTab={currentActiveFilterTab}
        onFilterTabTypeChange={handleFilterTabChange}
        tableHeadings={tableData.headings}
        tableBody={tableData.body}
        onRowClick={handleRowClick}
      />
      </section>
    </main>
  );
}
