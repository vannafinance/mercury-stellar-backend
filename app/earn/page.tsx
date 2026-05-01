"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { CollapsibleChart } from "@/components/ui/collapsible-chart";
import { Table } from "@/components/earn/table";
import { Carousel } from "@/components/ui/carousel";
import { tableHeadings } from "@/lib/constants/earn";
import { useUserStore } from "@/store/user";
import { useEarnVaultStore } from "@/store/earn-vault-store";
import { setSelectedPool } from "@/store/selected-pool-store";
import { AssetType } from "@/lib/stellar-utils";
import { usePoolData, useUserPositions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/contexts/price-context";

const HISTORY_MAX_ITEMS = 3000;
const ALL_ASSETS = ["XLM", "USDC", "AQUARIUS_USDC", "SOROSWAP_USDC"] as const;

type EarnOverviewSnapshot = {
  timestamp: number;
  totalDepositedUSD: number;
  annualEarningsUSD: number;
};

const getHistoryKey = (address: string) => `vanna_earn_overview_history_v2_${address}`;

const normalizeTimestamp = (value: unknown): number => {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
};

const readOverviewHistory = (address: string): EarnOverviewSnapshot[] => {
  if (typeof window === "undefined" || !address) return [];
  try {
    const raw = window.localStorage.getItem(getHistoryKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .map((item) => ({
        timestamp: normalizeTimestamp(item?.timestamp),
        totalDepositedUSD: Number(item?.totalDepositedUSD ?? 0),
        annualEarningsUSD: Number(item?.annualEarningsUSD ?? 0),
      }))
      .filter((item) =>
        item.timestamp > 0 &&
        Number.isFinite(item.totalDepositedUSD) &&
        Number.isFinite(item.annualEarningsUSD)
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    // Remove transient refresh spikes: 0 sandwiched between two similar non-zero values.
    return normalized.filter((item, idx, arr) => {
      if (item.totalDepositedUSD !== 0 || idx === 0 || idx === arr.length - 1) return true;
      const prev = arr[idx - 1];
      const next = arr[idx + 1];
      const closeByTime =
        item.timestamp - prev.timestamp <= 5 * 60_000 &&
        next.timestamp - item.timestamp <= 5 * 60_000;
      const similarNeighbors = Math.abs(next.totalDepositedUSD - prev.totalDepositedUSD) <= 0.5;
      return !(prev.totalDepositedUSD > 0 && next.totalDepositedUSD > 0 && closeByTime && similarNeighbors);
    });
  } catch {
    return [];
  }
};

const writeOverviewHistory = (address: string, snapshots: EarnOverviewSnapshot[]) => {
  if (typeof window === "undefined" || !address) return;
  window.localStorage.setItem(getHistoryKey(address), JSON.stringify(snapshots.slice(-HISTORY_MAX_ITEMS)));
};

const toChartData = (
  snapshots: EarnOverviewSnapshot[],
  key: "totalDepositedUSD" | "annualEarningsUSD"
): Array<{ date: string; amount: number }> => {
  if (snapshots.length === 0) return [];
  const points = snapshots
    .map((item) => ({
      date: new Date(item.timestamp).toISOString(),
      amount: parseFloat((item[key] || 0).toFixed(2)),
    }))
    .filter((item) => Number.isFinite(item.amount));

  if (points.length >= 2) return points;

  const only = points[0];
  const firstTs = normalizeTimestamp(snapshots[0]?.timestamp);
  const prevTs = Math.max(firstTs - 60_000, firstTs - 1);
  return [
    { date: new Date(prevTs).toISOString(), amount: only.amount },
    only,
  ];
};

// Format a raw token amount into a compact human-readable string (e.g. 1250000 → "1.3M")
const formatTokenAmount = (amount: number): string => {
  if (amount <= 0) return "0";
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  return amount.toFixed(2);
};

// Build a single pool table row from live on-chain pool stats
const buildPoolRow = (
  assetSymbol: string,
  pool: {
    totalSupply: string;
    totalBorrowed: string;
    utilizationRate: string;
    supplyAPY: string;
    borrowAPY: string;
    isLoading?: boolean;
  },
  collateralIcons: string[]
) => {
  const totalSupply = parseFloat(pool.totalSupply) || 0;
  const totalBorrowed = parseFloat(pool.totalBorrowed) || 0;
  const utilizationRate = parseFloat(pool.utilizationRate) || 0;
  const supplyAPY = parseFloat(pool.supplyAPY) || 0;
  const borrowAPY = parseFloat(pool.borrowAPY) || 0;

  return {
    cell: [
      { chain: assetSymbol, title: assetSymbol, tag: "Active" },
      {
        title: `${formatTokenAmount(totalSupply)} ${assetSymbol}`,
        tag: `${totalSupply.toFixed(2)} ${assetSymbol}`,
      },
      {
        title: `${supplyAPY.toFixed(2)}%`,
        tag: `${supplyAPY.toFixed(2)}%`,
      },
      {
        title: `${formatTokenAmount(totalBorrowed)} ${assetSymbol}`,
        tag: `${totalBorrowed.toFixed(2)} ${assetSymbol}`,
      },
      {
        title: `${borrowAPY.toFixed(2)}%`,
        tag: `${borrowAPY.toFixed(2)}%`,
      },
      {
        title: `${utilizationRate.toFixed(2)}%`,
        tag: `${utilizationRate.toFixed(2)}%`,
      },
      {
        onlyIcons: collateralIcons,
        tag: "Collateral",
        clickable: "toggle",
      },
    ],
  };
};

// Build a positions row showing user's deposited/borrowed amount for an asset
const buildPositionRow = (
  assetSymbol: string,
  position: {
    deposited: string;
    borrowed: string;
    vTokenBalance: string;
    earnedInterest: string;
    accruedDebt: string;
  },
  pool: {
    supplyAPY: string;
    borrowAPY: string;
    utilizationRate: string;
  }
) => {
  const deposited = parseFloat(position.deposited) || 0;
  const borrowed = parseFloat(position.borrowed) || 0;
  const supplyAPY = parseFloat(pool.supplyAPY) || 0;
  const borrowAPY = parseFloat(pool.borrowAPY) || 0;
  const utilizationRate = parseFloat(pool.utilizationRate) || 0;

  return {
    cell: [
      { chain: assetSymbol, title: assetSymbol, tag: "Active" },
      {
        title: `${formatTokenAmount(deposited)} ${assetSymbol}`,
        tag: `${deposited.toFixed(2)} ${assetSymbol}`,
      },
      {
        title: `${supplyAPY.toFixed(2)}%`,
        tag: `${supplyAPY.toFixed(2)}%`,
      },
      {
        title: `${formatTokenAmount(borrowed)} ${assetSymbol}`,
        tag: `${borrowed.toFixed(2)} ${assetSymbol}`,
      },
      {
        title: `${borrowAPY.toFixed(2)}%`,
        tag: `${borrowAPY.toFixed(2)}%`,
      },
      {
        title: `${utilizationRate.toFixed(2)}%`,
        tag: `${utilizationRate.toFixed(2)}%`,
      },
      {
        onlyIcons: [assetSymbol],
        tag: "Collateral",
        clickable: "toggle",
      },
    ],
  };
};

type VaultTableCell = {
  chain?: string;
  title?: string;
  tag?: string;
  onlyIcons?: string[];
};

export default function Earn() {
  const userAddress = useUserStore((state) => state.address);
  const setSelectedVault = useEarnVaultStore((state) => state.set);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("vaults");
  const { getPrice } = useTokenPrices();

  // Live data from on-chain contracts (auto-refreshes every 30s)
  const { pools, isLoading: poolsLoading } = usePoolData();
  const { positions: userPositions, isLoading: positionsLoading } = useUserPositions();
  const [overviewHistory, setOverviewHistory] = useState<EarnOverviewSnapshot[]>([]);

  // Set default pool selection on mount
  useEffect(() => {
    setSelectedPool('XLM' as AssetType, {
      id: 'XLM',
      chain: 'XLM',
      title: 'XLM',
      tag: 'Active'
    });
  }, []);

  const { totalDepositedUSD, annualEarnings } = useMemo(() => {
    const totalUSD = ALL_ASSETS.reduce((sum, asset) => {
      const deposited = parseFloat(userPositions[asset]?.deposited || "0");
      return sum + deposited * getPrice(asset);
    }, 0);
    let weightedAPY = 0;
    let weightTotal = 0;
    ALL_ASSETS.forEach((asset) => {
      const deposited = parseFloat(userPositions[asset]?.deposited || "0");
      if (deposited > 0) {
        weightTotal += deposited;
        weightedAPY += deposited * parseFloat(pools[asset]?.supplyAPY || "0");
      }
    });
    const avgAPY = weightTotal > 0 ? weightedAPY / weightTotal : 0;
    const annual = totalUSD * (avgAPY / 100);
    return {
      totalDepositedUSD: totalUSD,
      annualEarnings: annual,
    };
  }, [userPositions, pools, getPrice]);

  useEffect(() => {
    if (!userAddress) {
      queueMicrotask(() => setOverviewHistory([]));
      return;
    }
    const next = readOverviewHistory(userAddress);
    queueMicrotask(() => setOverviewHistory(next));
  }, [userAddress]);

  useEffect(() => {
    if (!userAddress) return;
    if (poolsLoading || positionsLoading) return;
    if (!Number.isFinite(totalDepositedUSD) || !Number.isFinite(annualEarnings)) return;

    queueMicrotask(() => {
      setOverviewHistory((prev) => {
        const now = Date.now();
        const roundedDeposited = parseFloat(totalDepositedUSD.toFixed(2));
        const roundedAnnual = parseFloat(annualEarnings.toFixed(2));
        const last = prev[prev.length - 1];
        const depositedChanged = !last || Math.abs(last.totalDepositedUSD - roundedDeposited) >= 0.01;
        const earningsChanged = !last || Math.abs(last.annualEarningsUSD - roundedAnnual) >= 0.01;

        // Update only when actual value changes; never just because page refreshed.
        if (!depositedChanged && !earningsChanged) {
          return prev;
        }

        const next = [
          ...prev,
          {
            timestamp: now,
            totalDepositedUSD: roundedDeposited,
            annualEarningsUSD: roundedAnnual,
          },
        ].slice(-HISTORY_MAX_ITEMS);

        writeOverviewHistory(userAddress, next);
        return next;
      });
    });
  }, [userAddress, totalDepositedUSD, annualEarnings, poolsLoading, positionsLoading]);

  const liveDepositData = useMemo(
    () => toChartData(overviewHistory, "totalDepositedUSD"),
    [overviewHistory]
  );
  const liveNetApyData = useMemo(
    () => toChartData(overviewHistory, "annualEarningsUSD"),
    [overviewHistory]
  );

  // ─── Vaults Table ────────────────────────────────────────────────────────────
  // Each row reflects live pool-level stats fetched from the lending contracts.
  const liveVaultsTableBody = useMemo(
    () => ({
      rows: [
        buildPoolRow("XLM", pools.XLM, ["XLM", "USDC"]),
        buildPoolRow("BLUSDC", pools.USDC, ["BLUSDC", "XLM"]),
        buildPoolRow("AqUSDC", pools.AQUARIUS_USDC, ["USDC", "XLM"]),
        buildPoolRow("SoUSDC", pools.SOROSWAP_USDC, ["USDC", "XLM"]),
      ],
    }),
    [pools]
  );

  // ─── Positions Table ─────────────────────────────────────────────────────────
  // Shows only the assets where the user has a non-zero deposited balance.
  const livePositionsTableBody = useMemo(() => {
    if (!userAddress) return { rows: [] };

    const assetKeys = ["XLM", "USDC", "AQUARIUS_USDC", "SOROSWAP_USDC"] as const;
    const rows = assetKeys
      .filter(
        (asset) => parseFloat(userPositions[asset]?.deposited || "0") > 0 ||
                   parseFloat(userPositions[asset]?.borrowed || "0") > 0
      )
      .map((asset) => {
        const displaySymbol =
          asset === "AQUARIUS_USDC" ? "AqUSDC"
          : asset === "SOROSWAP_USDC" ? "SoUSDC"
          : asset === "USDC" ? "BLUSDC"
          : asset;
        return buildPositionRow(displaySymbol, userPositions[asset], pools[asset]);
      });

    return { rows };
  }, [userAddress, userPositions, pools]);

  // Tab-based table data
  const getTableDataForTab = (tabId: string) => {
    if (tabId === "vaults") return liveVaultsTableBody;
    if (tabId === "positions") return livePositionsTableBody;
    return { rows: [] };
  };

  // ─── Row Click Handler ────────────────────────────────────────────────────────
  const handleRowClick = useCallback(
    (row: { cell?: VaultTableCell[] }) => {
      const cells = row.cell ?? [];
      const id = cells[0]?.title ?? "";

      if (id) {
        const assetType =
          id === "AqUSDC" || id === "AquiresUSDC"
            ? "AQUARIUS_USDC"
            : id === "SoUSDC" || id === "SoroswapUSDC"
              ? "SOROSWAP_USDC"
              : id === "BLUSDC"
                ? "USDC"
                : id.toUpperCase();
        if (assetType === "XLM" || assetType === "USDC" || assetType === "AQUARIUS_USDC" || assetType === "SOROSWAP_USDC") {
          setSelectedPool(assetType as AssetType, {
            id: id,
            chain: assetType,
            title: id,
            tag: cells[0]?.tag || "Active",
          });
        }

        const vaultData = {
          id: id,
          chain: cells[0]?.chain ?? "XLM",
          title: cells[0]?.title ?? "",
          tag: cells[0]?.tag ?? "Active",
          assetsSupplied: { title: cells[1]?.title || "", tag: cells[1]?.tag || "" },
          supplyApy: { title: cells[2]?.title || "", tag: cells[2]?.tag || "" },
          assetsBorrowed: { title: cells[3]?.title || "", tag: cells[3]?.tag || "" },
          borrowApy: { title: cells[4]?.title || "", tag: cells[4]?.tag || "" },
          utilizationRate: { title: cells[5]?.title || "", tag: cells[5]?.tag || "" },
          collateral: {
            onlyIcons: cells[6]?.onlyIcons || [],
            tag: cells[6]?.tag || "Collateral",
          },
        };

        setSelectedVault({ selectedVault: vaultData });
        router.push(`/earn/${id}`);
      }
    },
    [router, setSelectedVault]
  );

  const earnCarouselItems = [
    {
      icon: "",
      title: "Earn Yield on Your Assets",
      description:
        "Supply liquidity to Vanna vaults and earn competitive APY. Your funds work 24/7 — no lockups, withdraw anytime.",
    },
    {
      icon: "",
      title: "Multi-Collateral Vaults",
      description:
        "Deposit multiple assets as collateral and borrow against them. Diversify risk while maximizing capital efficiency.",
    },
    {
      icon: "",
      title: "Audited & Battle-Tested",
      description:
        "Vanna Protocol's smart contracts are fully audited. Secure, transparent, and built for DeFi power users.",
    },
  ];

  return (
    <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Promotional Carousel */}
      <section className="w-full pt-4 sm:pt-6 pb-4">
        <Carousel items={earnCarouselItems} autoplayInterval={5000} />
      </section>

      {/* Stats with expandable charts — below carousel, side by side */}
      {userAddress && (
        <section className="w-full pb-4 flex flex-col lg:flex-row gap-3" aria-label="Protocol Dashboard">
          <article className="flex-1 min-w-0">
            <CollapsibleChart
              label="Overall Deposit"
              statValue={`$${(liveDepositData.length > 0
                ? liveDepositData[liveDepositData.length - 1].amount
                : 0
              ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              chartProps={{
                type: "overall-deposit",
                customData: liveDepositData,
              }}
            />
          </article>
          <article className="flex-1 min-w-0">
            <CollapsibleChart
              label="Net APY"
              statValue={`$${(liveNetApyData.length > 0
                ? liveNetApyData[liveNetApyData.length - 1].amount
                : 0
              ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              chartProps={{
                type: "net-apy",
                customData: liveNetApyData,
              }}
            />
          </article>
        </section>
      )}

      {/* Pool Table — full width */}
      <section className="w-full pb-8" aria-label="Vaults and Positions">
        <Table
          filterDropdownPosition="right"
          filters={{
            filters: ["Deposit", "Collateral"],
            allChainDropdown: true,
            supplyApyTab: true,
          }}
          heading={{
            tabsItems: [
              { id: "vaults", label: "Vaults" },
              { id: "positions", label: "Positions" },
            ],
            tabType: "underline",
          }}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tableHeadings={tableHeadings}
          tableBody={getTableDataForTab(activeTab)}
          onRowClick={handleRowClick}
          hoverBackground="hover:bg-[#F1EBFD]"
        />
      </section>
    </main>
  );
}
