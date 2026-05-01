import { DropdownOptions } from "@/lib/constants";
import { Dropdown } from "../ui/dropdown";
import { useState, useEffect, useCallback } from "react";
import { LeverageSlider } from "../ui/leverage-slider";
import { BorrowInfo } from "@/lib/types";
import { motion } from "framer-motion";
import { MAX_LEVERAGE, MODE_CONFIG } from "@/lib/constants/margin";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";

type Mode = "Deposit" | "Borrow";

interface BorrowBoxProps {
  mode?: Mode;
  leverage: number;
  setLeverage: (value: number) => void;
  totalDeposit: number;
  onBorrowItemsChange?: (items: BorrowInfo[]) => void;
  onTokenChange?: (token: string) => void;
}

export const BorrowBox = ({
  mode = "Deposit",
  leverage,
  setLeverage,
  totalDeposit,
  onBorrowItemsChange,
  onTokenChange,
}: BorrowBoxProps) => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();

  const getCollateralBalanceKey = (symbol: string) => {
    if (symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC") return "BLUSDC";
    if (symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC") return "AQUSDC";
    if (symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC") return "SOUSDC";
    return symbol;
  };
  const getBorrowedBalanceKey = (symbol: string) => {
    if (symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC") return "BLUSDC";
    if (symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC") return "AQUSDC";
    if (symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC") return "SOUSDC";
    return symbol;
  };
  const config = MODE_CONFIG[mode];

  // Store access
  const collateralBalances = useMarginAccountInfoStore((state) => state.collateralBalances);
  const borrowedBalances = useMarginAccountInfoStore((state) => state.borrowedBalances);

  // Form state
  const [selectedOptions, setSelectedOptions] = useState<
    Record<number, string>
  >({});
  const [selectedAmountType, setSelectedAmountType] = useState<string>("Amount in %");
  const [inputValues, setInputValues] = useState<Record<number, number>>({});

  const selectedToken = selectedOptions[0] || DropdownOptions[0];
  const selectedCollateralKey = getCollateralBalanceKey(selectedToken);
  const selectedTokenPrice = getPrice(selectedCollateralKey);

  // Borrow preview based on selected leverage: borrow = deposit * (leverage - 1)
  // totalDeposit is in USD, so divide by token price to get the token amount to display.
  const previewBorrowableUsd = Math.max(0, totalDeposit * (leverage - 1));
  const previewBorrowableAmount = selectedTokenPrice > 0 ? previewBorrowableUsd / selectedTokenPrice : 0;

  // Notify parent when selected borrow token changes
  useEffect(() => {
    if (onTokenChange) {
      onTokenChange(selectedOptions[0] || DropdownOptions[0]);
    }
  }, [selectedOptions[0], onTokenChange]);

  // Combined useEffect: Create BorrowInfo items and notify parent
  useEffect(() => {
    const newBorrowItems: BorrowInfo[] = [];

    for (let idx = 0; idx < config.maxItems; idx++) {
      const selectedOption = selectedOptions[idx];
      const inputValue = inputValues[idx] || 0;

      if (selectedOption && inputValue > 0) {
        // Calculate percentage of total deposit
        const percentage =
          totalDeposit > 0 ? (inputValue / totalDeposit) * 100 : 0;

        newBorrowItems.push({
          assetData: {
            asset: `0x${selectedOption}`,
            amount: inputValue.toString(),
          },
          percentage: Number(percentage.toFixed(2)),
          usdValue: inputValue, // 1:1 conversion
        });
      }
    }

    // Directly call parent callback
    if (onBorrowItemsChange) {
      onBorrowItemsChange(newBorrowItems);
    }
  }, [selectedOptions, inputValues, config.maxItems, totalDeposit, onBorrowItemsChange]);

  // Calculate total borrowed value inline (simple calculation)
  const totalBorrowedValue = mode === "Borrow" 
    ? (inputValues[0] || 0) + (inputValues[1] || 0)
    : (inputValues[0] || 0);

  // Simplified UI visibility flags
  const showTotal = config.showTotal;

  // Handler for max leverage click
  const handleMaxLeverage = useCallback(() => {
    setLeverage(MAX_LEVERAGE);
  }, [setLeverage]);

  // Handler for selected option change - memoized to prevent re-renders
  const handleSetSelectedOption = useCallback((idx: number) => {
    return (
      option:
        | string
        | ((prev: string) => string)
    ) => {
      setSelectedOptions((prev) => {
        const currentValue = prev[idx];
        const selected =
          typeof option === "function"
            ? option(currentValue || DropdownOptions[0])
            : option;
        return {
          ...prev,
          [idx]: selected,
        };
      });
    };
  }, []);

  // Handler for input change - memoized to prevent re-renders
  const handleInputChange = useCallback((idx: number) => {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value) || 0;
      setInputValues((prev) => ({
        ...prev,
        [idx]: value,
      }));
    };
  }, []);


  const handleLeverageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    // Allow empty string for better UX while typing
    if (inputValue === "") {
      setLeverage(0);
      return;
    }
    const value = Number(inputValue);
    // Validate: must be a number, between 0 and MAX_LEVERAGE
    if (!isNaN(value)) {
      const clampedValue = Math.max(0, Math.min(MAX_LEVERAGE, value));
      setLeverage(clampedValue);
    }
  }, [setLeverage, MAX_LEVERAGE]);

  const bgColor = isDark ? "#1A1A1A" : "#ffffff";

  return (
    <motion.section
      className="w-full min-w-0 flex flex-col gap-3"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* ── Deposit mode card ─────────────────────────────────────────────── */}
      {mode === "Deposit" && (
        <article
          className={`rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 transition-colors ${
            isDark
              ? "bg-[#1A1A1A] border border-[#2A2A2A]"
              : "bg-white border border-[#EEEEEE]"
          }`}
        >
          {/* Row 1: "Borrow" label + Max Value chip */}
          <div className="flex items-center justify-between">
            <span
              className={`text-sm font-medium ${
                isDark ? "text-[#A7A7A7]" : "text-[#888888]"
              }`}
            >
              Borrow
            </span>
            <motion.div
              className={`px-3 py-1 rounded-lg shrink-0 cursor-pointer text-[11px] font-semibold whitespace-nowrap transition-colors ${
                leverage === MAX_LEVERAGE ? "text-white" : isDark ? "text-white" : "text-[#111111]"
              }`}
              style={
                leverage === MAX_LEVERAGE
                  ? { background: "linear-gradient(135deg, #FC5457 10%, #703AE6 80%)", border: "1.20px solid transparent" }
                  : {
                      background: `linear-gradient(${bgColor}, ${bgColor}) padding-box, linear-gradient(135deg, #FC5457 10%, #703AE6 80%) border-box`,
                      border: "1.20px solid transparent",
                    }
              }
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
              onClick={handleMaxLeverage}
              role="button"
              aria-label="Set maximum leverage"
            >
              Max Value
            </motion.div>
          </div>

          {/* Row 2: token dropdown + borrow amount display */}
          <div className="flex items-center justify-between gap-2">
            <div className="shrink-0">
              <Dropdown
                dropdownClassname="text-[14px] gap-2"
                items={DropdownOptions}
                selectedOption={selectedOptions[0] || DropdownOptions[0]}
                setSelectedOption={handleSetSelectedOption(0)}
                classname={`gap-2 px-3 py-2 rounded-full! text-[14px] font-semibold transition-colors ${
                  isDark
                    ? "bg-[#2A2A2A] hover:bg-[#333333] text-white"
                    : "bg-[#EEEEEE] hover:bg-[#E2E2E2] text-[#111111]"
                }`}
              />
            </div>
            <p
              className={`flex-1 min-w-0 text-[22px] sm:text-[28px] font-semibold text-right ${
                isDark ? "text-white" : "text-[#111111]"
              } ${previewBorrowableAmount <= 0 ? "opacity-20" : ""}`}
            >
              {previewBorrowableAmount > 0 ? previewBorrowableAmount.toFixed(2) : "0"}
            </p>
          </div>

          {/* Row 3: balance + ≈ USD */}
          <div
            className={`flex items-center justify-between text-[12px] font-medium ${
              isDark ? "text-[#777777]" : "text-[#A7A7A7]"
            }`}
          >
            <span>
              Balance:{" "}
              {collateralBalances[selectedCollateralKey]
                ? parseFloat(collateralBalances[selectedCollateralKey].amount).toFixed(2)
                : "0.00"}{" "}
              {selectedToken}
            </span>
            <span>
              ≈{" "}
              {previewBorrowableUsd.toFixed(2)}{" "}
              USD
            </span>
          </div>
        </article>
      )}

      {/* ── Borrow mode — stacked input cards ─────────────────────────────── */}
      {mode === "Borrow" && (
        <motion.div
          className="w-full min-w-0 flex flex-col gap-3"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          {/* Borrowed Amount + Total Borrowable header */}
          <div className="flex items-start justify-between gap-3 min-w-0 w-full">
            <div className="flex flex-col gap-1.5 min-w-0">
              <span className={`text-[13px] font-medium ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                Borrowed Amount:
              </span>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {Array.from({ length: config.maxItems }).map((_, idx) => {
                  const selectedOption = selectedOptions[idx] || DropdownOptions[0];
                  const balKey = getBorrowedBalanceKey(selectedOption);
                  const balance = borrowedBalances[balKey];
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="flex flex-col gap-0.5">
                        <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                          {balance ? parseFloat(balance.amount).toFixed(2) : "0.00"} {selectedOption}
                        </span>
                        <span className={`text-[11px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
                          {balance ? parseFloat(balance.usdValue).toFixed(2) : "0.00"} USD
                        </span>
                      </div>
                      {idx < config.maxItems - 1 && (
                        <span className={`text-[16px] font-bold px-0.5 ${isDark ? "text-[#555555]" : "text-[#CCCCCC]"}`}>:</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {showTotal && (
              <div className="flex flex-col items-end gap-1 shrink-0 max-w-40 text-right">
                <span className={`text-[13px] font-medium leading-tight ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                  Total Borrowable Amount:
                </span>
                <span className={`text-[15px] font-bold ${isDark ? "text-white" : "text-[#111111]"}`}>
                  ${totalBorrowedValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </div>

          <div className="w-full min-w-0 flex flex-col gap-2">
            {Array.from({ length: config.maxItems }).map((_, idx) => {
              const selectedOption = selectedOptions[idx] || DropdownOptions[0];
              const inputValue = inputValues[idx] || 0;

              return (
                <motion.div
                  key={idx}
                  className="w-full min-w-0"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3, delay: idx * 0.1 }}
                >
                  <article
                    className={`w-full min-w-0 rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 transition-colors ${
                      isDark
                        ? "bg-[#1A1A1A] border border-[#2A2A2A]"
                        : "bg-white border border-[#EEEEEE]"
                    }`}
                  >
                    {/* Row 1: amount type selector */}
                    <div className="flex items-center justify-start sm:justify-between gap-2">
                      <span
                        className={`hidden sm:inline text-sm font-medium ${
                          isDark ? "text-[#A7A7A7]" : "text-[#777777]"
                        }`}
                      >
                        Borrow
                      </span>
                      <Dropdown
                        dropdownClassname="text-[13px] gap-2"
                        items={["Amount in %", "Amount in $"]}
                        selectedOption={selectedAmountType}
                        setSelectedOption={setSelectedAmountType}
                        classname={`gap-1 text-[10px] sm:text-[12px] font-semibold rounded-full! px-2 py-1 whitespace-nowrap ${
                          isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#F0F0F0] text-[#888888]"
                        }`}
                        arrowClassname="size-3"
                      />
                    </div>

                    {/* Row 2: token selector + input */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="shrink-0">
                        <Dropdown
                          dropdownClassname="text-[13px] gap-2"
                          items={DropdownOptions}
                          selectedOption={selectedOption}
                          setSelectedOption={handleSetSelectedOption(idx)}
                          classname={`gap-2 px-3 py-2 rounded-full! text-[14px] font-semibold transition-colors ${
                            isDark
                              ? "bg-[#2A2A2A] hover:bg-[#333333] text-white"
                              : "bg-[#EEEEEE] hover:bg-[#E2E2E2] text-[#111111]"
                          }`}
                          arrowClassname="size-3"
                        />
                      </div>
                      <label htmlFor={`borrow-input-${idx}`} className="sr-only">
                        Borrow amount for {selectedOption}
                      </label>
                      <input
                        id={`borrow-input-${idx}`}
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={inputValues[idx] !== undefined ? inputValues[idx].toString() : ""}
                        onChange={handleInputChange(idx)}
                        className={`flex-1 min-w-0 text-[22px] sm:text-[28px] font-semibold bg-transparent text-right outline-none placeholder:opacity-20 ${
                          isDark
                            ? "text-white placeholder:text-white"
                            : "text-[#111111] placeholder:text-[#111111]"
                        }`}
                      />
                    </div>

                    {/* Row 3: rate info + ≈ USD */}
                    <div
                      className={`flex items-center justify-between text-sm font-medium ${
                        isDark ? "text-[#A7A7A7]" : "text-[#888888]"
                      }`}
                    >
                      <span>
                        {selectedAmountType === "Amount in %"
                          ? `% of ${totalDeposit > 0 ? `$${totalDeposit.toFixed(2)}` : "$0.00"}`
                          : `1 ${selectedOption} = $1.00`}
                      </span>
                      <span>≈ {inputValue > 0 ? inputValue.toFixed(2) : "0.00"} USD</span>
                    </div>
                  </article>

                </motion.div>
              );
            })}
          </div>

          {/* Total row */}
          {showTotal && (
            <div
              className={`flex items-center justify-between text-sm font-medium ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
            >
              <span>
                Total: $
                {totalBorrowedValue.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          )}
        </motion.div>
      )}

      {/* ── Leverage slider ───────────────────────────────────────────────── */}
      <motion.section
        className="relative z-0 flex items-start justify-between"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.2 }}
      >
        <div
          className={`flex gap-0.5 items-center rounded-lg border p-0.5 shrink-0 ${
            isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"
          }`}
        >
          <motion.button
            type="button"
            onClick={() => leverage > 1 && setLeverage(leverage - 1)}
            disabled={leverage <= 1}
            className={`w-4 h-8 flex items-center justify-center rounded-md text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              isDark ? "text-white hover:bg-[#222222]" : "hover:bg-[#F7F7F7]"
            }`}
            whileHover={{ scale: leverage > 1 ? 1.05 : 1 }}
            whileTap={{ scale: leverage > 1 ? 0.95 : 1 }}
            aria-label="Decrease leverage"
          >
            −
          </motion.button>

          <input
            value={leverage}
            type="number"
            min={1}
            max={MAX_LEVERAGE}
            onChange={handleLeverageChange}
            className={`w-8 h-8 focus:outline-none bg-transparent px-1 text-[14px] font-medium text-center border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
              isDark ? "text-white" : ""
            }`}
          />

          <motion.button
            type="button"
            onClick={() => leverage < MAX_LEVERAGE && setLeverage(leverage + 1)}
            disabled={leverage >= MAX_LEVERAGE}
            className={`w-4 h-8 flex items-center justify-center rounded-md text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              isDark ? "text-white hover:bg-[#222222]" : "hover:bg-[#F7F7F7]"
            }`}
            whileHover={{ scale: leverage < MAX_LEVERAGE ? 1.05 : 1 }}
            whileTap={{ scale: leverage < MAX_LEVERAGE ? 0.95 : 1 }}
            aria-label="Increase leverage"
          >
            +
          </motion.button>
        </div>

        <div className="flex-1 min-w-0 pl-4 pr-0 mt-1.5">
          <LeverageSlider
            value={leverage}
            onChange={setLeverage}
            max={MAX_LEVERAGE}
            min={1}
            step={1}
            markers={[1, 3, 5, 7, 10]}
          />
        </div>
      </motion.section>
    </motion.section>
  );
};
