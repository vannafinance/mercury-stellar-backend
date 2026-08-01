"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "@/components/earn/table";
import { useTheme } from "@/contexts/theme-context";
import { positionsTableHeadings } from "@/lib/constants/farm";
import { transactionTableHeadings } from "@/components/earn/acitivity-tab";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useFarmStore } from "@/store/farm-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import {
  useUserBlendPositions,
  useAllAquariusLpPositions,
  useAllAquariusPoolStats,
  useBlendPoolStats,
  useBlendEvents,
  useAquariusEvents,
} from "@/hooks/use-farm";
import { useSoroswapPoolStats, useSoroswapLpPosition, useSoroswapEvents } from "@/hooks/use-soroswap";
import { AQUARIUS_POOLS, aquariusLpUnderlyingAmounts } from "@/lib/aquarius-utils";
import { getFarmHistory, buildFarmPoolKey, type FarmHistoryEntry, type FarmAction } from "@/lib/farm-history";

const POSITION_DUST = 1e-4;

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Same decimal-APY-string formatter as app/farm/page.tsx's `formatApyDecimalString`
// (not shared/exported from there — duplicated here to avoid touching that
// already-shipped page). Aquarius's API returns a decimal string ("0.0234");
// Soroswap's public testnet API exposes no APY endpoint at all yet, so its
// row legitimately has no real number to show — "0%" there is honest, not a bug.
const formatApyPct = (raw?: string): string => {
  const n = parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return "0%";
  return `${(n * 100).toFixed(2)}%`;
};

/**
 * Portfolio "Farm" tab — real Blend (single-asset supply) + Soroswap/Aquarius
 * (LP) farm positions. Reuses the same real hooks and position-valuation math
 * as `app/farm/page.tsx`'s "Positions" view (kept independent rather than
 * shared, to avoid touching that already-shipped page for this change).
 * APY is real for Blend (supplyAPY) and Aquarius (totalApy/apy); Soroswap's
 * public testnet API exposes no APY endpoint yet, so that row honestly shows
 * "0%" rather than a fabricated number. P&L/volume have no on-chain
 * cost-basis source yet either, so those stay honest $0.00 placeholders.
 */
export const FarmSection = () => {
  const { isDark } = useTheme();
  const [activeFilterTab, setActiveFilterTab] = useState("current-position");
  const router = useRouter();
  const setFarmData = useFarmStore((s) => s.set);

  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const userAddress = useUserStore((s) => s.address);

  const { positions: blendPositions } = useUserBlendPositions();
  const { stats: blendPoolStats } = useBlendPoolStats();
  const { stats: ssStats } = useSoroswapPoolStats(Boolean(marginAccountAddress));
  const { lpBalance: ssLpBalanceRaw } = useSoroswapLpPosition(marginAccountAddress);
  const mySSLpBalance = parseFloat(ssLpBalanceRaw ?? "0");
  const { positions: aqLpPositions } = useAllAquariusLpPositions(marginAccountAddress);
  const aquariusPools = useAllAquariusPoolStats();

  const prices = useTokenPrices(["XLM", "USDC", "USDT"]);
  const priceFor = useCallback(
    (sym: string): number => {
      const s = sym.toUpperCase();
      if (s === "XLM") return prices.XLM ?? 0;
      if (s === "USDC" || s === "BLUSDC" || s === "AQUSDC" || s === "SOUSDC" || s === "BLEND_USDC") return prices.USDC ?? 1;
      if (s === "USDT") return prices.USDT ?? 1;
      return 0;
    },
    [prices],
  );

  const rows = useMemo(() => {
    const out: { id: string; cell: { title?: string; description?: string; chain?: string; titles?: string[]; tags?: string[] }[]; usd: number }[] = [];

    (["XLM", "USDC"] as const)
      .filter((sym) => parseFloat(blendPositions[sym]?.underlyingValue ?? "0") > POSITION_DUST)
      .forEach((sym) => {
        const pos = blendPositions[sym];
        const amount = parseFloat(pos.underlyingValue || "0");
        out.push({
          id: sym.toLowerCase(),
          cell: [
            { chain: sym, title: sym, tags: ["Blend", "Supply"] },
            { title: "Blend" },
            {
              title: `${pos.underlyingValue} ${sym}`,
              description: pos.bTokenBalance ? `${pos.bTokenBalance} b${sym}` : undefined,
            },
            { title: blendPoolStats[sym]?.supplyAPY ? `${blendPoolStats[sym]!.supplyAPY}%` : "0%" },
          ],
          usd: amount * priceFor(sym),
        });
      });

    if (mySSLpBalance > POSITION_DUST) {
      const totalShares = parseFloat(ssStats?.totalShares ?? "0");
      const ratio = totalShares > 0 ? mySSLpBalance / totalShares : 0;
      const xlmShare = ratio * parseFloat(ssStats?.reserveXLM ?? "0");
      const usdcShare = ratio * parseFloat(ssStats?.reserveUSDC ?? "0");
      out.push({
        id: "soroswap-xlm-usdc",
        cell: [
          { chain: "XLM", titles: ["XLM", "USDC"], tags: ["Soroswap", "LP"] },
          { title: "Soroswap" },
          { title: `${mySSLpBalance.toFixed(2)} LP`, description: `${xlmShare.toFixed(2)} XLM + ${usdcShare.toFixed(2)} USDC` },
          { title: "0%" },
        ],
        usd: xlmShare * priceFor("XLM") + usdcShare * priceFor("USDC"),
      });
    }

    AQUARIUS_POOLS.forEach((pool) => {
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? "0");
      if (lpBal <= POSITION_DUST) return;
      const aqPoolStats = aquariusPools.find((p) => p.pool.id === pool.id)?.stats ?? null;
      const [tokenA, tokenB] = pool.tokens;
      const { amountA: shareA, amountB: shareB } = aquariusLpUnderlyingAmounts(
        lpBal,
        aqPoolStats ?? { reserveA: "0", reserveB: "0", totalShares: "0", feeFraction: "0.30%", feeRaw: 30 },
        tokenA,
        tokenB,
      );
      out.push({
        id: pool.id,
        cell: [
          { chain: tokenA, titles: [tokenA, tokenB], tags: ["Aquarius", "LP"] },
          { title: "Aquarius" },
          { title: `${lpBal.toFixed(2)} LP`, description: `${shareA.toFixed(2)} ${tokenA} + ${shareB.toFixed(2)} ${tokenB}` },
          { title: formatApyPct(aqPoolStats?.totalApy ?? aqPoolStats?.apy) },
        ],
        usd: shareA * priceFor(tokenA) + shareB * priceFor(tokenB),
      });
    });

    return out;
  }, [blendPositions, blendPoolStats, mySSLpBalance, ssStats, aqLpPositions, aquariusPools, priceFor]);

  const userSuppliedUsd = rows.reduce((s, r) => s + r.usd, 0);

  // Overall Farm TVL — sum of every tracked pool's real reserves, valued at
  // live oracle prices (not just the pools the user personally has open).
  const overallFarmTvlUsd = useMemo(() => {
    let total = 0;
    const blendXlmTotal = 0; // Blend's total-pool-side TVL isn't exposed by useUserBlendPositions (user-scoped only).
    if (ssStats) {
      total += parseFloat(ssStats.reserveXLM || "0") * priceFor("XLM");
      total += parseFloat(ssStats.reserveUSDC || "0") * priceFor("USDC");
    }
    aquariusPools.forEach(({ pool, stats }) => {
      if (!stats) return;
      const [tokenA, tokenB] = pool.tokens;
      total += parseFloat(stats.reserveA || "0") * priceFor(tokenA);
      total += parseFloat(stats.reserveB || "0") * priceFor(tokenB);
    });
    return total + blendXlmTotal;
  }, [ssStats, aquariusPools, priceFor]);

  const pctOfMargin = totalCollateralValue > 0 ? (userSuppliedUsd / totalCollateralValue) * 100 : 0;

  const FARMING_INFO_STATS: { label: string; value: string; positive: boolean | null }[] = [
    { label: "Your Total Asset Supplied\nto Farm(USD)", value: fmtUsd(userSuppliedUsd), positive: null },
    { label: "Overall Farm TVL(USD)", value: fmtUsd(overallFarmTvlUsd), positive: null },
    { label: "Percentage of Your Margin\nAllocated to Farm(%)", value: `${pctOfMargin.toFixed(2)}%`, positive: null },
    { label: "Unrealised P&L", value: fmtUsd(0), positive: null },
    { label: "Realised P&L", value: fmtUsd(0), positive: null },
  ];

  const filterTabTypeOptions = [
    { id: "current-position", label: "Current Position" },
    { id: "position-history", label: "Position History" },
  ];

  // Position History — every add/remove the connected margin account has made
  // across Blend + Soroswap + Aquarius, merged and sorted newest-first. Same
  // row shape (Date/Type/Amount/Status/Tx Hash) as the single-pool "Position
  // History" tab on a Farm pool detail page, aggregated across every pool
  // instead of scoped to one.
  //
  // Real on-chain events (Mercury + RPC fallback, via the same resilient hooks
  // the Farm detail page uses) are the source of truth; the local tx log
  // (lib/farm-history) only fills in entries whose txHash isn't already
  // covered on-chain (e.g. very recent local optimistic rows) — it is never
  // the sole source, so history survives a cleared cache / fresh reconnect.
  const { events: blendEvents } = useBlendEvents();
  const { events: aqEvents } = useAquariusEvents(null, marginAccountAddress);
  const { events: ssEvents } = useSoroswapEvents(ssStats?.pairAddress, marginAccountAddress);

  const historyEntries = useMemo((): FarmHistoryEntry[] => {
    if (!marginAccountAddress) return [];

    const onchain: FarmHistoryEntry[] = [
      ...blendEvents.map((ev) => ({
        id: `blend:${ev.txHash}:${ev.type}:${ev.tokenSymbol}`,
        protocol: "blend" as const,
        poolKey: buildFarmPoolKey(ev.tokenSymbol),
        marginAccountAddress,
        action: (ev.type === "supply" ? "add" : "remove") as FarmAction,
        amountDisplay: `${ev.underlyingAmount} ${ev.tokenSymbol}`,
        txHash: ev.txHash ?? "",
        timestamp: ev.timestamp,
      })),
      ...aqEvents.map((ev) => ({
        id: `aquarius:${ev.txHash}:${ev.type}`,
        protocol: "aquarius" as const,
        poolKey: "aquarius",
        marginAccountAddress,
        action: (ev.type === "deposit" ? "add" : "remove") as FarmAction,
        amountDisplay: `${ev.shareAmount} LP`,
        txHash: ev.txHash ?? "",
        timestamp: ev.timestamp,
      })),
      ...ssEvents.map((ev) => ({
        id: `soroswap:${ev.txHash}:${ev.type}`,
        protocol: "soroswap" as const,
        poolKey: buildFarmPoolKey("XLM", "USDC"),
        marginAccountAddress,
        action: (ev.type === "deposit" ? "add" : "remove") as FarmAction,
        amountDisplay: `${ev.shareAmount} LP`,
        txHash: ev.txHash ?? "",
        timestamp: ev.timestamp,
      })),
    ];

    const onchainHashes = new Set(onchain.map((e) => e.txHash).filter(Boolean));

    const local: FarmHistoryEntry[] = [
      ...getFarmHistory({ protocol: "blend", poolKey: buildFarmPoolKey("XLM"), marginAccountAddress }),
      ...getFarmHistory({ protocol: "blend", poolKey: buildFarmPoolKey("USDC"), marginAccountAddress }),
      ...getFarmHistory({ protocol: "soroswap", poolKey: buildFarmPoolKey("XLM", "USDC"), marginAccountAddress }),
    ];
    AQUARIUS_POOLS.forEach((pool) => {
      const [tokenA, tokenB] = pool.tokens;
      local.push(...getFarmHistory({ protocol: "aquarius", poolKey: buildFarmPoolKey(tokenA, tokenB), marginAccountAddress }));
    });
    const localFiltered = local.filter((e) => !e.txHash || !onchainHashes.has(e.txHash));

    return [...onchain, ...localFiltered].sort((a, b) => b.timestamp - a.timestamp);
  }, [marginAccountAddress, blendEvents, aqEvents, ssEvents]);

  const historyTableBody = useMemo(
    () => ({
      rows: historyEntries.map((ev) => ({
        cell: [
          {
            title: ev.timestamp ? new Date(ev.timestamp).toLocaleDateString() : "—",
            description: ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "",
          },
          {
            title: ev.action === "add" ? "Supply" : "Withdraw",
            badge: ev.action === "add" ? "green" : "orange",
          },
          { title: ev.amountDisplay },
          { title: "Success", badge: "green" },
          ev.txHash
            ? {
                title: `${ev.txHash.slice(0, 8)}...${ev.txHash.slice(-4)}`,
                clickable: "link",
                link: `https://stellar.expert/explorer/public/tx/${ev.txHash}`,
              }
            : { title: "—" },
        ],
      })),
    }),
    [historyEntries],
  );

  const tableData = useMemo(() => {
    if (activeFilterTab === "position-history") {
      return { headings: transactionTableHeadings, body: historyTableBody };
    }
    return {
      headings: positionsTableHeadings,
      body: { rows: rows.map(({ id, cell }) => ({ id, cell })) },
    };
  }, [activeFilterTab, historyTableBody, rows]);

  // Same navigation as app/farm/page.tsx's Positions tab: Blend rows go to
  // their single-asset detail page, Soroswap/Aquarius LP rows go to their
  // pool page — derived from each row's own protocol tag since this table
  // has no vaults-style sub-tab to read the type from.
  const handleRowClick = useCallback((row: { id?: string; cell?: { tags?: string[] }[] }) => {
    const tabType = row.cell?.[0]?.tags?.includes("Blend") ? "single" : "multi";
    const rowId = row.id;
    if (!rowId) return;
    setFarmData({ selectedRow: row, tabType });
    router.push(`/farm/${rowId}`);
  }, [router, setFarmData]);

  return (
    <div className="w-full h-fit flex flex-col gap-[20px]">
      {/* Info + analytics-placeholder row (mirrors the Lender tab's layout) */}
      <div className="w-full flex flex-col lg:flex-row gap-4 sm:gap-[20px]">
        {/* Farming Info panel */}
        <div className={`w-full lg:w-[422px] flex-shrink-0 flex flex-col rounded-xl border overflow-hidden ${
          isDark ? "bg-[#222222] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"
        }`}>
          <div className={`px-5 pt-5 pb-4 border-b flex-shrink-0 ${isDark ? "border-[#2A2A2A]" : "border-[#e5e7eb]"}`}>
            <h3 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>Farming Info</h3>
          </div>
          <div className="flex flex-col overflow-y-auto px-5 pb-5">
            {FARMING_INFO_STATS.map(({ label, value, positive }) => (
              <div key={label} className="flex justify-between items-center py-[10px]">
                <span className={`text-[14px] font-medium tracking-[0.01em] whitespace-pre-line ${isDark ? "text-[#919191]" : "text-[#777777]"}`}>
                  {label}
                </span>
                <span className={`text-[14px] font-semibold flex-shrink-0 ${
                  positive === true ? "text-[#16a34a]"
                  : positive === false ? "text-[#dc2626]"
                  : isDark ? "text-white" : "text-[#1A1A1A]"
                }`}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Analytics placeholder — per-protocol time series exist, but a combined
            Blend+Soroswap+Aquarius chart needs a shared value-over-time model
            that doesn't exist yet. Matches the Lender tab's honest "Coming soon". */}
        <div className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 rounded-[16px] border p-5 min-h-[180px] ${
          isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#E8E8E8]"
        }`}>
          <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>Farm Equity</span>
          <span className="text-[12px] font-medium text-[#777777]">Coming soon</span>
        </div>
      </div>

      {/* Positions Table — real Blend/Soroswap/Aquarius farm positions.
          Rendered whenever a wallet is connected, regardless of whether the
          Current Position tab happens to be empty — Position History can
          still have entries (e.g. a fully-closed position) even when there's
          nothing open right now, and the Table component's own empty state
          ("No data available") covers the genuinely-empty case for both tabs. */}
      {!userAddress ? (
        <div className={`w-full rounded-[16px] border px-5 py-10 text-center text-[14px] font-medium ${
          isDark ? "bg-[#222222] border-[#2A2A2A] text-[#777777]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#777777]"
        }`}>
          Connect your wallet to see farm positions.
        </div>
      ) : (
        <Table
          filterDropdownPosition="left"
          heading={{ heading: "Positions Table", tabType: "solid" }}
          filters={{ allChainDropdown: true, filters: [], filterTabType: "solid" }}
          filterTabTypeOptions={filterTabTypeOptions}
          activeFilterTab={activeFilterTab}
          onFilterTabTypeChange={setActiveFilterTab}
          tableHeadings={tableData.headings}
          tableBody={tableData.body}
          onRowClick={activeFilterTab === "position-history" ? undefined : handleRowClick}
        />
      )}
    </div>
  );
};
