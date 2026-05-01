'use client';

import { useState, useMemo, useEffect, useRef, memo } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import Image from "next/image";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { iconPaths } from "@/lib/constants";
import { InfoCard } from "../margin/info-card";
import { Button } from "../ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { useWithdrawLiquidity, usePoolData, useUserPositions } from "@/hooks/use-earn";
import { AssetType } from "@/lib/stellar-utils";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { STELLAR_POOLS } from "@/lib/constants/earn";

const POOL_OPTIONS = ["XLM", "BLUSDC", "AqUSDC", "SoUSDC"] as const;

const toInternalAsset = (value: string) => {
  if (value === 'AqUSDC' || value === 'AquiresUSDC' || value === 'AQUARIUS_USDC') return 'AQUARIUS_USDC';
  if (value === 'SoUSDC' || value === 'SoroswapUSDC' || value === 'SOROSWAP_USDC') return 'SOROSWAP_USDC';
  if (value === 'BLUSDC' || value === 'USDC') return 'USDC';
  return value;
};

const toDisplayAsset = (value: string) => {
  if (value === 'AQUARIUS_USDC' || value === 'AquiresUSDC') return 'AqUSDC';
  if (value === 'SOROSWAP_USDC' || value === 'SoroswapUSDC') return 'SoUSDC';
  if (value === 'USDC') return 'BLUSDC';
  return value;
};

export const WithdrawLiquidity = memo(function WithdrawLiquidity() {
  const { isDark } = useTheme();
  const router = useRouter();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const selectedOption = toDisplayAsset(selectedAsset);
  const normalizedAsset = toInternalAsset(selectedOption);

  const [shares, setShares] = useState<string>("");
  const [selectedPercentage, setSelectedPercentage] = useState<number>(0);
  const [poolDropdownOpen, setPoolDropdownOpen] = useState(false);
  const poolDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!poolDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (poolDropdownRef.current && !poolDropdownRef.current.contains(e.target as Node)) {
        setPoolDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [poolDropdownOpen]);

  const userAddress = useUserStore((state) => state.address);

  const { withdraw, isLoading, message } = useWithdrawLiquidity();

  // Toast instead of inline banner.
  const lastToastedRef = useRef<string>("");
  useEffect(() => {
    if (!message.text || message.text === lastToastedRef.current) return;
    lastToastedRef.current = message.text;
    if (message.type === "success") toast.success(message.text);
    else if (message.type === "error") toast.error(message.text);
    else toast(message.text);
  }, [message.text, message.type]);
  const { pools } = usePoolData();
  const { positions, refresh: refreshPositions } = useUserPositions();

  const selectedPool = pools[normalizedAsset as keyof typeof pools];
  const selectedPoolConfig = STELLAR_POOLS[normalizedAsset as keyof typeof STELLAR_POOLS];
  const userPosition = positions[normalizedAsset as keyof typeof positions];

  const vTokenBalance = parseFloat(userPosition?.vTokenBalance || '0');
  const exchangeRate = parseFloat(selectedPool?.exchangeRate || '1');
  const supplyAPY = parseFloat(selectedPool?.supplyAPY || '0');

  useEffect(() => {
    if (userAddress) refreshPositions();
  }, [userAddress, selectedAsset, refreshPositions]);

  useEffect(() => {
    setShares("");
    setSelectedPercentage(0);
  }, [selectedAsset]);

  const handlePercentageClick = (percent: number) => {
    setSelectedPercentage(percent);
    if (vTokenBalance > 0) {
      const calculatedAmount = (vTokenBalance * percent) / 100;
      setShares(calculatedAmount.toFixed(2).replace(/\.?0+$/, ""));
    }
  };

  const handleWithdraw = async () => {
    const numAmount = parseFloat(shares);
    if (numAmount > 0 && userAddress) {
      const isFullBalanceWithdraw =
        selectedPercentage === 100 || numAmount >= Math.max(0, vTokenBalance - 0.0000001);

      if (isFullBalanceWithdraw) {
        toast.error(`You cannot withdraw all your v${selectedOption}. Keep a small balance and try again.`);
        return;
      }

      const result = await withdraw(numAmount, normalizedAsset as AssetType);
      if (result.success) {
        setShares("");
        setSelectedPercentage(0);
        refreshPositions();
      }
    }
  };

  const sharesNum = parseFloat(shares) || 0;
  const assetsPreview = sharesNum * exchangeRate;

  const infoData = useMemo(() => ({
    youGetAsset: assetsPreview,
    tokenPerVToken: exchangeRate,
    currentAPY: supplyAPY,
    baseAPY: supplyAPY * 0.6,
    bonusAPY: supplyAPY * 0.1,
    rewardsAPY: supplyAPY * 0.3,
    projectedMonthlyFrom: 0,
    projectedMonthlyTo: 0,
    projectedYearlyFrom: 0,
    projectedYearlyTo: 0,
  }), [assetsPreview, exchangeRate, supplyAPY]);

  const infoPropsData = useMemo(() => ({
    data: infoData,
    expandableSections: [
      {
        title: "More Details",
        headingBold: false,
        defaultExpanded: false,
        items: [
          { id: "youGetAsset", name: `You Receive (${selectedOption})` },
          { id: "tokenPerVToken", name: `${selectedOption} per v${selectedOption}` },
          { id: "currentAPY", name: "Current APY (%)" },
        ],
      },
    ],
    showExpandable: true,
  }), [infoData, selectedOption]);

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (isLoading) return "Withdrawing...";
    if (!shares || parseFloat(shares) <= 0) return "Enter Amount";
    if (parseFloat(shares) > vTokenBalance) return "Insufficient Balance";
    return "Withdraw Liquidity";
  };

  const isButtonDisabled =
    !userAddress || isLoading || !shares || parseFloat(shares) <= 0 || parseFloat(shares) > vTokenBalance;

  return (
    <>
      {/* Input card */}
      <div className={`w-full rounded-2xl border flex flex-col ${
        isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
      }`}>
        <div className="flex items-center justify-between px-4 pt-4 pb-2 gap-3">
          {/* Token dropdown */}
          <div className="relative shrink-0" ref={poolDropdownRef}>
            <button
              type="button"
              onClick={() => setPoolDropdownOpen(!poolDropdownOpen)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer transition-colors ${
                isDark ? "bg-[#2A2A2A] hover:bg-[#333333]" : "bg-[#F0F0F0] hover:bg-[#E2E2E2]"
              }`}
              aria-haspopup="listbox"
              aria-expanded={poolDropdownOpen}
            >
              <Image
                src={iconPaths[selectedOption] || iconPaths[normalizedAsset] || "/icons/stellar.svg"}
                alt={selectedOption}
                width={20}
                height={20}
                className="rounded-full w-5 h-5 flex-none"
              />
              <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                v{selectedOption}
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className={`shrink-0 w-3.5 h-3.5 transition-transform duration-200 ${isDark ? "text-[#AAA]" : "text-[#555]"} ${poolDropdownOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            <AnimatePresence>
              {poolDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className={`absolute left-0 top-full mt-1 z-50 rounded-xl border shadow-lg overflow-hidden min-w-[140px] ${
                    isDark ? "bg-[#222222] border-[#333333]" : "bg-white border-[#E8E8E8]"
                  }`}
                  role="listbox"
                >
                  {POOL_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        setPoolDropdownOpen(false);
                        if (opt !== selectedOption) router.push(`/earn/${opt}`);
                      }}
                      className={`flex items-center gap-2 w-full px-4 py-2.5 text-[13px] font-medium transition-colors ${
                        opt === selectedOption
                          ? "text-[#703AE6]"
                          : isDark
                            ? "text-white hover:bg-[#333]"
                            : "text-[#111] hover:bg-[#F5F5F5]"
                      }`}
                      role="option"
                      aria-selected={opt === selectedOption}
                    >
                      <Image
                        src={iconPaths[opt] ?? "/icons/stellar.svg"}
                        alt={opt}
                        width={16}
                        height={16}
                        className="rounded-full"
                      />
                      v{opt}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {/* Amount input */}
          <div className="flex-1 min-w-0">
            <label htmlFor="withdraw-amount" className="sr-only">Withdraw Amount</label>
            <input
              id="withdraw-amount"
              onChange={(e) => {
                const sanitized = validateAmountChange(e.target.value);
                if (sanitized === null) return;
                setShares(sanitized);
                setSelectedPercentage(0);
              }}
              value={shares}
              type="text"
              inputMode="decimal"
              placeholder="0"
              disabled={isLoading}
              className={`w-full text-right text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-20 ${
                isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
              } ${isLoading ? "opacity-50" : ""}`}
            />
          </div>
        </div>

        {/* Balance / preview row + % pills */}
        <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-1.5 px-4 pb-3">
          <div className="flex items-center gap-1 flex-wrap">
            {DEPOSIT_PERCENTAGES.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={isLoading || vTokenBalance <= 0}
                onClick={() => handlePercentageClick(pct)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                transition={{ duration: 0.1 }}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                  selectedPercentage === pct
                    ? `${PERCENTAGE_COLORS[pct]} text-white border-transparent`
                    : isDark
                      ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                      : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                } ${isLoading || vTokenBalance <= 0 ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
          <span className={`text-[11px] font-medium whitespace-nowrap ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
            Balance: {userAddress ? `${vTokenBalance.toFixed(2)} v${selectedOption}` : `-- v${selectedOption}`}
          </span>
        </div>
      </div>

      <section className="flex flex-col gap-[8px]" aria-label="Withdraw Details">
        <InfoCard
          data={infoPropsData.data}
          expandableSections={infoPropsData.expandableSections}
          showExpandable={infoPropsData.showExpandable}
        />
      </section>

      <Button
        text={getButtonText()}
        size="large"
        type="gradient"
        disabled={isButtonDisabled}
        onClick={handleWithdraw}
      />


      {/* Contract Info */}
      <div className={`text-xs text-center ${isDark ? "text-gray-600" : "text-gray-400"}`}>
        Contract: {selectedPoolConfig?.lendingProtocol.slice(0, 8)}...{selectedPoolConfig?.lendingProtocol.slice(-8)}
      </div>
    </>
  );
});
