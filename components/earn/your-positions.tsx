'use client';

/**
 * "Your Positions" panel for the selected earn pool. Shows a my-supply value
 * chart built from the user's real transaction history, plus tabbed Current
 * Position / Position History tables. Falls back to an illustrated empty state
 * when there's neither an active position nor any history.
 *
 * The supply chart accumulates a running USD balance from per-day signed
 * deltas (supply +, withdraw −), then overrides the final point with the live
 * current value so the tip always matches the on-chain balance. A dust
 * threshold (>1e-4) distinguishes a real position from stroop-level rounding
 * residue left after a full withdrawal.
 */
import { useState, useMemo, memo } from "react";
import { Chart } from "./chart";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { usePoolData, useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { useUserStore } from "@/store/user";
import { iconPaths } from "@/lib/constants";
import { getEarnHistoryByAsset } from "@/lib/earn-history";
import { useTokenPrices as useTokenPricesFromHook } from "@/hooks/use-token-prices";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";

const tabs = [
  { id: "current-positions", label: "Current Position" },
  { id: "positions-history", label: "Position History" },
];

const toInternalAsset = (value: string) => {
  if (value === "AqUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  if (value === "BLUSDC") return "USDC";
  return value.toUpperCase();
};

const toDisplayAsset = (value: string) => {
  if (value === "AQUARIUS_USDC") return "AqUSDC";
  if (value === "SOROSWAP_USDC") return "SoUSDC";
  if (value === "USDC") return "BLUSDC";
  return value;
};

type EarnTxLike = {
  asset?: string;
  type?: string;
  amount?: string | number;
  timestamp?: string | number;
  hash?: string;
};

const normalizeTimestamp = (value: string | number | undefined): number => {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  // Handle unix seconds from any legacy/local source
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
};

const toIsoDate = (timestamp: number): string => {
  return new Date(timestamp).toISOString().split("T")[0];
};

// AQUARIUS_USDC / SOROSWAP_USDC have no separate Reflector entry; they peg
// to USDC via the alias map inside oracle-price.ts.
const PRICE_TOKEN_FOR_ASSET: Record<string, string> = {
  XLM: 'XLM',
  USDC: 'USDC',
  AQUARIUS_USDC: 'USDC',
  SOROSWAP_USDC: 'USDC',
};

/** Memoized positions panel; merges on-chain + local history (de-duped by hash) for the selected pool. */
export const YourPositions = memo(function YourPositions() {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const [activeTab, setActiveTab] = useState<string>("current-positions");
  const [chartNow] = useState<number>(() => Date.now());

  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const assetKey = toInternalAsset(selectedAsset);
  const asset = toDisplayAsset(assetKey);

  const { pools } = usePoolData();
  const { positions } = useUserPositions();
  const { transactions } = useEarnTransactions();
  const walletAddress = useUserStore((state) => state.address);

  const supplyAPY = useMemo(() => {
    const pool = pools[assetKey as keyof typeof pools];
    return parseFloat(pool?.supplyAPY || '0');
  }, [pools, assetKey]);

  const userPosition = positions[assetKey as keyof typeof positions];
  const deposited = parseFloat(userPosition?.deposited || '0');
  // Dust threshold: anything below 1e-4 token is on-chain rounding residue
  // (stroop-level) left over after a 100% withdrawal — not a real position.
  const hasPosition = deposited > 1e-4;

  const tokenPrices = useTokenPricesFromHook(['XLM', 'USDC']);
  const price = tokenPrices[PRICE_TOKEN_FOR_ASSET[assetKey] ?? assetKey] ?? 1;
  const vTokenBalance = parseFloat(userPosition?.vTokenBalance || '0');

  const positionTableHeadings = [
    { label: "Pool", id: "pool" },
    { label: "Vault Shares", id: "shares" },
    { label: `${asset} Deposited`, id: "deposited" },
    { label: "USD Value", id: "usd-value" },
    { label: "APY", id: "apy" },
  ];

  const positionTableBody = hasPosition
    ? {
        rows: [
          {
            cell: [
              {
                icon: iconPaths[asset] || "/icons/stellar.svg",
                title: asset,
                tags: ["Vanna", "Vault"],
              },
              { title: `${formatTokenAmount(vTokenBalance)} v${asset}` },
              { title: `${formatTokenAmount(deposited)} ${asset}` },
              { title: formatUsdValue(deposited * price) },
              { title: `${supplyAPY.toFixed(2)}%` },
            ],
          },
        ],
      }
    : { rows: [] };

  const historyTableHeadings = [
    { label: "Date", id: "date" },
    { label: "Type", id: "type" },
    { label: "Amount", id: "amount" },
    { label: "Status", id: "status" },
    { label: "Tx Hash", id: "txHash" },
  ];

  const mergedHistory = useMemo(() => {
    const normalize = (value: string) => toInternalAsset(value);

    const onchain = (transactions ?? [])
      .filter((tx: EarnTxLike) => normalize(tx.asset || "") === normalize(assetKey))
      .map((tx: EarnTxLike) => ({
        timestamp: normalizeTimestamp(tx.timestamp),
        type: tx.type === "withdraw" ? "withdraw" : "supply",
        amount: String(tx.amount ?? "0"),
        hash: String(tx.hash ?? ""),
        status: "success",
      }));

    const onchainHashes = new Set(onchain.map((tx) => tx.hash).filter(Boolean));
    const local = getEarnHistoryByAsset(assetKey, walletAddress)
      .filter((tx) => !tx.hash || !onchainHashes.has(tx.hash))
      .map((tx) => ({
        timestamp: normalizeTimestamp(tx.timestamp),
        type: tx.type,
        amount: tx.amount,
        hash: tx.hash,
        status: tx.status,
      }));

    return [...onchain, ...local].sort((a, b) => b.timestamp - a.timestamp);
  }, [transactions, assetKey, walletAddress]);

  // Build chart from real user transactions so tooltip dates match actual activity.
  const mySupplyChartData = useMemo(() => {
    const currentUsdValue = parseFloat((deposited * price).toFixed(2));
    const txsAsc = [...mergedHistory]
      .filter((tx) => tx.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (txsAsc.length === 0) {
      if (currentUsdValue <= 0) return [];
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      return [
        { date: toIsoDate(yesterday.getTime()), amount: currentUsdValue },
        { date: toIsoDate(today.getTime()), amount: currentUsdValue },
      ];
    }

    const dayDeltaMap = new Map<string, number>();
    txsAsc.forEach((tx) => {
      const date = toIsoDate(tx.timestamp);
      const amountUsd = (parseFloat(tx.amount || "0") || 0) * price;
      const signedDelta = tx.type === "withdraw" ? -amountUsd : amountUsd;
      dayDeltaMap.set(date, (dayDeltaMap.get(date) ?? 0) + signedDelta);
    });

    const points: Array<{ date: string; amount: number }> = [];
    let running = 0;
    Array.from(dayDeltaMap.keys()).sort().forEach((date) => {
      running = Math.max(0, running + (dayDeltaMap.get(date) ?? 0));
      points.push({ date, amount: parseFloat(running.toFixed(2)) });
    });

    const todayIso = toIsoDate(chartNow);
    const hasToday = points.length > 0 && points[points.length - 1].date === todayIso;
    if (hasToday) {
      points[points.length - 1] = { date: todayIso, amount: currentUsdValue };
    } else {
      points.push({ date: todayIso, amount: currentUsdValue });
    }

    if (points.length < 2) {
      const firstDate = new Date(points[0]?.date ?? todayIso);
      firstDate.setDate(firstDate.getDate() - 1);
      points.unshift({ date: toIsoDate(firstDate.getTime()), amount: 0 });
    }

    return points;
  }, [mergedHistory, deposited, price, chartNow]);

  const historyTableBody = useMemo(() => {
    if (mergedHistory.length === 0) return { rows: [] };
    return {
      rows: mergedHistory.map((tx) => ({
        cell: [
          {
            title: tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : "—",
            description: tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString() : "",
          },
          {
            title: tx.type === "supply" ? "Supply" : "Withdraw",
            badge: tx.type === "supply" ? "green" : "orange",
          },
          {
            icon: iconPaths[asset] || "/icons/stellar.svg",
            title: `${(parseFloat(tx.amount) || 0).toFixed(2)} ${asset}`,
            description: `$${((parseFloat(tx.amount) || 0) * price).toFixed(2)}`,
          },
          { title: "Success", badge: "green" },
          tx.hash
            ? {
                title: `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}`,
                clickable: "link",
                link: `https://stellar.expert/explorer/testnet/tx/${tx.hash}`,
              }
            : { title: "—" },
        ],
      })),
    };
  }, [mergedHistory, asset, price]);

  const hasAnyHistory = mergedHistory.length > 0;

  return (
    <section
      className={`w-full h-full flex flex-col gap-[16px] rounded-[16px] border-[1px] p-[16px] ${
        isDark ? "bg-[#111111]" : "bg-[#F7F7F7]"
      }`}
      aria-label="Your Positions Overview"
    >
      {/* Supply chart — shows user's deposit value over time */}
      <figure className="w-full">
        <Chart
          type="my-supply"
          currencyTab={true}
          height={320}
          containerWidth="w-full"
          customData={mySupplyChartData}
        />
      </figure>

      {/* Position table or empty state */}
      <article aria-label="My Position">
        {!hasPosition && !hasAnyHistory ? (
          <div className={`w-full rounded-2xl border p-6 flex flex-col items-center justify-center gap-4 text-center ${
            isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
          }`}>
            <div className={`w-14 h-14 rounded-full flex items-center justify-center ${
              isDark ? "bg-[#2A2A2A]" : "bg-[#F4F0FD]"
            }`}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 17l10 5 10-5" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 12l10 5 10-5" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="flex flex-col gap-1">
              <p className={`text-[15px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                No active position
              </p>
              <p className={`text-[13px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
                Supply liquidity to start earning {asset} yield
              </p>
            </div>
            <div className={`w-full rounded-xl p-4 flex items-center justify-between ${
              isDark ? "bg-[#222222]" : "bg-[#F7F4FE]"
            }`}>
              <div className="flex flex-col gap-0.5 text-left">
                <span className={`text-[11px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>Current Supply APY</span>
                <span className="text-[20px] font-bold text-[#703AE6]">
                  {supplyAPY.toFixed(2)}%
                </span>
              </div>
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                isDark ? "bg-[#2A2A2A]" : "bg-white"
              }`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="#703AE6" strokeWidth="1.8"/>
                  <path d="M12 6v6l4 2" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
                <span className={`text-[12px] font-semibold ${isDark ? "text-[#A7A7A7]" : "text-[#555555]"}`}>
                  Earn daily rewards
                </span>
              </div>
            </div>
          </div>
        ) : (
          <Table
            filterDropdownPosition="right"
            heading={{
              heading: "My Position",
              tabsItems: tabs,
              tabType: "solid",
            }}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            tableHeadings={activeTab === "current-positions" ? positionTableHeadings : historyTableHeadings}
            tableBody={activeTab === "current-positions" ? positionTableBody : historyTableBody}
            tableBodyBackground={isDark ? "bg-[#111111]" : "bg-white"}
            filters={{ customizeDropdown: true }}
          />
        )}
      </article>
    </section>
  );
});
