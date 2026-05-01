import { Collaterals } from "@/lib/types";
import { useState, useEffect, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Dropdown } from "../ui/dropdown";
import {
  DropdownOptions,
  iconPaths,
} from "@/lib/constants";
import Image from "next/image";
import {
  DEPOSIT_PERCENTAGES,
  PERCENTAGE_COLORS,
  BALANCE_TYPE_OPTIONS,
} from "@/lib/constants/margin";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { useUserStore } from "@/store/user";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

interface Collateral {
  id?: string;
  collaterals: Collaterals | null;
  isEditing?: boolean;
  isAnyOtherEditing?: boolean;
  onEdit?: (id: string) => void;
  onSave?: (id: string, collateral: Collaterals) => void;
  onCancel?: () => void;
  onDelete?: (id: string) => void;
  onBalanceTypeChange?: (id: string, balanceType: string) => void;
  index?: number;
}

const CollateralComponent = (props: Collateral) => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const getTokenBalanceKey = (symbol: string) => {
    if (symbol === "BLUSDC" || symbol === "BLEND_USDC") return "BLEND_USDC";
    if (symbol === "AqUSDC" || symbol === "AquiresUSDC") return "AQUARIUS_USDC";
    if (symbol === "SoUSDC" || symbol === "SoroswapUSDC") return "SOROSWAP_USDC";
    return symbol;
  };

  // Get wallet balances from user store
  const tokenBalances = useUserStore((state) => state.tokenBalances);

  // Determine editing mode
  const isEditing = props.isEditing ?? props.collaterals === null;
  const isStandard = !isEditing;

  // Form state - initialize from props
  const [selectedCurrency, setSelectedCurrency] = useState<string>(
    props.collaterals?.asset || DropdownOptions[0]
  );
  const [valueInput, setValueInput] = useState<string>(() => {
    const amount = props.collaterals?.amount;
    return amount && amount > 0 ? amount.toString() : "";
  });
  const [valueInUsd, setValueInUsd] = useState<string>(() => {
    const amountInUsd = props.collaterals?.amountInUsd;
    return amountInUsd && amountInUsd > 0 ? amountInUsd.toString() : "0.0000";
  });
  const [percentage, setPercentage] = useState(0);
  const [selectedBalanceType, setSelectedBalanceType] = useState<string>(
    props.collaterals?.balanceType.toUpperCase() || BALANCE_TYPE_OPTIONS[0]
  );

  // Extract collateral data for conditional rendering
  const collateral = props.collaterals;
  const hasCollateral = collateral !== null;
  const showDeleteButton = isStandard && hasCollateral && props.index !== 0;

  // Only sync when switching between edit/view modes or when collateral changes
  useEffect(() => {
    if (isEditing && props.collaterals) {
      const newAmount = props.collaterals.amount > 0 ? props.collaterals.amount.toString() : "";
      const newAmountInUsd = props.collaterals.amountInUsd > 0 ? props.collaterals.amountInUsd.toString() : "0.0000";
      const newCurrency = props.collaterals.asset;
      const newBalanceType = props.collaterals.balanceType.toUpperCase();

      if (valueInput !== newAmount) {
        setValueInput(newAmount);
        setValueInUsd(newAmountInUsd);
      }
      if (selectedCurrency !== newCurrency) {
        setSelectedCurrency(newCurrency);
      }
      if (selectedBalanceType !== newBalanceType) {
        setSelectedBalanceType(newBalanceType);
      }
    }
  }, [isEditing, props.collaterals?.amount, props.collaterals?.amountInUsd, props.collaterals?.asset, props.collaterals?.balanceType]);

  // Calculate USD value from input using live token price
  useEffect(() => {
    if (isEditing && valueInput) {
      const amount = parseFloat(valueInput) || 0;
      const price = getPrice(selectedCurrency);
      setValueInUsd((amount * price).toFixed(2));
    }
  }, [valueInput, isEditing, selectedCurrency, getPrice]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return;
    setValueInput(sanitized);
  };

  const handlePercentageClick = (item: number) => {
    setPercentage(item);
    const balance = hasCollateral && collateral
      ? parseFloat(String(
          selectedBalanceType === "WB"
            ? tokenBalances[getTokenBalanceKey(selectedCurrency) as keyof typeof tokenBalances] || "0"
            : collateral.unifiedBalance
        )) || 0
      : 0;
    const calculatedAmount = (balance * item) / 100;
    setValueInput(calculatedAmount.toFixed(2));
  };

  const handleSave = () => {
    if (!props.onSave || !props.id) return;

    const updatedCollateral: Collaterals = {
      asset: selectedCurrency,
      amount: parseFloat(valueInput) || 0,
      amountInUsd: parseFloat(valueInUsd) || 0,
      balanceType: selectedBalanceType.toLowerCase(),
      unifiedBalance: props.collaterals?.unifiedBalance || 0,
    };
    props.onSave(props.id, updatedCollateral);
  };

  const handleCancel = () => {
    if (props.onCancel) {
      props.onCancel();
    }
  };

  // Compute live balance for display
  const liveBalance = hasCollateral && collateral
    ? (selectedBalanceType === "WB"
        ? tokenBalances[getTokenBalanceKey(selectedCurrency) as keyof typeof tokenBalances] || "0"
        : collateral.unifiedBalance)
    : "0";

  return (
    <motion.article
      className={`relative w-full rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 transition-colors border ${
        isDark
          ? "bg-[#1A1A1A] border-[#2A2A2A]"
          : "bg-white border-[#EEEEEE]"
      }`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
      layout
    >
      <AnimatePresence mode="wait">
        {isEditing ? (
          <motion.section
            key="editing"
            className="flex flex-col gap-1.5 sm:gap-2"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Row 1: "Deposit" label + % chips */}
            <div className="flex items-center justify-between">
              <span
                className={`text-sm font-medium ${
                  isDark ? "text-[#A7A7A7]" : "text-[#777777]"
                }`}
              >
                Deposit
              </span>
              <div
                className="flex items-center gap-1 sm:gap-1.5"
                role="group"
                aria-label="Deposit percentage"
              >
                {DEPOSIT_PERCENTAGES.map((item) => (
                  <motion.button
                    type="button"
                    key={item}
                    onClick={() => handlePercentageClick(item)}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.93 }}
                    transition={{ duration: 0.1 }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border transition-all ${
                      percentage === item
                        ? `${PERCENTAGE_COLORS[item]} text-white border-transparent`
                        : isDark
                          ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                          : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                    }`}
                    aria-label={`Select ${item} percent`}
                    aria-pressed={percentage === item}
                  >
                    {item}%
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Row 2: token dropdown pill + amount input */}
            <div className="flex items-center justify-between gap-3">
              <div className="shrink-0">
                <Dropdown
                  dropdownClassname="text-[13px] gap-2"
                  classname={`gap-2 px-3 py-2 rounded-full text-[14px] font-semibold transition-colors ${
                    isDark
                      ? "bg-[#333333] hover:bg-[#3D3D3D] text-white"
                      : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
                  }`}
                  selectedOption={selectedCurrency}
                  setSelectedOption={setSelectedCurrency}
                  items={DropdownOptions}
                />
              </div>
              <div className="flex-1 min-w-0">
                <label
                  htmlFor={`collateral-amount-input-${props.index}`}
                  className="sr-only"
                >
                  Collateral amount
                </label>
                <input
                  id={`collateral-amount-input-${props.index}`}
                  onChange={handleInputChange}
                  className={`w-full text-right text-[22px] sm:text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-20 ${
                    isDark
                      ? "text-white placeholder:text-white"
                      : "text-[#111111] placeholder:text-[#111111]"
                  }`}
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={valueInput}
                />
              </div>
            </div>

            {/* Row 3: WB/MB tabs only */}
            <div className="flex items-center">
              <div
                className={`flex items-center rounded-lg p-0.5 shrink-0 ${
                  isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"
                }`}
              >
                {BALANCE_TYPE_OPTIONS.map((option) => (
                  <motion.button
                    key={option}
                    type="button"
                    onClick={() => {
                      setSelectedBalanceType(option);
                      if (props.onBalanceTypeChange && props.id) {
                        props.onBalanceTypeChange(props.id, option);
                      }
                    }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ duration: 0.1 }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-all ${
                      selectedBalanceType === option
                        ? "bg-[#703AE6] text-white shadow-sm"
                        : isDark
                        ? "text-[#777777] hover:text-[#AAAAAA]"
                        : "text-[#888888] hover:text-[#555555]"
                    }`}
                    aria-pressed={selectedBalanceType === option}
                  >
                    {option}
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Row 4: balance info | Cancel | Add */}
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[12px] font-medium truncate min-w-0 ${
                  isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                }`}
              >
                Balance: {(parseFloat(String(liveBalance)) || 0).toFixed(2)} {selectedCurrency}
              </span>

              <div className="flex items-center gap-3 shrink-0">
                <motion.button
                  type="button"
                  onClick={handleCancel}
                  className={`text-[13px] font-medium cursor-pointer ${
                    isDark
                      ? "text-[#777777] hover:text-[#AAAAAA]"
                      : "text-[#A7A7A7] hover:text-[#777777]"
                  }`}
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.1 }}
                  aria-label="Cancel editing"
                >
                  Cancel
                </motion.button>
                <motion.button
                  type="button"
                  onClick={handleSave}
                  className="text-[13px] font-medium cursor-pointer text-[#703AE6] hover:text-[#5C30C0]"
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.1 }}
                  aria-label="Save collateral"
                >
                  Add
                </motion.button>
              </div>
            </div>
          </motion.section>
        ) : (
          <motion.section
            key="standard"
            className="flex flex-col gap-1.5 sm:gap-2"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Row 1: "Deposit" label + edit + delete buttons */}
            <div className="flex items-center justify-between">
              <span
                className={`text-sm font-medium ${
                  isDark ? "text-[#A7A7A7]" : "text-[#777777]"
                }`}
              >
                Deposit
              </span>
              <div className="flex items-center gap-1.5">
                <motion.button
                  type="button"
                  onClick={() => props.onEdit?.(props.id!)}
                  disabled={props.isAnyOtherEditing}
                  className={`flex items-center justify-center w-6 h-6 rounded-full transition-colors ${
                    isDark
                      ? "bg-[#2A2A2A] hover:bg-[#333333]"
                      : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
                  } ${
                    props.isAnyOtherEditing
                      ? "opacity-50 cursor-not-allowed"
                      : "cursor-pointer"
                  }`}
                  whileHover={props.isAnyOtherEditing ? {} : { scale: 1.1 }}
                  whileTap={props.isAnyOtherEditing ? {} : { scale: 0.9 }}
                  transition={{ duration: 0.1 }}
                  aria-label="Edit collateral"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 13 14"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M0 13.3333V10.9091H12.1212V13.3333H0ZM1.21212 9.69697V7.12121L8 0.348485C8.11111 0.237374 8.2399 0.151515 8.38636 0.0909091C8.53283 0.030303 8.68687 0 8.84848 0C9.0101 0 9.16667 0.030303 9.31818 0.0909091C9.4697 0.151515 9.60606 0.242424 9.72727 0.363636L10.5606 1.21212C10.6818 1.32323 10.7702 1.45455 10.8258 1.60606C10.8813 1.75758 10.9091 1.91414 10.9091 2.07576C10.9091 2.22727 10.8813 2.37626 10.8258 2.52273C10.7702 2.66919 10.6818 2.80303 10.5606 2.92424L3.78788 9.69697H1.21212ZM8.84848 2.90909L9.69697 2.06061L8.84848 1.21212L8 2.06061L8.84848 2.90909Z"
                      fill={isDark ? "#FFFFFF" : "#111111"}
                    />
                  </svg>
                </motion.button>

                {showDeleteButton && (
                  <motion.button
                    type="button"
                    onClick={() => props.onDelete?.(props.id!)}
                    className={`cursor-pointer flex items-center justify-center w-6 h-6 rounded-full transition-colors ${
                      isDark
                        ? "bg-[#2A2A2A] hover:bg-[#3A3A3A]"
                        : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
                    }`}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{ duration: 0.2 }}
                    aria-label="Delete collateral"
                  >
                    <svg
                      width="10"
                      height="3"
                      viewBox="0 0 14 3"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M13.3785 2.17793L7.77825 2.17793L5.60036 2.17793L7.72942e-05 2.17793L7.67884e-05 4.52819e-05L5.60036 4.5029e-05L7.77825 4.51976e-05L13.3785 4.55347e-05V2.17793Z"
                        fill={isDark ? "#FFFFFF" : "#111111"}
                      />
                    </svg>
                  </motion.button>
                )}
              </div>
            </div>

            {/* Row 2: token pill (with balance type badge) + amount */}
            {hasCollateral && collateral && (
              <div className="flex items-center justify-between gap-3">
                <div
                  className={`flex items-center gap-2 px-3 py-2 rounded-full shrink-0 ${
                    isDark ? "bg-[#333333]" : "bg-[#EEEEEE]"
                  }`}
                >
                  {iconPaths[collateral.asset] && (
                    <Image
                      src={iconPaths[collateral.asset]}
                      alt={collateral.asset}
                      width={20}
                      height={20}
                      className="rounded-full"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={`text-[14px] font-semibold ${
                      isDark ? "text-white" : "text-[#111111]"
                    }`}
                  >
                    {collateral.asset}
                  </span>
                  {/* Balance type badge inside pill */}
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#703AE6] text-white">
                    {collateral.balanceType.toUpperCase()}
                  </span>
                </div>

                <div
                  className={`flex-1 text-right text-[22px] sm:text-[28px] font-semibold ${
                    isDark ? "text-white" : "text-[#111111]"
                  }`}
                >
                  {Number(collateral.amount).toFixed(2)}
                </div>
              </div>
            )}

            {/* Row 3: balance label */}
            {hasCollateral && collateral && (
              <div className="flex items-center justify-between">
                <span
                  className={`text-[12px] font-medium ${
                    isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                  }`}
                >
                  Balance:{" "}
                  {(parseFloat(String(
                    collateral.balanceType.toLowerCase() === "wb"
                      ? tokenBalances[getTokenBalanceKey(collateral.asset) as keyof typeof tokenBalances] || "0"
                      : collateral.unifiedBalance
                  )) || 0).toFixed(2)}{" "}
                  {collateral.asset}
                </span>
                <span
                  className={`text-[12px] font-medium ${
                    isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                  }`}
                >
                  Balance:{" "}
                  {(parseFloat(String(
                    collateral.balanceType.toLowerCase() === "wb"
                      ? tokenBalances[getTokenBalanceKey(collateral.asset) as keyof typeof tokenBalances] || "0"
                      : collateral.unifiedBalance
                  )) || 0).toFixed(2)}{" "}
                  {collateral.asset}
                </span>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </motion.article>
  );
};

// Memoized component with custom comparison
export const Collateral = memo(CollateralComponent, (prevProps, nextProps) => {
  const prevCollateral = prevProps.collaterals;
  const nextCollateral = nextProps.collaterals;

  if (prevCollateral === nextCollateral) {
    return (
      prevProps.isEditing === nextProps.isEditing &&
      prevProps.isAnyOtherEditing === nextProps.isAnyOtherEditing &&
      prevProps.index === nextProps.index
    );
  }

  if (!prevCollateral || !nextCollateral) {
    return false;
  }

  return (
    prevProps.id === nextProps.id &&
    prevCollateral.asset === nextCollateral.asset &&
    prevCollateral.amount === nextCollateral.amount &&
    prevCollateral.amountInUsd === nextCollateral.amountInUsd &&
    prevCollateral.balanceType === nextCollateral.balanceType &&
    prevCollateral.unifiedBalance === nextCollateral.unifiedBalance &&
    prevProps.isEditing === nextProps.isEditing &&
    prevProps.isAnyOtherEditing === nextProps.isAnyOtherEditing &&
    prevProps.index === nextProps.index
  );
});
