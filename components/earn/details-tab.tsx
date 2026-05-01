'use client';

import { useMemo } from "react";
import { StatsCard } from "../ui/stats-card";
import { formatValue } from "@/lib/utils/format-value";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { usePoolData } from "@/hooks/use-earn";
import { STELLAR_POOLS } from "@/lib/constants/earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

// Static export for use in other pages (e.g. farm detail page)
export const items = [
  { heading: "Available Liquidity", mainInfo: "—", subInfo: "—", tooltip: "Total assets available for borrowing" },
  { heading: "Supply APY", mainInfo: "—", subInfo: "—", tooltip: "Annual percentage yield for suppliers" },
  { heading: "Borrow APY", mainInfo: "—", tooltip: "Annual percentage yield for borrowers" },
  { heading: "Utilization Rate", mainInfo: "—", tooltip: "Ratio of borrowed assets to supplied assets" },
  { heading: "Liquidation Penalty", mainInfo: "Dynamic Range", subInfo: "0–15%", tooltip: "Penalty applied during liquidation events" },
  { heading: "Oracle Price", mainInfo: "—", tooltip: "Current oracle price of the asset" },
  { heading: "Exchange Rate", mainInfo: "—", subInfo: "—", tooltip: "Exchange rate between vToken and underlying asset" },
];

const shortenAddress = (addr: string | undefined): string => {
  if (!addr) return "N/A";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
};

const STELLAR_EXPLORER = "https://stellar.expert/explorer/testnet/contract";

const toInternalAsset = (value: string) => {
  if (value === "AqUSDC" || value === "AquiresUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SoroswapUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  return value;
};

const toDisplayAsset = (value: string) => {
  if (value === "AQUARIUS_USDC" || value === "AquiresUSDC") return "AqUSDC";
  if (value === "SOROSWAP_USDC" || value === "SoroswapUSDC") return "SoUSDC";
  return value;
};

const getAddresses = (selectedAssetKey: string, selectedAssetLabel: string) => {
  const pool = STELLAR_POOLS[selectedAssetKey as keyof typeof STELLAR_POOLS];
  const lendingKey = `LENDING_PROTOCOL_${selectedAssetKey}` as keyof typeof CONTRACT_ADDRESSES;
  const vTokenKey = `V${selectedAssetKey}_TOKEN` as keyof typeof CONTRACT_ADDRESSES;
  const lendingAddr = (CONTRACT_ADDRESSES[lendingKey] as string) || pool?.lendingProtocol || "";
  const vTokenAddr = (CONTRACT_ADDRESSES[vTokenKey] as string) || pool?.vToken || "";

  return [
    { heading: `v${selectedAssetLabel} Token`, addr: vTokenAddr, tooltip: `Receipt token for ${selectedAssetLabel} deposits` },
    { heading: `${selectedAssetLabel} Lending Protocol`, addr: lendingAddr, tooltip: `Main lending contract for ${selectedAssetLabel}` },
    { heading: "Risk Engine", addr: CONTRACT_ADDRESSES.RISK_ENGINE, tooltip: "Risk management and liquidation parameters" },
    { heading: "Oracle Contract", addr: CONTRACT_ADDRESSES.ORACLE, tooltip: "Price oracle for asset valuations" },
    { heading: "Interest Rate Model", addr: CONTRACT_ADDRESSES.RATE_MODEL, tooltip: "Defines borrowing and lending interest rates" },
    { heading: "Registry Contract", addr: CONTRACT_ADDRESSES.REGISTRY, tooltip: "Protocol registry for all contracts" },
  ];
};

export const Details = () => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const selectedAssetKey = toInternalAsset(selectedAsset);
  const selectedAssetLabel = toDisplayAsset(selectedAssetKey);
  const { pools, isLoading } = usePoolData();

  const selectedPool = pools[selectedAssetKey as keyof typeof pools];
  const addresses = getAddresses(selectedAssetKey, selectedAssetLabel);
  const assetPrice = getPrice(selectedAssetKey);

  const totalSupplied = useMemo(() => {
    const supply = parseFloat(selectedPool?.totalSupply || '0');
    return { inToken: supply, inUsd: supply * assetPrice };
  }, [selectedPool, assetPrice]);

  const totalBorrowed = useMemo(() => {
    const borrowed = parseFloat(selectedPool?.totalBorrowed || '0');
    return { inToken: borrowed, inUsd: borrowed * assetPrice };
  }, [selectedPool, assetPrice]);

  const borrowedPercent = Math.min(Math.max(parseFloat(selectedPool?.utilizationRate || '0') || 0, 0), 100);
  const suppliedPercent = totalSupplied.inToken > 0 ? (100 - borrowedPercent) : 0;

  const detailItems = useMemo(() => [
    {
      heading: "Available Liquidity",
      mainInfo: `${formatValue(parseFloat(selectedPool?.availableLiquidity || '0'), { type: "number", useLargeFormat: true })} ${selectedAssetLabel}`,
      subInfo: `$${formatValue(parseFloat(selectedPool?.availableLiquidity || '0') * assetPrice, { type: "number", useLargeFormat: true })}`,
      tooltip: `Total ${selectedAssetLabel} available for borrowing`,
    },
    {
      heading: "Supply APY",
      mainInfo: `${selectedPool?.supplyAPY || '0'}%`,
      subInfo: `${formatValue(totalSupplied.inToken, { type: "number", useLargeFormat: true })} ${selectedAssetLabel}`,
      tooltip: "Annual percentage yield for suppliers",
    },
    {
      heading: "Borrow APY",
      mainInfo: `${selectedPool?.borrowAPY || '0'}%`,
      tooltip: "Annual percentage yield for borrowers",
    },
    {
      heading: "Utilization Rate",
      mainInfo: `${selectedPool?.utilizationRate || '0'}%`,
      tooltip: "Ratio of borrowed assets to supplied assets",
    },
    {
      heading: "Liquidation Penalty",
      mainInfo: "Dynamic Range",
      subInfo: "0–15%",
      tooltip: "Penalty applied during liquidation events",
    },
    {
      heading: "Oracle Price",
      mainInfo: `$${assetPrice.toFixed(assetPrice < 1 ? 4 : 2)}`,
      tooltip: `Current oracle price of ${selectedAssetLabel}`,
    },
    {
      heading: "Share Token Exchange Rate",
      mainInfo: selectedPool?.exchangeRate || '1.0000',
      tooltip: `Exchange rate between v${selectedAssetLabel} and ${selectedAssetLabel}`,
    },
  ], [selectedPool, selectedAssetKey, selectedAssetLabel, totalSupplied.inToken, assetPrice]);

  return (
    <section className={`w-full h-fit flex flex-col gap-[14px] rounded-[16px] border-[1px] ${
      isDark ? "bg-[#111111]" : "bg-[#F4F4F4]"
    }`} aria-label="Vault Details">
      <div className="w-full h-fit rounded-[16px] pt-[16px] px-3 sm:px-[20px] flex flex-col gap-[14px]">
        <h2 className={`w-full h-fit text-[18px] sm:text-[21px] font-semibold ${
          isDark ? "text-white" : ""
        }`}>Statistics</h2>
        <article className={`w-full h-fit flex flex-col sm:flex-row items-center rounded-[14px] gap-[12px] ${
          isDark ? "bg-[#222222]" : "bg-[#FFFFFF]"
        }`} aria-label="Supply and Borrow Overview">
          {isLoading ? (
            <div className={`w-full h-[120px] flex items-center justify-center text-[14px] ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}>
              Loading vault statistics...
            </div>
          ) : (
            <>
              <StatsCard
                percentage={suppliedPercent}
                heading="Total Supplied"
                mainInfo={`${formatValue(totalSupplied.inToken, { type: "number", useLargeFormat: true })} ${selectedAssetLabel}`}
                subInfo={`$${formatValue(totalSupplied.inUsd, { type: "number", useLargeFormat: true })}`}
                pie={true}
              />
              <StatsCard
                percentage={borrowedPercent}
                heading="Total Borrowed"
                mainInfo={`${formatValue(totalBorrowed.inToken, { type: "number", useLargeFormat: true })} ${selectedAssetLabel}`}
                subInfo={`$${formatValue(totalBorrowed.inUsd, { type: "number", useLargeFormat: true })}`}
                pie={true}
              />
            </>
          )}
        </article>
        {/* Desktop: grid layout */}
        <article className="hidden sm:grid w-full h-full grid-cols-3 gap-x-3 gap-y-1" aria-label="Vault Statistics">
          {isLoading ? (
            <div className={`col-span-3 h-[200px] flex items-center justify-center text-[14px] ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}>
              Loading statistics...
            </div>
          ) : (
            detailItems.map((item, idx) => (
              <StatsCard
                key={idx}
                heading={item.heading}
                mainInfo={item.mainInfo}
                subInfo={item.subInfo}
                tooltip={item.tooltip}
              />
            ))
          )}
        </article>
        {/* Mobile: clean key-value rows */}
        <article className={`sm:hidden w-full rounded-xl overflow-hidden border ${isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]"}`} aria-label="Vault Statistics">
          {isLoading ? (
            <div className={`h-[120px] flex items-center justify-center text-[14px] ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}>
              Loading statistics...
            </div>
          ) : (
            detailItems.map((item, idx) => (
              <div key={idx} className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#1A1A1A]" : "bg-white"}`}>
                <span className={`text-[12px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
                  {item.heading}
                </span>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                    {item.mainInfo}
                  </span>
                  {item.subInfo && (
                    <span className={`text-[11px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
                      {item.subInfo}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </article>
        <article className="w-full h-fit rounded-[16px] pb-[20px] flex flex-col gap-3" aria-label="Contract Addresses">
          <h3 className={`text-[18px] sm:text-[21px] font-semibold w-full h-fit ${
            isDark ? "text-white" : ""
          }`}>
            Addresses
          </h3>
          {/* Desktop: grid */}
          <div className="hidden sm:grid w-full h-full grid-cols-2 lg:grid-cols-3 gap-x-[12px]">
            {addresses.map((item, idx) => (
              <StatsCard
                key={idx}
                heading={item.heading}
                address={shortenAddress(item.addr)}
                fullAddress={item.addr}
                explorerUrl={STELLAR_EXPLORER}
                tooltip={item.tooltip}
              />
            ))}
          </div>
          {/* Mobile: clean rows */}
          <div className={`sm:hidden w-full rounded-xl overflow-hidden border ${isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]"}`}>
            {addresses.map((item, idx) => (
              <div key={idx} className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#1A1A1A]" : "bg-white"}`}>
                <span className={`text-[12px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
                  {item.heading}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                    {shortenAddress(item.addr)}
                  </span>
                  {item.addr && (
                    <a href={`${STELLAR_EXPLORER}/${item.addr}`} target="_blank" rel="noopener noreferrer" className="opacity-50 hover:opacity-100">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
};
