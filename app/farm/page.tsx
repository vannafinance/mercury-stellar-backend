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

function fmtUsd(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Format an Aquarius API APY string (decimal, e.g. "0.0234") into "2.34%".
const formatApyDecimalString = (raw?: string): string => {
  const n = parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return "0%";
  return `${(n * 100).toFixed(2)}%`;
};

// Pools permanently excluded from the LP table — this Aquarius testnet
// pair has stale/unrelated data and isn't a real, usable pool.
const HIDDEN_POOL_IDS = new Set<string>([
  "aquarius-xlm-usdt",
]);

export default function FarmPage() {
  // Restore whichever Vaults sub-tab (LP/Multiple Assets vs Lending/Single
  // Assets) was active when the user last clicked into a pool detail page —
  // otherwise navigating back from a pool always reset to the default
  // "Lending/Single Assets" tab regardless of where the user actually was.
  // farm-store's tabType is set on every row click and isn't reset on
  // unmount, so it still holds the right value here on remount.
  const lastTabType = useFarmStore((state) => state.tabType);
  const [activeFilterTab, setActiveFilterTab] = useState<string>(
    () => (lastTabType === "multi" ? "lp-multiple-assets" : "lending-single-assets")
  );
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

  // Live USD prices for the assets that show up in farm positions. Aquarius
  // pools include USDT alongside the XLM/USDC defaults; useTokenPrices
  // already aliases USDC variants (BLUSDC/AqUSDC/SoUSDC) to the USDC oracle
  // entry, so we only need to list the canonical symbols. Read up-front (not
  // just where the header stats are built) since the Vaults tables' "Holding"
  // column below also needs a USD value for the user's per-pool position.
  const farmTokenPrices = useTokenPrices(["XLM", "USDC", "USDT"]);
  const priceForSymbol = useCallback((sym: string): number => {
    const s = sym.toUpperCase();
    if (s === "XLM") return farmTokenPrices.XLM ?? 0;
    if (s === "USDC" || s === "BLUSDC" || s === "AQUSDC" || s === "SOUSDC") return farmTokenPrices.USDC ?? 1;
    if (s === "USDT") return farmTokenPrices.USDT ?? 1;
    return 0;
  }, [farmTokenPrices]);

  const POSITION_DUST = 1e-4;

  // Build real single-asset table rows from live pool data
  const singleAssetTableBody = useMemo(() => {
    const assets = ['XLM', 'USDC'] as const;
    const rows = assets.map((symbol) => {
      const s = poolStats[symbol];
      const loading = statsLoading;
      const fmt = (v: string | undefined, suffix = '') =>
        loading ? '...' : v ? `${v}${suffix}` : '0';
      const holding = parseFloat(userPositions[symbol]?.underlyingValue ?? '0');
      const holdingAmount = holding > POSITION_DUST ? holding : 0;

      const price = priceForSymbol(symbol);
      const totalSupplyNum = s ? parseFloat(s.totalSupply) : 0;
      const totalBorrowNum = s ? parseFloat(s.totalBorrow) : 0;
      // Blend's canonical USDC label — matches the DropdownOptions/margin-page
      // convention instead of the generic "USDC" used as the underlying map key.
      const symbolLabel = symbol === 'USDC' ? 'BLUSDC' : symbol;

      return {
        cell: [
          // cell[0].title is read functionally by remove-liquidity.tsx's
          // getInitialToken() (matched against raw "XLM"/"USDC") — keep it
          // raw; symbolLabel is only safe in cell[2]/[3]/[6]'s amount strings.
          { chain: symbol, title: symbol, tags: ['Blend', 'Supply'] },
          { title: 'Blend' },
          {
            title: s ? `${fmtNum(totalSupplyNum)} ${symbolLabel}` : (loading ? '...' : '0'),
            tag: s ? fmtUsd(totalSupplyNum * price) : undefined,
          },
          {
            title: s ? `${fmtNum(totalBorrowNum)} ${symbolLabel}` : (loading ? '...' : '0'),
            tag: s ? fmtUsd(totalBorrowNum * price) : undefined,
          },
          { title: s ? fmt(s.supplyAPY, '%') : '0' },
          { title: s ? fmt(s.borrowAPY, '%') : '0' },
          { title: s ? fmt(s.utilizationRate, '%') : '0' },
          {
            title: `${fmtNum(holdingAmount)} ${symbolLabel}`,
            tag: fmtUsd(holdingAmount * price),
          },
        ],
      };
    });
    return { rows };
  }, [poolStats, statsLoading, userPositions, priceForSymbol]);

  // Build positions table from user's Blend + Soroswap + Aquarius holdings
  const positionsTableBody = useMemo(() => {
    const rows: any[] = [];

    // Blend single-asset positions. Dust threshold (1e-4 token) hides
    // stroop-level rounding residue left over after 100% withdrawals so
    // the table doesn't show "0.00 LP / $0.00" ghost rows.
    (['XLM', 'USDC'] as const)
      .filter((sym) => parseFloat(userPositions[sym]?.underlyingValue ?? '0') > POSITION_DUST)
      .forEach((sym) => {
        const pos = userPositions[sym];
        const symLabel = sym === 'USDC' ? 'BLUSDC' : sym;
        rows.push({
          id: sym.toLowerCase(),
          cell: [
            // cell[0].title is read functionally by remove-liquidity.tsx's
            // getInitialToken() — keep raw, matching the singleAssetTableBody note above.
            { chain: sym, title: sym, tags: ['Blend', 'Supply'] },
            { title: 'Blend' },
            {
              title: pos.underlyingValue ? `${pos.underlyingValue} ${symLabel}` : '0',
              // "b{sym}" is Blend's own internal receipt-token naming
              // (bXLM/bUSDC), unrelated to our AqUSDC/SoUSDC/BLUSDC
              // distinction — kept as the real underlying symbol.
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
          // NOTE: `titles` feeds the real Add/Remove Liquidity forms via
          // useFarmStore.selectedRow (components/farm/add-liquidity.tsx reads
          // cell[0].titles as the literal on-chain token symbols for balance
          // fetches and the actual addLiquidity/removeLiquidity calls) — keep
          // this the raw functional symbol, not the display label.
          { chain: 'XLM', titles: ['XLM', 'USDC'], tags: ['Soroswap', 'LP'] },
          { title: 'Soroswap' },
          {
            title: `${mySSLpBalance.toFixed(2)} LP`,
            description: `${xlmShare} XLM + ${usdcShare} SoUSDC`,
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
      const tokenBLabel = tokenB === 'USDC' ? 'AqUSDC' : tokenB;
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
            description: `${shareA.toFixed(2)} ${tokenA} + ${shareB.toFixed(2)} ${tokenBLabel}`,
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
  //   Pool APR · Fees · Holding
  const lpTableBody = useMemo(() => {
    const aqRows = aquariusPools.map(({ pool, stats, isLoading }) => {
      const [tokenA, tokenB] = pool.tokens;
      const tokenBLabel = tokenB === 'USDC' ? 'AqUSDC' : tokenB;
      const loading = isLoading;
      const reserveANum = stats ? parseFloat(stats.reserveA) : 0;
      const reserveBNum = stats ? parseFloat(stats.reserveB) : 0;
      const priceA = priceForSymbol(tokenA);
      const priceB = priceForSymbol(tokenB);
      const tvlTokenA = stats ? `${fmtNum(reserveANum)} ${tokenA}` : (loading ? '...' : '0');
      const tvlTokenB = stats ? `${fmtNum(reserveBNum)} ${tokenBLabel}` : (loading ? '...' : '0');
      const fee = stats ? stats.feeFraction : (loading ? '...' : '0%');
      const shares = stats ? `${fmtNum(parseFloat(stats.totalShares))} LP` : (loading ? '...' : '0');
      // Pool APR uses the API's base trading APY (annualised from fees).
      const poolApr = formatApyDecimalString(stats?.apy);
      // Total pool value, in USD, across both reserves — this is what "TVL"
      // means, even though the DEX LP TVL column's title shows LP share count.
      const poolTvlUsd = reserveANum * priceA + reserveBNum * priceB;

      // This pool's LP balance the user personally holds, valued via the pool's
      // own reserve ratio — same math used for the Positions tab's LP rows.
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? '0');
      const holdingAmount = lpBal > POSITION_DUST ? lpBal : 0;
      let holdingUsd = 0;
      if (holdingAmount > 0 && stats) {
        const totalShares = parseFloat(stats.totalShares);
        const ratio = totalShares > 0 ? holdingAmount / totalShares : 0;
        holdingUsd = ratio * reserveANum * priceA + ratio * reserveBNum * priceB;
      }

      return {
        id: pool.id,
        cell: [
          // Single DEX name tag below the pool name — gives the row the same
          // visual height as the single-asset "Blend Supply" rows without
          // re-introducing the noisy "0.30% / Testnet" badges the user removed.
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Aquarius'] },
          { title: 'Aquarius' },
          { title: shares, tag: stats ? fmtUsd(poolTvlUsd) : undefined },
          { title: tvlTokenA, tag: stats ? fmtUsd(reserveANum * priceA) : undefined },
          { title: tvlTokenB, tag: stats ? fmtUsd(reserveBNum * priceB) : undefined },
          { title: poolApr },
          { title: fee },
          {
            title: `${fmtNum(holdingAmount)} LP`,
            tag: fmtUsd(holdingUsd),
          },
        ],
      };
    });

    const ssRows = soroswapPools.map(({ pool, stats, isLoading }) => {
      const [tokenA, tokenB] = pool.tokens;
      const tokenBLabel = tokenB === 'USDC' ? 'SoUSDC' : tokenB;
      const loading = isLoading;
      const reserveANum = stats ? parseFloat(stats.reserveXLM) : 0;
      const reserveBNum = stats ? parseFloat(stats.reserveUSDC) : 0;
      const priceA = priceForSymbol(tokenA);
      const priceB = priceForSymbol(tokenB);
      const tvlTokenA = stats ? `${fmtNum(reserveANum)} ${tokenA}` : (loading ? '...' : '0');
      const tvlTokenB = stats ? `${fmtNum(reserveBNum)} ${tokenBLabel}` : (loading ? '...' : '0');
      const shares = stats ? `${fmtNum(parseFloat(stats.totalShares))} LP` : (loading ? '...' : '0');
      const fee = stats ? stats.feeFraction : (loading ? '...' : `${(pool.feeFraction / 100).toFixed(2)}%`);
      // Soroswap's public testnet API doesn't expose APY/volume yet, so
      // these show 0% until we wire it up.
      const poolTvlUsd = reserveANum * priceA + reserveBNum * priceB;

      // Only one Soroswap pool is tracked today, so its LP balance is the
      // margin account's whole Soroswap LP token balance (mySSLpBalance).
      const holdingAmount = mySSLpBalance > POSITION_DUST ? mySSLpBalance : 0;
      let holdingUsd = 0;
      if (holdingAmount > 0 && stats) {
        const totalShares = parseFloat(stats.totalShares);
        const ratio = totalShares > 0 ? holdingAmount / totalShares : 0;
        holdingUsd = ratio * reserveANum * priceA + ratio * reserveBNum * priceB;
      }

      return {
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ['Soroswap'] },
          { title: 'Soroswap' },
          { title: shares, tag: stats ? fmtUsd(poolTvlUsd) : undefined },
          { title: tvlTokenA, tag: stats ? fmtUsd(reserveANum * priceA) : undefined },
          { title: tvlTokenB, tag: stats ? fmtUsd(reserveBNum * priceB) : undefined },
          { title: '0%' },
          { title: fee },
          {
            title: `${fmtNum(holdingAmount)} LP`,
            tag: fmtUsd(holdingUsd),
          },
        ],
      };
    });

    const allRows = [...ssRows, ...aqRows];
    const visibleRows = allRows.filter((r) => !HIDDEN_POOL_IDS.has(r.id));
    return { rows: visibleRows };
  }, [aquariusPools, soroswapPools, aqLpPositions, mySSLpBalance, priceForSymbol]);

  // Live farm stats values — sum across Blend + Soroswap + Aquarius, in USD
  // so the header card matches the margin page's dollar-denominated display.
  const farmStatsValues = useMemo(() => {
    const xlmPrice  = farmTokenPrices.XLM  ?? 0;
    const usdcPrice = farmTokenPrices.USDC ?? 1;

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
          ratio * parseFloat(stats.reserveA) * priceForSymbol(tokenA) +
          ratio * parseFloat(stats.reserveB) * priceForSymbol(tokenB);
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
  }, [userPositions, mySSLpBalance, ssStats, aqLpPositions, aquariusPools, farmTokenPrices, priceForSymbol]);


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
