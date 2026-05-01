'use client';

import { useMemo } from "react";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { usePoolData } from "@/hooks/use-earn";
import { STELLAR_POOLS } from "@/lib/constants/earn";
import { useUserStore } from "@/store/user";

const tableHeadings = [
  { label: "Margin Manager", id: "margin-manager" },
  { label: "Current Debt", id: "current-debt" },
  { label: "Asset LT", id: "asset-lt" },
];

const shortenAddr = (addr: string) =>
  `${addr.slice(0, 6)}...${addr.slice(-4)}`;

export const MarginManagersTab = () => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const { pools, isLoading } = usePoolData();
  const userAddress = useUserStore((state) => state.address);

  const tableBody = useMemo(() => {
    return {
      rows: Object.entries(STELLAR_POOLS).map(([asset, config], index) => {
        const pool = pools[asset as keyof typeof pools];
        const supply = parseFloat(pool?.totalSupply || '0');
        const price = getPrice(asset);

        return {
          cell: [
            {
              title: `Tier #${index + 1}`,
              description: shortenAddr(config.lendingProtocol),
            },
            {
              title: `${supply.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${asset}`,
              description: `$${(supply * price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            },
            {
              title: `${Object.keys(STELLAR_POOLS).length} assets`,
            },
          ],
        };
      }),
    };
  }, [pools, getPrice]);

  if (!userAddress) {
    return (
      <section className="w-full h-fit" aria-label="Margin Managers Overview">
        <div className={`w-full h-[200px] border-[1px] rounded-[8px] flex items-center justify-center ${
          isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
        }`}>
          <p className={`text-[14px] font-medium ${
            isDark ? "text-[#919191]" : "text-[#76737B]"
          }`}>
            Connect your wallet to view margin managers
          </p>
        </div>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className="w-full h-fit" aria-label="Margin Managers Overview">
        <div className={`w-full h-[200px] border-[1px] rounded-[8px] flex items-center justify-center ${
          isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
        }`}>
          <p className={`text-[14px] font-medium ${
            isDark ? "text-[#919191]" : "text-[#76737B]"
          }`}>
            Loading margin managers...
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="w-full h-fit" aria-label="Margin Managers Overview">
      <article aria-label="Margin Managers List">
        <Table
          heading={{}}
          tableHeadings={tableHeadings}
          tableBody={tableBody}
        />
      </article>
    </section>
  );
};
