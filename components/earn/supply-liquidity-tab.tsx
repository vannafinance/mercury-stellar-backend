'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import toast from "react-hot-toast";
import { Dropdown } from "../ui/dropdown";
import { DropdownOptions } from "@/lib/constants";
import { STELLAR_POOLS } from "@/lib/constants/earn";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { useSupplyLiquidity, usePoolData, useUserPositions } from "@/hooks/use-earn";
import { AssetType, ContractService } from "@/lib/stellar-utils";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

export const SupplyLiquidityTab = () => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const [selectedOption, setSelectedOption] = useState<string>("XLM");
  const [value, setValue] = useState<string>("");
  const [selectedPercentage, setSelectedPercentage] = useState<number | null>(null);
  
  const userAddress = useUserStore((state) => state.address);
  const balance = useUserStore((state) => state.balance);
  const tokenBalances = useUserStore((state) => state.tokenBalances);
  
  const { supply, isLoading, message } = useSupplyLiquidity();
  const { pools } = usePoolData();
  const { refresh: refreshPositions } = useUserPositions();

  // Surface supply result as a bottom-left toast (replaces inline banner).
  const lastToastedRef = useRef<string>("");
  useEffect(() => {
    if (!message.text || message.text === lastToastedRef.current) return;
    lastToastedRef.current = message.text;
    if (message.type === "success") toast.success(message.text);
    else if (message.type === "error") toast.error(message.text);
    else toast(message.text);
  }, [message.text, message.type]);

  // Fetch all token balances when user connects
  const refreshTokenBalances = useCallback(async () => {
    if (!userAddress) return;
    
    try {
      const balances = await ContractService.getAllTokenBalances(userAddress);
      useUserStore.getState().set({
        tokenBalances: balances,
        balance: balances.XLM, // Also update native XLM balance
      });
    } catch (error) {
      console.error('Error fetching token balances:', error);
    }
  }, [userAddress]);

  // Refresh positions and token balances when user connects
  useEffect(() => {
    if (userAddress) {
      refreshPositions();
      refreshTokenBalances();
    }
  }, [userAddress, refreshPositions, refreshTokenBalances]);

  // Get pool stats for selected asset
  const normalizedAsset =
    selectedOption === 'BLUSDC' || selectedOption === 'USDC'
      ? 'USDC'
      : selectedOption === 'AqUSDC' || selectedOption === 'AquiresUSDC'
        ? 'AQUARIUS_USDC'
        : selectedOption === 'SoUSDC' || selectedOption === 'SoroswapUSDC'
          ? 'SOROSWAP_USDC'
          : selectedOption;
  const selectedPool = pools[normalizedAsset as keyof typeof pools];
  const selectedPoolConfig = STELLAR_POOLS[normalizedAsset as keyof typeof STELLAR_POOLS];

  // Calculate available balance based on selected asset
  const availableBalance = useMemo(() => {
    if (normalizedAsset === 'XLM') {
      // For XLM, use native balance minus some reserve for fees
      const xlmBalance = parseFloat(tokenBalances?.XLM || balance) || 0;
      return Math.max(0, xlmBalance - 1).toFixed(2); // Keep 1 XLM for fees
    } else if (normalizedAsset === 'USDC') {
      return tokenBalances?.BLEND_USDC || tokenBalances?.USDC || '0';
    } else if (normalizedAsset === 'AQUARIUS_USDC') {
      return tokenBalances?.AQUARIUS_USDC || '0';
    } else if (normalizedAsset === 'SOROSWAP_USDC') {
      return tokenBalances?.SOROSWAP_USDC || '0';
    }
    return '0';
  }, [normalizedAsset, balance, tokenBalances]);

  // Handle percentage button click
  const handlePercentageClick = (percent: number) => {
    setSelectedPercentage(percent);
    const maxAmount = parseFloat(availableBalance) || 0;
    const calculatedAmount = (maxAmount * percent / 100).toFixed(2);
    setValue(calculatedAmount);
  };

  // Handle supply action
  const handleSupply = async () => {
    const numAmount = parseFloat(value);
    if (numAmount > 0 && userAddress) {
      const isFullBalanceSupply =
        selectedPercentage === 100 || numAmount >= Math.max(0, parseFloat(availableBalance) - 0.0000001);

      if (isFullBalanceSupply) {
        toast.error(`You cannot supply all your ${selectedOption}. Keep a small balance and try again.`);
        return;
      }

      const result = await supply(numAmount, normalizedAsset as AssetType);
      if (result.success) {
        setValue("");
        setSelectedPercentage(null);
        // Refresh positions and balances after successful deposit
        setTimeout(() => {
          refreshPositions();
          refreshTokenBalances();
        }, 2000);
      }
    }
  };

  // Calculate estimated vTokens to receive
  const estimatedVTokens = useMemo(() => {
    const amount = parseFloat(value) || 0;
    if (amount <= 0) return '0';
    
    const exchangeRate = parseFloat(selectedPool?.exchangeRate || '1');
    if (exchangeRate <= 0) return amount.toFixed(2);

    return (amount / exchangeRate).toFixed(2);
  }, [value, selectedPool]);

  // Get button text
  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (isLoading) return "Processing...";
    if (!value || parseFloat(value) <= 0) return "Enter Amount";
    if (parseFloat(value) > parseFloat(availableBalance)) return "Insufficient Balance";
    return `Supply ${value} ${selectedOption}`;
  };

  const isButtonDisabled = 
    !userAddress || 
    isLoading || 
    !value || 
    parseFloat(value) <= 0 || 
    parseFloat(value) > parseFloat(availableBalance);

  return (
    <div className="flex flex-col gap-4">
      {/* Asset Selection & Amount Input */}
      <div className={`flex flex-col gap-4 w-full h-fit border rounded-[16px] p-4 ${
        isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-gray-200"
      }`}>
        {/* Asset Selector */}
        <div className="flex justify-between items-center">
          <label className={`text-sm font-medium ${isDark ? "text-gray-400" : "text-gray-600"}`}>
            Select Asset
          </label>
          <Dropdown
            items={DropdownOptions}
            setSelectedOption={setSelectedOption}
            selectedOption={selectedOption}
            classname="w-fit gap-[4px] items-center"
            dropdownClassname="w-full"
          />
        </div>

        {/* Amount Input */}
        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-center">
            <input
              type="text"
              inputMode="decimal"
              value={value}
              onChange={(e) => {
                const sanitized = validateAmountChange(e.target.value);
                if (sanitized === null) return;
                setValue(sanitized);
                setSelectedPercentage(null);
              }}
              placeholder="0.00"
              step="0.0000001"
              min="0"
              className={`w-full text-2xl font-bold outline-none bg-transparent ${
                isDark ? "text-white placeholder-gray-600" : "text-gray-900 placeholder-gray-400"
              }`}
            />
            <span className={`text-sm font-medium ${isDark ? "text-gray-400" : "text-gray-600"}`}>
              {selectedOption}
            </span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>
              ≈ ${(parseFloat(value) * getPrice(selectedOption) || 0).toFixed(2)} USD
            </span>
            <span className={`text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>
              Available: {(parseFloat(String(availableBalance)) || 0).toFixed(2)} {selectedOption}
            </span>
          </div>
        </div>

        {/* Percentage Buttons */}
        <div className="flex gap-2">
          {DEPOSIT_PERCENTAGES.map((percent) => (
            <button
              key={percent}
              type="button"
              onClick={() => handlePercentageClick(percent)}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                selectedPercentage === percent
                  ? `${PERCENTAGE_COLORS[percent]} text-white`
                  : isDark
                  ? "bg-[#222222] text-gray-300 hover:bg-[#333333]"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {percent}%
            </button>
          ))}
        </div>
      </div>

      {/* Pool Stats Card */}
      <div className={`rounded-[16px] p-4 ${
        isDark ? "bg-[#111111] border border-[#333333]" : "bg-gray-50 border border-gray-200"
      }`}>
        <h3 className={`text-sm font-semibold mb-3 ${isDark ? "text-white" : "text-gray-900"}`}>
          Pool Statistics
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col">
            <span className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>Supply APY</span>
            <span className={`text-lg font-bold text-green-500`}>
              {selectedPool?.supplyAPY || '0'}%
            </span>
          </div>
          <div className="flex flex-col">
            <span className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>Total Supply</span>
            <span className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
              {parseFloat(selectedPool?.totalSupply || '0').toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {selectedOption}
            </span>
          </div>
          <div className="flex flex-col">
            <span className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>Utilization</span>
            <span className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
              {selectedPool?.utilizationRate || '0'}%
            </span>
          </div>
          <div className="flex flex-col">
            <span className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>Available</span>
            <span className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
              {parseFloat(selectedPool?.availableLiquidity || '0').toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {selectedOption}
            </span>
          </div>
        </div>
      </div>

      {/* You Will Receive Card */}
      {value && parseFloat(value) > 0 && (
        <div className={`rounded-[16px] p-4 border-2 border-dashed ${
          isDark ? "bg-[#0D1117] border-[#703AE6]/30" : "bg-purple-50 border-purple-200"
        }`}>
          <div className="flex justify-between items-center">
            <div className="flex flex-col">
              <span className={`text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>
                You will receive
              </span>
              <span className={`text-xl font-bold ${isDark ? "text-white" : "text-gray-900"}`}>
                {estimatedVTokens} v{selectedOption}
              </span>
            </div>
            <div className={`p-2 rounded-full ${isDark ? "bg-[#703AE6]/20" : "bg-purple-100"}`}>
              <svg className="w-6 h-6 text-[#703AE6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
          </div>
          <p className={`text-xs mt-2 ${isDark ? "text-gray-500" : "text-gray-400"}`}>
            v{selectedOption} tokens represent your share in the lending pool and accrue interest over time.
          </p>
        </div>
      )}

      {/* Supply Button */}
      <button
        onClick={handleSupply}
        disabled={isButtonDisabled}
        className={`w-full py-4 rounded-xl font-semibold text-white transition-all ${
          isButtonDisabled
            ? "bg-gray-500 cursor-not-allowed opacity-50"
            : "bg-gradient-to-r from-[#703AE6] to-[#FF007A] hover:opacity-90 cursor-pointer"
        }`}
      >
        {getButtonText()}
      </button>

      {/* Contract Info */}
      <div className={`text-xs text-center ${isDark ? "text-gray-600" : "text-gray-400"}`}>
        Contract: {selectedPoolConfig?.lendingProtocol.slice(0, 8)}...{selectedPoolConfig?.lendingProtocol.slice(-8)}
      </div>
    </div>
  );
};
