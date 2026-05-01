'use client';

import { useMemo } from "react";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { usePoolData } from "@/hooks/use-earn";
import { STELLAR_POOLS } from "@/lib/constants/earn";
import { iconPaths } from "@/lib/constants";

const tableHeadings = [
  { label: "Assets", id: "assets" },
  { label: "Limits Usage", id: "limits-usage" },
];

// Map internal asset key → display symbol
const DISPLAY_SYMBOL: Record<string, string> = {
  XLM: "XLM",
  USDC: "BLUSDC",
  AQUARIUS_USDC: "AqUSDC",
  SOROSWAP_USDC: "SoUSDC",
};

// Supply caps per asset (token units)
const SUPPLY_CAPS: Record<string, number> = {
  XLM: 10000000,
  USDC: 1000000,
  AQUARIUS_USDC: 1000000,
  SOROSWAP_USDC: 1000000,
};

export const CollateralLimitsTab = () => {
  const { isDark } = useTheme();
  const { pools, isLoading } = usePoolData();

  const tableBody = useMemo(() => ({
    rows: Object.entries(STELLAR_POOLS).map(([asset]) => {
      const pool = pools[asset as keyof typeof pools];
      const displaySymbol = DISPLAY_SYMBOL[asset] ?? asset;
      const supply = parseFloat(pool?.totalSupply || '0');
      const supplyCap = SUPPLY_CAPS[asset] ?? 1000000;

      const supplyUsage = Math.min((supply / supplyCap) * 100, 100);
      const capLabel = supplyCap >= 1000000
        ? `${(supplyCap / 1000000).toFixed(0)}M`
        : `${(supplyCap / 1000).toFixed(0)}K`;

      return {
        cell: [
          {
            icon: iconPaths[displaySymbol] || "/icons/usdc-icon.svg",
            title: displaySymbol,
            description: `v${displaySymbol} Pool`,
          },
          {
            percentage: supplyUsage,
            value: `${supply.toLocaleString(undefined, { maximumFractionDigits: 2 })} of ${capLabel}`,
          },
        ],
      };
    }),
  }), [pools]);

  if (isLoading) {
    return (
      <section className="w-full h-fit" aria-label="Collateral Limits Overview">
        <div className={`w-full h-[200px] border-[1px] rounded-[8px] flex items-center justify-center ${
          isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
        }`}>
          <p className={`text-[14px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
            Loading collateral and limits...
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="w-full h-fit" aria-label="Collateral Limits Overview">
      <article aria-label="Asset Limits Usage">
        <Table
          heading={{}}
          tableHeadings={tableHeadings}
          tableBody={tableBody}
          showProgressBar={true}
        />
      </article>
    </section>
  );
};
