"use client";

import { useMemo, useState } from "react";
import { Table } from "@/components/earn/table";
import { transactionTableHeadings } from "@/components/earn/acitivity-tab";
import { useTheme } from "@/contexts/theme-context";
import { spotBalancesTableHeadings } from "@/lib/constants/farm";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useAquariusTokenBalance } from "@/hooks/use-farm";
import { useSoroswapTokenBalance } from "@/hooks/use-soroswap";
import { getSpotHistory } from "@/lib/spot-history";

const SPOT_TABS = [
  { id: "balances", label: "Spot Balances" },
  { id: "history", label: "Spot History" },
];

const POSITION_DUST = 1e-4;

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Portfolio "Spot" tab — the margin account's real spot token balances held
 * directly from Aquarius/Soroswap swaps (not lent to Blend, not deposited as
 * LP — those live under the Farm tab). XLM is ONE shared native-token balance
 * across both venues (same SAC), so it's queried once and shown once — reading
 * it per-venue would show the same balance twice and double-count it into the
 * total. USDC is a genuinely distinct SAC per venue (AQUSDC/SOUSDC), so those
 * two are queried and shown separately.
 */
export const SpotSection = () => {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState("balances");
  const userAddress = useUserStore((s) => s.address);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const { balance: xlm } = useSoroswapTokenBalance(marginAccountAddress, "XLM");
  const { balance: aqUsdc } = useAquariusTokenBalance(marginAccountAddress, "USDC");
  const { balance: ssUsdc } = useSoroswapTokenBalance(marginAccountAddress, "USDC");
  const { balance: aqWeth } = useAquariusTokenBalance(marginAccountAddress, "WETH");
  const { balance: aqAqua } = useAquariusTokenBalance(marginAccountAddress, "AQUA");
  const { balance: ssEurc } = useSoroswapTokenBalance(marginAccountAddress, "EURC");

  const prices = useTokenPrices(["XLM", "USDC", "WETH", "AQUA", "EURC"]);

  const rows = useMemo(() => {
    const out: { cell: { title?: string; description?: string; chain?: string; titles?: string[]; tags?: string[] }[]; usd: number }[] = [];

    const entries: { symbol: "XLM" | "USDC" | "WETH" | "AQUA" | "EURC"; venue: string; balance: string }[] = [
      { symbol: "XLM", venue: "Margin Account", balance: xlm },
      { symbol: "USDC", venue: "Aquarius", balance: aqUsdc },
      { symbol: "USDC", venue: "Soroswap", balance: ssUsdc },
      { symbol: "WETH", venue: "Aquarius", balance: aqWeth },
      { symbol: "AQUA", venue: "Aquarius", balance: aqAqua },
      { symbol: "EURC", venue: "Soroswap", balance: ssEurc },
    ];

    entries.forEach(({ symbol, venue, balance }) => {
      const amount = parseFloat(balance || "0");
      if (amount <= POSITION_DUST) return;
      const price = prices[symbol] ?? (symbol === "USDC" ? 1 : 0);
      out.push({
        cell: [
          { chain: symbol, title: symbol, tags: [venue] },
          { title: venue },
          { title: `${amount.toFixed(4)} ${symbol}` },
          { title: fmtUsd(amount * price) },
        ],
        usd: amount * price,
      });
    });

    return out;
  }, [xlm, aqUsdc, ssUsdc, aqWeth, aqAqua, ssEurc, prices]);

  const totalSpotUsd = rows.reduce((s, r) => s + r.usd, 0);

  // Spot History — every margin-account swap (Aquarius + Soroswap), newest
  // first. Same local tx log pattern as Farm/Lender position history.
  const historyEntries = useMemo(
    () => getSpotHistory(marginAccountAddress),
    [marginAccountAddress],
  );

  const historyTableBody = useMemo(
    () => ({
      rows: historyEntries.map((ev) => ({
        cell: [
          {
            title: ev.timestamp ? new Date(ev.timestamp).toLocaleDateString() : "—",
            description: ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "",
          },
          { title: "Swap", badge: "green" },
          {
            title: `${(parseFloat(ev.amountIn) || 0).toFixed(2)} ${ev.tokenIn} → ${(parseFloat(ev.amountOut) || 0).toFixed(2)} ${ev.tokenOut}`,
            description: ev.protocol === "aquarius" ? "Aquarius" : "Soroswap",
          },
          { title: "Success", badge: "green" },
          ev.txHash
            ? {
                title: `${ev.txHash.slice(0, 8)}...${ev.txHash.slice(-4)}`,
                clickable: "link",
                link: `https://stellar.expert/explorer/testnet/tx/${ev.txHash}`,
              }
            : { title: "—" },
        ],
      })),
    }),
    [historyEntries],
  );

  const isHistoryTab = activeTab === "history";

  const tableData = useMemo(() => {
    if (isHistoryTab) {
      return { headings: transactionTableHeadings, body: historyTableBody };
    }
    return {
      headings: spotBalancesTableHeadings,
      body: { rows: rows.map(({ cell }) => ({ cell })) },
    };
  }, [isHistoryTab, historyTableBody, rows]);

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      <div className={`w-full rounded-[16px] overflow-hidden border ${
        isDark ? "border-[#2D2D2D] bg-[#222222]" : "border-[#E8E8E8] bg-[#f7f7f7]"
      }`}>
        <div className="flex flex-col gap-2 px-5 py-4">
          <span className={`text-[13px] font-medium ${isDark ? "text-[#A0A0A0]" : "text-[#777777]"}`}>
            Total Spot Balance
          </span>
          <span className={`text-[20px] font-bold ${isDark ? "text-white" : "text-[#111]"}`}>
            {fmtUsd(totalSpotUsd)}
          </span>
        </div>
      </div>

      {!userAddress ? (
        <div className={`w-full rounded-[16px] border px-5 py-10 text-center text-[14px] font-medium ${
          isDark ? "bg-[#222222] border-[#2A2A2A] text-[#777777]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#777777]"
        }`}>
          Connect your wallet to see spot balances.
        </div>
      ) : (
        // Rendered whenever a wallet is connected, even with zero current spot
        // balances — Spot History can still have entries (e.g. swapped back
        // out already), and the Table component's own empty state covers the
        // genuinely-empty case for both tabs.
        <Table
          filterDropdownPosition="left"
          heading={{ tabsItems: SPOT_TABS, tabType: "solid" }}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          filters={{ allChainDropdown: false, filters: [], filterTabType: "solid" }}
          tableHeadings={tableData.headings}
          tableBody={tableData.body}
        />
      )}
    </div>
  );
};
