"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUserPositions, usePoolData } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { STELLAR_POOLS } from "@/lib/constants/earn";
import { Table } from "@/components/earn/table";
import { transactionTableHeadings } from "@/components/earn/acitivity-tab";
import { getEarnHistoryByAsset, type EarnHistoryEntry } from "@/lib/earn-history";
import { formatTokenAmount } from "@/lib/utils/format-amount";
import { useTheme } from "@/contexts/theme-context";

const ASSETS = ["XLM", "USDC", "AQUARIUS_USDC", "SOROSWAP_USDC"] as const;

// AQ/SO USDC variants peg to USDC — they have no separate oracle entry.
const PRICE_TOKEN: Record<string, string> = {
  XLM: "XLM",
  USDC: "USDC",
  AQUARIUS_USDC: "USDC",
  SOROSWAP_USDC: "USDC",
  BLND: "BLND",
  AQUA: "AQUA",
  WETH: "WETH",
  EURC: "EURC",
};

const POSITION_TABS = [
  { id: "current-positions", label: "Current Positions" },
  { id: "position-history", label: "Position History" },
];

const TABLE_HEADINGS = [
  { id: "pool", label: "Pool" },
  { id: "amount-supplied", label: "Amount Supplied", icon: true },
  { id: "supply-apy", label: "Supply APY", icon: true },
  { id: "value", label: "Value", icon: true },
];

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Portfolio "Lender" tab — real Stellar lending supply. Positions come from the
 * same earn hooks the Earn page uses (`useUserPositions` for supplied amounts,
 * `usePoolData` for live supply APY), USD-valued via the oracle price hook.
 * Total Holdings = Σ(deposited × price). No mock rewards / returns / P&L —
 * time-series analytics are deferred to the Sprint-2 Mercury read-model.
 */
export const LenderTab = () => {
  const { isDark } = useTheme();
  const router = useRouter();
  const [positionTab, setPositionTab] = useState("current-positions");

  const { positions } = useUserPositions();
  const { pools } = usePoolData();
  const prices = useTokenPrices(["XLM", "USDC"]);

  const rows = ASSETS.map((asset) => {
    const deposited = parseFloat(positions[asset]?.deposited ?? "0");
    const supplyAPY = parseFloat(pools[asset]?.supplyAPY ?? "0");
    const price = prices[PRICE_TOKEN[asset]] ?? (PRICE_TOKEN[asset] === "USDC" ? 1 : 0);
    const symbol = STELLAR_POOLS[asset]?.symbol ?? asset;
    return { asset, symbol, deposited, supplyAPY, usd: deposited * price };
  }).filter((r) => r.deposited > 0);

  const totalHoldings = rows.reduce((s, r) => s + r.usd, 0);
  const avgAPY = rows.length ? rows.reduce((s, r) => s + r.supplyAPY, 0) / rows.length : 0;

  const lenderStats: { id: string; name: string; amount: string; positive: boolean | null }[] = [
    { id: "1", name: "Total Holdings", amount: fmtUsd(totalHoldings), positive: null },
    { id: "2", name: "Supplied Assets", amount: String(rows.length), positive: null },
    { id: "3", name: "Avg Supply APY", amount: `${avgAPY.toFixed(2)}%`, positive: rows.length > 0 ? true : null },
  ];

  const tableRows = rows.map((r) => ({
    cell: [
      { title: r.symbol, tag: "Active" },
      { title: `${formatTokenAmount(r.deposited)} ${r.symbol}`, tag: fmtUsd(r.usd) },
      { title: `${r.supplyAPY.toFixed(2)}%`, tag: "" },
      { title: fmtUsd(r.usd) },
    ],
  }));

  // Position History — every supply/withdraw the wallet has made across all
  // lending assets, merged and sorted newest-first. Same local tx log
  // (lib/earn-history) and row shape (Date/Type/Amount/Status/Tx Hash) as the
  // Earn page's per-asset "All Transactions" history, aggregated here across
  // every asset instead of scoped to one.
  const historyEntries = useMemo((): EarnHistoryEntry[] => {
    return ASSETS.flatMap((asset) => getEarnHistoryByAsset(asset)).sort(
      (a, b) => b.timestamp - a.timestamp,
    );
  }, []);

  const historyTableRows = historyEntries.map((ev) => {
    const amountNum = parseFloat(ev.amount) || 0;
    const symbol = STELLAR_POOLS[ev.asset as keyof typeof STELLAR_POOLS]?.symbol ?? ev.asset;
    const price = prices[PRICE_TOKEN[ev.asset]] ?? (PRICE_TOKEN[ev.asset] === "USDC" ? 1 : 0);
    return {
      cell: [
        {
          title: ev.timestamp ? new Date(ev.timestamp).toLocaleDateString() : "—",
          description: ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "",
        },
        {
          title: ev.type === "supply" ? "Supply" : "Withdraw",
          badge: ev.type === "supply" ? "green" : "orange",
        },
        {
          title: `${amountNum.toFixed(2)} ${symbol}`,
          description: fmtUsd(amountNum * price),
        },
        { title: "Success", badge: "green" },
        ev.hash
          ? {
              title: `${ev.hash.slice(0, 8)}...${ev.hash.slice(-4)}`,
              clickable: "link",
              link: `https://stellar.expert/explorer/testnet/tx/${ev.hash}`,
            }
          : { title: "—" },
      ],
    };
  });

  const isHistoryTab = positionTab === "position-history";

  return (
    <div className="w-full h-fit flex flex-col gap-6 sm:gap-8">
      {/* Top row: real Lender stats + analytics placeholder */}
      <div className="w-full flex flex-col lg:flex-row gap-4 lg:gap-[16px]">
        {/* Lender Stats */}
        <div
          className={`w-full lg:w-[422px] flex-shrink-0 flex flex-col rounded-xl border overflow-hidden ${
            isDark ? "bg-[#222222] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"
          }`}
        >
          <div className={`px-5 pt-5 pb-4 border-b ${isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]"}`}>
            <h3 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>Lender Stats</h3>
          </div>
          <div className="flex flex-col px-5 pb-5">
            {lenderStats.map(({ id, name, amount, positive }) => (
              <div key={id} className="flex justify-between items-center py-2.5">
                <span className={`text-[14px] font-medium ${isDark ? "text-[#919191]" : "text-[#777777]"}`}>{name}</span>
                <span
                  className={`text-[14px] font-semibold shrink-0 ${
                    positive === true ? "text-[#16a34a]" : isDark ? "text-white" : "text-[#1A1A1A]"
                  }`}
                >
                  {amount}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Analytics placeholder — lending P&L over time → Sprint-2 read-model */}
        <div
          className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 rounded-[16px] border p-5 min-h-[180px] ${
            isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
          }`}
        >
          <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>Lending P&amp;L</span>
          <span className="text-[12px] font-medium text-[#777777]">Coming soon</span>
        </div>
      </div>

      {/* Positions table — real supplied positions, or Position History.
          Rendered whenever the wallet has EITHER current positions OR any
          history entries — a fully-withdrawn position has no current row but
          can still have history, so gating render on `tableRows.length` alone
          hid Position History for exactly that case. The Table component's
          own empty state covers a genuinely-empty account either way. */}
      {tableRows.length > 0 || historyEntries.length > 0 ? (
        <Table
          heading={{ heading: "Positions Table", tabsItems: POSITION_TABS, tabType: "solid" }}
          activeTab={positionTab}
          onTabChange={setPositionTab}
          tableHeadings={isHistoryTab ? transactionTableHeadings : TABLE_HEADINGS}
          tableBody={{ rows: isHistoryTab ? historyTableRows : tableRows }}
          tableBodyBackground={isDark ? "bg-[#222222]" : "bg-[#F4F4F4]"}
          filters={{ customizeDropdown: true, filters: ["All"] }}
          onRowClick={
            isHistoryTab
              ? undefined
              : (_row, rowIndex) => {
                  const symbol = rows[rowIndex]?.symbol;
                  if (symbol) router.push(`/earn/${symbol}?tab=your-positions`);
                }
          }
        />
      ) : (
        <div
          className={`w-full rounded-[16px] border px-5 py-10 text-center text-[14px] font-medium ${
            isDark ? "bg-[#222222] border-[#2A2A2A] text-[#777777]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#777777]"
          }`}
        >
          No lending positions yet. Supply assets on the Earn page to start earning.
        </div>
      )}
    </div>
  );
};
