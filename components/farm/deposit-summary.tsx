"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";
import { iconPaths } from "@/lib/constants";

interface DepositSummaryProps {
  /** Token symbol being deposited (e.g. "XLM", "USDC"). */
  tokenSymbol: string;
  /** Amount the user is about to deposit, in token units. */
  depositAmount: number;
  /** Live USD price of the token from the on-chain oracle. */
  tokenPriceUsd: number;
  /** Pool's supply APY, as a percentage (e.g. 4.09 for 4.09%). */
  supplyApyPct: number | null;
  /** Margin: XLM taken from borrow proceeds (deployed before own collateral). */
  fromBorrowAmount?: number;
  /** Margin: XLM taken from own deposit collateral. */
  fromOwnCollateralAmount?: number;
  /** Network label shown on the first row (defaults to "Stellar Testnet"). */
  networkLabel?: string;
  /** Network swatch colour for the small dot left of the label. */
  networkAccent?: string;
}

/**
 * Morpho-style deposit confirmation panel: shows the network, the deposit
 * delta (current → projected), and the projected monthly/yearly earnings
 * derived from the pool's supply APY × the deposit's USD value.
 *
 * All numbers are derived from props — caller is responsible for plumbing
 * live oracle prices and on-chain APY in.
 */
export const DepositSummary = ({
  tokenSymbol,
  depositAmount,
  tokenPriceUsd,
  supplyApyPct,
  fromBorrowAmount = 0,
  fromOwnCollateralAmount = 0,
  networkLabel = "Stellar Testnet",
  networkAccent = "#703AE6",
}: DepositSummaryProps) => {
  const { isDark } = useTheme();

  const depositUsd = depositAmount * tokenPriceUsd;
  const apy = supplyApyPct ?? 0;
  const yearlyEarnings = depositUsd * (apy / 100);
  const monthlyEarnings = yearlyEarnings / 12;

  const fmtUsd = (n: number): string =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtToken = (n: number): string =>
    n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

  const cardClass = isDark
    ? "bg-[#1A1A1A] border-[#2A2A2A]"
    : "bg-white border-[#E8E8E8]";
  const labelClass = isDark ? "text-[#919191]" : "text-[#76737B]";
  const valueClass = isDark ? "text-white" : "text-[#111111]";
  const arrowClass = isDark ? "text-[#666666]" : "text-[#999999]";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2 }}
      className={`w-full rounded-xl border p-4 flex flex-col gap-2.5 ${cardClass}`}
    >
      {/* Network */}
      <div className="flex items-center justify-between">
        <span className={`text-[12px] font-medium ${labelClass}`}>Network</span>
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-sm"
            style={{ backgroundColor: networkAccent }}
            aria-hidden="true"
          />
          <span className={`text-[12px] font-semibold ${valueClass}`}>
            {networkLabel}
          </span>
        </div>
      </div>

      {(fromBorrowAmount > 0 || fromOwnCollateralAmount > 0) && (
        <div className="flex items-center justify-between">
          <span className={`text-[12px] font-medium ${labelClass}`}>Source</span>
          <span className={`text-[12px] font-semibold text-right ${valueClass}`}>
            {fromBorrowAmount > 0
              ? `${fmtToken(fromBorrowAmount)} borrow`
              : ""}
            {fromBorrowAmount > 0 && fromOwnCollateralAmount > 0 ? " · " : ""}
            {fromOwnCollateralAmount > 0
              ? `${fmtToken(fromOwnCollateralAmount)} collateral`
              : ""}
          </span>
        </div>
      )}

      {/* Deposit row: 0.00 → amount */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {iconPaths[tokenSymbol] && (
            <Image
              src={iconPaths[tokenSymbol]}
              alt={tokenSymbol}
              width={14}
              height={14}
              className="rounded-full"
              aria-hidden="true"
            />
          )}
          <span className={`text-[12px] font-medium ${labelClass}`}>
            Deposit ({tokenSymbol})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[12px] font-medium ${labelClass}`}>0.00</span>
          <span className={arrowClass}>→</span>
          <span className={`text-[12px] font-semibold ${valueClass}`}>
            {fmtToken(depositAmount)}
          </span>
        </div>
      </div>

      {/* APY */}
      <div className="flex items-center justify-between">
        <span className={`text-[12px] font-medium ${labelClass}`}>APY</span>
        <span className={`text-[12px] font-semibold ${valueClass}`}>
          {supplyApyPct === null ? "—" : `${apy.toFixed(2)}%`}
        </span>
      </div>

      {/* Projected monthly */}
      <div className="flex items-center justify-between">
        <span className={`text-[12px] font-medium ${labelClass}`}>
          Projected monthly earnings
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`text-[12px] font-medium ${labelClass}`}>$0.00</span>
          <span className={arrowClass}>→</span>
          <span className={`text-[12px] font-semibold ${valueClass}`}>
            {fmtUsd(monthlyEarnings)}
          </span>
        </div>
      </div>

      {/* Projected yearly */}
      <div className="flex items-center justify-between">
        <span className={`text-[12px] font-medium ${labelClass}`}>
          Projected yearly earnings
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`text-[12px] font-medium ${labelClass}`}>$0.00</span>
          <span className={arrowClass}>→</span>
          <span className={`text-[12px] font-semibold ${valueClass}`}>
            {fmtUsd(yearlyEarnings)}
          </span>
        </div>
      </div>
    </motion.div>
  );
};
