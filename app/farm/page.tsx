"use client";

import { Table } from "@/components/earn/table";
import { AccountStats } from "@/components/margin/account-stats";
import { Carousel } from "@/components/ui/carousel";
import {
  FARM_STATS_ITEMS,
  farmTableHeadings,
  singleAssetTableHeadings,
} from "@/lib/constants/farm";
import { useUserStore } from "@/store/user";
import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFarmStore } from "@/store/farm-store";
import { useBlendPoolStats, useUserBlendPositions, useAllAquariusPoolStats, useAllAquariusLpPositions } from "@/hooks/use-farm";
import { useAllSoroswapPoolStats, useSoroswapPoolStats, useSoroswapLpPosition } from "@/hooks/use-soroswap";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { AQUARIUS_POOLS } from "@/lib/aquarius-utils";

function fmtNum(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(decimals)}B`;
  if (value >= 1_000_000)     return `${(value / 1_000_000).toFixed(decimals)}M`;
  if (value >= 1_000)         return `${(value / 1_000).toFixed(decimals)}K`;
  return value.toFixed(decimals);
}

export default function FarmPage() {
  const [activeFilterTab, setActiveFilterTab] = useState<string>("lending-single-assets");
  const [activePositionFilterTab, setActivePositionFilterTab] = useState<string>("current-position");
  const [activeTab, setActiveTab] = useState<string>("vaults");
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
          { title: s ? `${fmtNum(parseFloat(s.totalSupply))} ${symbol}` : (loading ? '...' : '0') },
          { title: s ? fmt(s.supplyAPY, '%') : '0' },
          { title: s ? fmt(s.borrowAPY, '%') : '0' },
          { title: s ? fmt(s.utilizationRate, '%') : '0' },
          { title: s ? fmt(s.bRate) : '0' },
        ],
      };
    });
    return { rows };
  }, [poolStats, statsLoading]);

  // Build positions table from user's Blend + Soroswap + Aquarius holdings
  const positionsTableBody = useMemo(() => {
    const rows: any[] = [];

    // Blend single-asset positions
    (['XLM', 'USDC'] as const)
      .filter((sym) => parseFloat(userPositions[sym]?.underlyingValue ?? '0') > 0)
      .forEach((sym) => {
        const pos = userPositions[sym];
        rows.push({
          cell: [
            { chain: sym, title: sym, tags: ['Blend', 'Supply'] },
            { title: 'Blend' },
            { title: pos.underlyingValue ? `${pos.underlyingValue} ${sym}` : '0' },
            { title: pos.bTokenBalance ? `${pos.bTokenBalance} b${sym}` : '0' },
            { title: poolStats[sym]?.supplyAPY ? `${poolStats[sym]!.supplyAPY}%` : '0' },
            { title: '0' },
            { title: '0' },
            { title: poolStats[sym]?.bRate ?? '0' },
          ],
        });
      });

    // Soroswap LP position
    if (mySSLpBalance > 0) {
      const totalShares = parseFloat(ssStats?.totalShares ?? '0');
      const ratio = totalShares > 0 ? mySSLpBalance / totalShares : 0;
      const xlmShare = (ratio * parseFloat(ssStats?.reserveXLM ?? '0')).toFixed(2);
      const usdcShare = (ratio * parseFloat(ssStats?.reserveUSDC ?? '0')).toFixed(2);
      rows.push({
        id: 'soroswap-xlm-usdc',
        cell: [
          { chain: 'XLM', titles: ['XLM', 'USDC'], tags: ['Soroswap', 'LP'] },
          { title: 'Soroswap' },
          { title: `${mySSLpBalance.toFixed(2)} LP` },
          { title: `${xlmShare} XLM + ${usdcShare} USDC` },
          { title: ssStats?.feeFraction ?? '0.30%' },
          { title: '0' },
          { title: '0' },
          { title: '0' },
        ],
      });
    }

    // Aquarius LP positions
    AQUARIUS_POOLS.forEach((pool) => {
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? '0');
      if (lpBal <= 0) return;
      const aqPoolStats = aquariusPools.find((p) => p.pool.id === pool.id)?.stats ?? null;
      const totalShares = parseFloat(aqPoolStats?.totalShares ?? '0');
      const ratio = totalShares > 0 ? lpBal / totalShares : 0;
      const shareA = (ratio * parseFloat(aqPoolStats?.reserveA ?? '0')).toFixed(2);
      const shareB = (ratio * parseFloat(aqPoolStats?.reserveB ?? '0')).toFixed(2);
      const [tokenA, tokenB] = pool.tokens;
      rows.push({
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Aquarius', 'LP'] },
          { title: 'Aquarius' },
          { title: `${lpBal.toFixed(2)} LP` },
          { title: `${shareA} ${tokenA} + ${shareB} ${tokenB}` },
          { title: aqPoolStats?.feeFraction ?? '0.30%' },
          { title: '0' },
          { title: '0' },
          { title: '0' },
        ],
      });
    });

    return { rows };
  }, [userPositions, poolStats, mySSLpBalance, ssStats, aqLpPositions, aquariusPools]);

  // Build LP/Multiple Assets table from live Aquarius + Soroswap pool data
  const lpTableBody = useMemo(() => {
    const aqRows = aquariusPools.map(({ pool, stats, isLoading }) => {
      const [tokenA, tokenB] = pool.tokens;
      const loading = isLoading;
      const tvlTitle = stats
        ? `${fmtNum(parseFloat(stats.reserveA))} ${tokenA}`
        : loading ? '...' : '0';
      const tvlDescription = stats
        ? `+ ${fmtNum(parseFloat(stats.reserveB))} ${tokenB}`
        : undefined;
      const fee = stats ? stats.feeFraction : loading ? '...' : '0';
      const shares = stats ? `${fmtNum(parseFloat(stats.totalShares))} LP` : loading ? '...' : '0';
      return {
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Aquarius', pool.feeFraction / 100 + '%', 'Testnet'] },
          { title: 'Aquarius' },
          { title: shares },
          { title: tvlTitle, description: tvlDescription },
          { title: fee },
          { title: '0' },
          { title: '0' },
          { title: '0' },
          { title: '0' },
        ],
      };
    });

    const ssRows = soroswapPools.map(({ pool, stats, isLoading }) => {
      const [tokenA, tokenB] = pool.tokens;
      const loading = isLoading;
      const tvlTitle = stats
        ? `${fmtNum(parseFloat(stats.reserveXLM))} ${tokenA}`
        : loading ? '...' : '0';
      const tvlDescription = stats
        ? `+ ${fmtNum(parseFloat(stats.reserveUSDC))} ${tokenB}`
        : undefined;
      const shares = stats ? `${fmtNum(parseFloat(stats.totalShares))} LP` : loading ? '...' : '0';
      return {
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Soroswap', pool.feeFraction / 100 + '%', 'Testnet'] },
          { title: 'Soroswap' },
          { title: shares },
          { title: tvlTitle, description: tvlDescription },
          { title: loading ? '...' : stats ? `${pool.feeFraction / 100}%` : '0' },
          { title: '0' },
          { title: '0' },
          { title: '0' },
          { title: '0' },
        ],
      };
    });

    return { rows: [...ssRows, ...aqRows] };
  }, [aquariusPools, soroswapPools]);

  // Live farm stats values — sum across Blend + Soroswap + Aquarius
  const farmStatsValues = useMemo(() => {
    const blendXlm  = parseFloat(userPositions.XLM?.underlyingValue  ?? '0');
    const blendUsdc = parseFloat(userPositions.USDC?.underlyingValue ?? '0');

    const ssTotalShares = parseFloat(ssStats?.totalShares ?? '0');
    const ssRatio = ssTotalShares > 0 ? mySSLpBalance / ssTotalShares : 0;
    const ssXlm  = ssRatio * parseFloat(ssStats?.reserveXLM  ?? '0');
    const ssUsdc = ssRatio * parseFloat(ssStats?.reserveUSDC ?? '0');

    let aqValue = 0;
    aquariusPools.forEach(({ pool, stats }) => {
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? '0');
      if (lpBal > 0 && stats) {
        const ratio = parseFloat(stats.totalShares) > 0 ? lpBal / parseFloat(stats.totalShares) : 0;
        aqValue += ratio * (parseFloat(stats.reserveA) + parseFloat(stats.reserveB));
      }
    });

    const total = blendXlm + blendUsdc + ssXlm + ssUsdc + aqValue;
    return {
      depositTVL: total > 0 ? `${total.toFixed(2)} XLM` : '0',
      earnings: '0',
      netFarmApy: '0',
      pendingRewards: '0',
    };
  }, [userPositions, mySSLpBalance, ssStats, aqLpPositions, aquariusPools]);


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
    const tabType = activeFilterTab === "lending-single-assets" ? "single" : "multi";
    const rowId = row.id ||
      row.cell?.[0]?.title?.toLowerCase().replace(/\s+/g, "-") ||
      row.cell?.[0]?.titles?.join("-").toLowerCase().replace(/\s+/g, "-") ||
      `row-${rowIndex}`;
    setFarmData({ selectedRow: row, tabType });
    router.push(`/farm/${rowId}`);
  }, [activeFilterTab, router, setFarmData]);

  const tableData = useMemo(() => {
    if (activeTab === "positions") {
      return {
        headings: singleAssetTableHeadings,
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
          supplyApyLabel: activeFilterTab === "lending-single-assets" ? "Provider TVL" : "Vanna TVL",
          filterTabType: activeTab === "positions" ? "solid" : "ghost"
        }}
        filterTabTypeOptions={filterTabTypeOptions}
        activeFilterTab={currentActiveFilterTab}
        onFilterTabTypeChange={handleFilterTabChange}
        tableHeadings={tableData.headings}
        tableBody={tableData.body}
        onRowClick={activeTab === "vaults" ? handleRowClick : undefined}
      />
      </section>
    </main>
  );
}
