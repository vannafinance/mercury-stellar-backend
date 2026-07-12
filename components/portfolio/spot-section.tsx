"use client";

import { useMemo } from "react";
import { Table } from "@/components/earn/table";
import { useTheme } from "@/contexts/theme-context";
import { spotBalancesTableHeadings } from "@/lib/constants/farm";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useAquariusTokenBalance } from "@/hooks/use-farm";
import { useSoroswapTokenBalance } from "@/hooks/use-soroswap";

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
  const userAddress = useUserStore((s) => s.address);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const { balance: xlm } = useSoroswapTokenBalance(marginAccountAddress, "XLM");
  const { balance: aqUsdc } = useAquariusTokenBalance(marginAccountAddress, "USDC");
  const { balance: ssUsdc } = useSoroswapTokenBalance(marginAccountAddress, "USDC");

  const prices = useTokenPrices(["XLM", "USDC"]);

  const rows = useMemo(() => {
    const out: { cell: { title?: string; description?: string; chain?: string; titles?: string[]; tags?: string[] }[]; usd: number }[] = [];

    const entries: { symbol: "XLM" | "USDC"; venue: string; balance: string }[] = [
      { symbol: "XLM", venue: "Margin Account", balance: xlm },
      { symbol: "USDC", venue: "Aquarius", balance: aqUsdc },
      { symbol: "USDC", venue: "Soroswap", balance: ssUsdc },
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
  }, [xlm, aqUsdc, ssUsdc, prices]);

  const totalSpotUsd = rows.reduce((s, r) => s + r.usd, 0);

  const tableData = useMemo(
    () => ({
      headings: spotBalancesTableHeadings,
      body: { rows: rows.map(({ cell }) => ({ cell })) },
    }),
    [rows],
  );

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
      ) : rows.length === 0 ? (
        <div className={`w-full rounded-[16px] border px-5 py-10 text-center text-[14px] font-medium ${
          isDark ? "bg-[#222222] border-[#2A2A2A] text-[#777777]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#777777]"
        }`}>
          No spot balances yet. Swap on the Spot page to hold XLM/USDC directly in your margin account.
        </div>
      ) : (
        <Table
          filterDropdownPosition="left"
          heading={{ heading: "Spot Balances", tabType: "solid" }}
          filters={{ allChainDropdown: false, filters: [], filterTabType: "solid" }}
          tableHeadings={tableData.headings}
          tableBody={tableData.body}
        />
      )}
    </div>
  );
};
