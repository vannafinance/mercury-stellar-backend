"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { iconPaths } from "@/lib/constants";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import type { LitePosition } from "./lite-position-types";
import { calcExitPreview } from "./lite-position-math";
import { closePosition } from "@/lib/one-click-strategy";

function parseContractError(msg: string): string {
  if (!msg) return "Transaction failed. Please try again.";
  if (msg.includes("cancelled") || msg.includes("rejected")) return "Transaction cancelled by user.";
  if (msg.includes("MissingValue") || msg.includes("map key not found"))
    return "Position not found on-chain. It may already be closed or the balance is insufficient.";
  if (msg.includes("InsufficientBalance") || msg.includes("insufficient"))
    return "Insufficient balance to close this position.";
  if (msg.includes("HostError") || msg.includes("Error("))
    return "Smart contract error: the transaction was rejected by the network. Please check your position and try again.";
  // Truncate any other long message
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}

interface PositionDetailProps {
  position: LitePosition;
  onBack: () => void;
  /** Called after a successful close so the parent can refresh the list. */
  onExitSuccess?: () => void;
}

const TokenIcon = ({ symbol, size = 20 }: { symbol: string; size?: number }) => {
  const icons: Record<string, string> = iconPaths;
  const src = icons[symbol];
  if (!src) {
    return (
      <div
        className="rounded-full bg-[#2C2C2C] flex items-center justify-center text-[9px] font-semibold text-white"
        style={{ width: size, height: size }}
      >
        {symbol.slice(0, 1)}
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt={symbol}
      width={size}
      height={size}
      className="rounded-full object-contain"
    />
  );
};

const statusMeta = (s: LitePosition["status"]) =>
  s === "active"
    ? { label: "Safe", color: "#10B981" }
    : s === "risky"
    ? { label: "At Risk", color: "#F59E0B" }
    : { label: "Liquidation", color: "#FC5457" };

/* APR can be negative (supplyApr × leverage < vannaFee × (leverage−1)). Render
   the sign explicitly, color green for profit / red for loss.                  */
const fmtApr = (apr: number) => `${apr >= 0 ? "+" : ""}${apr.toFixed(2)}%`;
const aprColor = (apr: number) => (apr >= 0 ? "#10B981" : "#FC5457");

const EXIT_PRESETS = [25, 50, 75, 100] as const;

export const PositionDetail = ({ position, onBack, onExitSuccess }: PositionDetailProps) => {
  const { isDark } = useTheme();
  const userAddress = useUserStore((s) => s.address);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const [exitPct, setExitPct] = useState<number>(100);
  const [loading, setLoading] = useState(false);
  const [txModal, setTxModal] = useState<{
    open: boolean;
    status: "pending" | "success" | "error";
    title: string;
    message: string;
    txHash?: string;
  }>({ open: false, status: "pending", title: "", message: "" });

  const cardBg = isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]";
  const headingText = isDark ? "text-white" : "text-[#111111]";
  const bodyText = isDark ? "text-[#919191]" : "text-[#6B7280]";
  const subMuted = isDark ? "text-[#595959]" : "text-[#A9A9A9]";
  const divider = isDark ? "border-[#2C2C2C]" : "border-[#F0F0F0]";
  const rowBg = isDark ? "bg-[#222222]" : "bg-[#F7F7F7]";

  const status = statusMeta(position.status);

  /* ── Current on-chain balances ──
     The FULL supplied balance in the pool is (collateral + borrow), both
     earning yield. The user's equity = supplied − debt = collateral + earnings.
     Exit withdraws from the TOTAL supplied, not just the user's equity:
        withdraw(pct) = (collateral + borrow + earnings) × pct   (what leaves pool)
        repay(pct)    = borrow × pct                             (debt paid off)
        user net(pct) = withdraw − repay = (collateral + earnings) × pct        */
  const currentSuppliedUsd = position.collateralUsd + position.borrowUsd + position.earningsUsd;
  const currentBorrowUsd = position.borrowUsd;

  const exit = useMemo(
    () => calcExitPreview(currentSuppliedUsd, currentBorrowUsd, position.healthFactor, exitPct),
    [currentSuppliedUsd, currentBorrowUsd, position.healthFactor, exitPct]
  );

  /* Per-asset breakdown for the Review step. When collateralAsset ==
     borrowAsset (common), we express gross-withdraw and repay in asset units
     so the user sees e.g. "Withdraw 1.02 ETH / Repay 0.85 ETH → receive 0.17 ETH". */
  const assetPrice = position.collateralUsd / position.collateralAmount;
  const grossWithdrawAmount = exit.withdrawUsd / assetPrice;
  const repayAmount = exit.repayUsd / assetPrice;
  const netReceivedAmount = grossWithdrawAmount - repayAmount;

  const repayUsd = exit.repayUsd;
  const withdrawUsd = exit.withdrawUsd;
  const withdrawAmount = grossWithdrawAmount;

  /* User equity on the position. The borrowed principal sits in the pool earning
     yield, so it is both an asset AND a liability on the user's balance sheet →
     it cancels out. Net Value = what user would walk away with if they exited now.
        totalSupplied = collateral + borrow
        debt          = borrow (principal + accrued borrow interest)
        equity        = totalSupplied − debt = collateral + earnings                */
  const netValueUsd = position.collateralUsd + position.earningsUsd;

  const projectedHf = exit.projectedHf;
  const projectedLiquidity = exit.remainingBorrowUsd;

  /* ── Close position handler ────────────────────────────────────────────── */
  const handleExit = async () => {
    if (!userAddress || !marginAccountAddress) return;
    setLoading(true);
    setTxModal({ open: true, status: "pending", title: "Closing Position", message: "Preparing transaction..." });
    try {
      const result = await closePosition({
        userAddress,
        marginAccountAddress,
        borrowAsset: position.borrowAsset as "XLM" | "USDC",
        borrowAmount: position.borrowAmount,
        collateralAsset: position.collateralAsset as "XLM" | "USDC",
        collateralAmount: position.collateralAmount,
        poolProtocol: position.protocol,
        poolType: position.poolType,
        poolTokens: position.poolTokens,
        isSameAsset: position.isSameAsset,
        exitPct,
        onStep: (msg) => setTxModal((p) => ({ ...p, message: msg })),
      });
      if (!result.success) throw new Error(parseContractError(result.error ?? ""));
      setTxModal({
        open: true, status: "success",
        title: exitPct === 100 ? "Position Closed" : `${exitPct}% Exit Complete`,
        message: `Successfully withdrew from ${position.protocol} and repaid Vanna loan. Your collateral is now freed.`,
        txHash: result.hash,
      });
      await refreshBorrowedBalances(marginAccountAddress);
      onExitSuccess?.();
    } catch (err: any) {
      const msg = err?.message || "Close position failed.";
      const cancelled = msg.includes("cancelled") || msg.includes("rejected");
      setTxModal({
        open: true, status: "error",
        title: cancelled ? "Cancelled" : "Transaction Failed",
        message: parseContractError(msg),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* ── Tx Modal ── */}
      <Modal open={txModal.open} onClose={() => !loading && setTxModal((p) => ({ ...p, open: false }))}>
        <div className={`w-[340px] sm:w-[400px] rounded-[20px] p-6 flex flex-col gap-5 ${isDark ? "bg-[#1A1A1A] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}>
          <div className="flex items-center justify-center pt-2">
            {txModal.status === "pending" && (
              <div className="w-14 h-14 rounded-full border-4 border-[#703AE6]/30 border-t-[#703AE6] animate-spin" />
            )}
            {txModal.status === "success" && (
              <div className="w-14 h-14 rounded-full bg-[#10B981]/15 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
            )}
            {txModal.status === "error" && (
              <div className="w-14 h-14 rounded-full bg-[#FC5457]/15 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FC5457" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </div>
            )}
          </div>
          <div className="text-center">
            <h3 className={`text-[16px] font-bold mb-1.5 ${isDark ? "text-white" : "text-[#111111]"}`}>{txModal.title}</h3>
            <p className={`text-[13px] leading-[20px] ${isDark ? "text-[#919191]" : "text-[#6B7280]"}`}>{txModal.message}</p>
            {txModal.txHash && (
              <p className={`text-[11px] mt-2 font-mono ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>
                {txModal.txHash.slice(0, 8)}...{txModal.txHash.slice(-8)}
              </p>
            )}
          </div>
          {txModal.status !== "pending" && (
            <button
              type="button"
              onClick={() => setTxModal((p) => ({ ...p, open: false }))}
              className="w-full text-white text-[14px] font-semibold py-3 rounded-[12px] hover:opacity-90 transition-opacity"
              style={{ background: "linear-gradient(135deg, #703AE6 0%, #FF007A 100%)" }}
            >
              {txModal.status === "success" ? "Done" : "Close"}
            </button>
          )}
        </div>
      </Modal>

    <div className="w-full flex flex-col lg:flex-row gap-5">
      {/* ═══════ LEFT: Position management ═══════ */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="w-full lg:flex-[1_1_0%] min-w-0 h-fit flex flex-col gap-4"
      >
        {/* Back + header */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
              isDark
                ? "text-[#919191] hover:text-white hover:bg-[#222222]"
                : "text-[#6B7280] hover:text-[#111111] hover:bg-[#F4F4F4]"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 18l-6-6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[12px] font-semibold">All positions</span>
          </button>

          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: status.color }}
            />
            <span className="text-[12px] font-semibold" style={{ color: status.color }}>
              {status.label}
            </span>
            <span className={`text-[12px] ${subMuted}`}>· HF {position.healthFactor.toFixed(2)}</span>
          </div>
        </div>

        {/* Position header card */}
        <div className={`w-full rounded-xl border p-5 ${cardBg}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <TokenIcon symbol={position.collateralAsset} size={36} />
              <div className="flex flex-col min-w-0">
                <h2 className={`text-[18px] font-bold leading-6 truncate ${headingText}`}>
                  {position.poolLabel}
                </h2>
                <span className={`text-[12px] ${bodyText}`}>
                  {position.protocol} {position.poolVersion} · opened {position.openedAt}
                </span>
              </div>
            </div>
            <span
              className={`text-[10px] font-bold uppercase tracking-[0.5px] px-2.5 py-1 rounded-full ${
                isDark ? "bg-[#222222] text-[#919191]" : "bg-[#F4F4F4] text-[#6B7280]"
              }`}
            >
              {position.leverage.toFixed(1)}× leverage
            </span>
          </div>

          {/* Morpho-style hero stats */}
          <div className={`grid grid-cols-2 sm:grid-cols-4 gap-0 mt-5 rounded-lg border ${divider}`}>
            {[
              {
                label: "Collateral",
                value: `$${position.collateralUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
                sub: `${position.collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${position.collateralAsset}`,
                color: headingText,
              },
              {
                label: "Borrowed",
                value: `$${position.borrowUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
                sub: `${position.borrowAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${position.borrowAsset}`,
                color: headingText,
              },
              {
                label: "Net Value",
                value: `$${netValueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
                sub: `${position.earningsUsd >= 0 ? "+" : ""}$${position.earningsUsd.toFixed(2)} earned`,
                color: position.earningsUsd >= 0 ? "text-[#10B981]" : "text-[#FC5457]",
              },
              {
                label: "Net APR",
                value: fmtApr(position.netApr),
                sub: "annualized",
                color: position.netApr >= 0 ? "text-[#10B981]" : "text-[#FC5457]",
              },
            ].map((kpi, i) => (
              <div
                key={i}
                className={`flex flex-col gap-1 px-4 py-3 ${
                  i > 0 ? (isDark ? "border-l border-[#2C2C2C]" : "border-l border-[#F0F0F0]") : ""
                } ${
                  i < 2 && "sm:border-b-0"
                } ${i === 0 || i === 1 ? "border-b sm:border-b-0 " + (isDark ? "border-[#2C2C2C]" : "border-[#F0F0F0]") : ""}`}
              >
                <span
                  className={`text-[10px] font-semibold uppercase tracking-[0.5px] ${subMuted}`}
                >
                  {kpi.label}
                </span>
                <span className={`text-[16px] font-bold leading-6 ${kpi.color}`}>
                  {kpi.value}
                </span>
                <span className={`text-[11px] ${subMuted}`}>{kpi.sub}</span>
              </div>
            ))}
          </div>

          {/* Deposited / Borrowed rows */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-3 ${rowBg}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={`text-[10px] font-semibold uppercase tracking-[0.5px] ${subMuted}`}>
                  Deposited
                </span>
                <TokenIcon symbol={position.collateralAsset} size={18} />
                <span className={`text-[13px] font-semibold truncate ${headingText}`}>
                  {position.collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {position.collateralAsset}
                </span>
              </div>
              <span className={`text-[12px] ${subMuted} shrink-0`}>
                ${position.collateralUsd.toFixed(2)}
              </span>
            </div>
            <div className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-3 ${rowBg}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={`text-[10px] font-semibold uppercase tracking-[0.5px] ${subMuted}`}>
                  Borrowed
                </span>
                <TokenIcon symbol={position.borrowAsset} size={18} />
                <span className={`text-[13px] font-semibold truncate ${headingText}`}>
                  {position.borrowAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {position.borrowAsset}
                </span>
              </div>
              <span className={`text-[12px] ${subMuted} shrink-0`}>
                ${position.borrowUsd.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* Step 1 — Choose exit amount */}
        <div className={`w-full rounded-xl border p-5 ${cardBg}`}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-full bg-gradient flex items-center justify-center text-white text-[12px] font-bold shrink-0">
              1
            </div>
            <div className="flex flex-col">
              <h3 className={`text-[14px] font-semibold leading-5 ${headingText}`}>
                Choose Exit Amount
              </h3>
              <span className={`text-[11px] leading-4 ${bodyText}`}>
                How much of your position to close
              </span>
            </div>
          </div>

          {/* Preset pills */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {EXIT_PRESETS.map((pct) => {
              const active = exitPct === pct;
              return (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setExitPct(pct)}
                  className={`py-2.5 rounded-lg text-[13px] font-semibold transition-all ${
                    active
                      ? "bg-gradient text-white shadow-[0_2px_8px_rgba(112,58,230,0.3)]"
                      : isDark
                      ? "bg-[#222222] text-[#919191] hover:bg-[#2C2C2C]"
                      : "bg-[#F4F4F4] text-[#6B7280] hover:bg-[#EDEDED]"
                  }`}
                >
                  {pct}%
                </button>
              );
            })}
          </div>

          {/* Slider */}
          <div className="relative">
            <input
              type="range"
              min={1}
              max={100}
              value={exitPct}
              onChange={(e) => setExitPct(Number(e.target.value))}
              className="w-full h-1 bg-transparent appearance-none cursor-pointer lite-exit-slider"
              style={{
                background: `linear-gradient(to right, #703AE6 0%, #FC5457 ${exitPct}%, ${
                  isDark ? "#2C2C2C" : "#E5E7EB"
                } ${exitPct}%, ${isDark ? "#2C2C2C" : "#E5E7EB"} 100%)`,
                borderRadius: 999,
              }}
            />
            <div className="flex justify-between mt-2">
              <span className={`text-[11px] ${subMuted}`}>1%</span>
              <span className={`text-[11px] font-semibold ${isDark ? "text-[#703AE6]" : "text-[#703AE6]"}`}>
                {exitPct}%
              </span>
              <span className={`text-[11px] ${subMuted}`}>100%</span>
            </div>
          </div>
          <style jsx>{`
            .lite-exit-slider::-webkit-slider-thumb {
              -webkit-appearance: none;
              appearance: none;
              width: 16px;
              height: 16px;
              border-radius: 50%;
              background: ${isDark ? "#1A1A1A" : "#FFFFFF"};
              border: 2px solid #703ae6;
              box-shadow: 0 2px 6px rgba(112, 58, 230, 0.35);
              cursor: pointer;
            }
            .lite-exit-slider::-moz-range-thumb {
              width: 16px;
              height: 16px;
              border-radius: 50%;
              background: ${isDark ? "#1A1A1A" : "#FFFFFF"};
              border: 2px solid #703ae6;
              cursor: pointer;
            }
          `}</style>
        </div>

        {/* Step 2 — Review */}
        <div className={`w-full rounded-xl border p-5 ${cardBg}`}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-full bg-gradient flex items-center justify-center text-white text-[12px] font-bold shrink-0">
              2
            </div>
            <div className="flex flex-col">
              <h3 className={`text-[14px] font-semibold leading-5 ${headingText}`}>
                Review
              </h3>
              <span className={`text-[11px] leading-4 ${bodyText}`}>
                What will happen when you confirm
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {/* Repay row */}
            <div className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-3 ${rowBg}`}>
              <div className="flex items-center gap-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#FC5457]" />
                <span className={`text-[10px] font-bold uppercase tracking-[0.5px] ${bodyText}`}>
                  Repay
                </span>
                <TokenIcon symbol={position.borrowAsset} size={16} />
                <span className={`text-[13px] font-semibold ${headingText}`}>
                  {repayAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {position.borrowAsset}
                </span>
              </div>
              <span className={`text-[12px] ${subMuted}`}>≈ ${repayUsd.toFixed(2)}</span>
            </div>

            {/* Withdraw row */}
            <div className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-3 ${rowBg}`}>
              <div className="flex items-center gap-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                <span className={`text-[10px] font-bold uppercase tracking-[0.5px] ${bodyText}`}>
                  Withdraw
                </span>
                <TokenIcon symbol={position.collateralAsset} size={16} />
                <span className={`text-[13px] font-semibold ${headingText}`}>
                  {withdrawAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {position.collateralAsset}
                </span>
              </div>
              <span className={`text-[12px] ${subMuted}`}>≈ ${withdrawUsd.toFixed(2)}</span>
            </div>

            {/* You Receive — gross withdraw minus repay, in asset units */}
            <div
              className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-3 ${
                isDark ? "bg-gradient-to-r from-[#703AE6]/10 to-[#FC5457]/10" : "bg-gradient-to-r from-[#F1EBFD] to-[#FEEEEE]"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 5v14M19 12l-7 7-7-7"
                    stroke="#703AE6"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className={`text-[10px] font-bold uppercase tracking-[0.5px] text-[#703AE6]`}>
                  You Receive
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className={`text-[14px] font-bold ${headingText}`}>
                  {netReceivedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {position.collateralAsset}
                </span>
                <span className={`text-[11px] ${subMuted}`}>
                  ≈ ${exit.userReceivesUsd.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Projected HF — directly addresses "does exit affect HF?" */}
            <div className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-3 ${rowBg}`}>
              <div className="flex items-center gap-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#703AE6]" />
                <span className={`text-[10px] font-bold uppercase tracking-[0.5px] ${bodyText}`}>
                  Projected HF
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[12px] ${subMuted}`}>{position.healthFactor.toFixed(2)}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke={isDark ? "#595959" : "#A9A9A9"}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span
                  className="text-[13px] font-bold"
                  style={{ color: projectedHf === null ? "#10B981" : status.color }}
                >
                  {projectedHf === null ? "Safe" : projectedHf.toFixed(2)}
                </span>
              </div>
            </div>

            {exitPct === 100 ? (
              <div
                className={`flex items-start gap-2 rounded-lg px-3.5 py-2.5 ${
                  isDark ? "bg-[#703AE6]/10" : "bg-[#F1EBFD]"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5">
                  <path
                    d="M12 16v-4M12 8h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z"
                    stroke="#703AE6"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[11px] font-medium text-[#703AE6] leading-4">
                  Full exit repays all debt and withdraws all collateral in a single transaction.
                </span>
              </div>
            ) : (
              <div
                className={`flex items-start gap-2 rounded-lg px-3.5 py-2.5 ${
                  isDark ? "bg-[#10B981]/10" : "bg-[#E8F8F1]"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5">
                  <path
                    d="M9 12l2 2 4-4M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z"
                    stroke="#10B981"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[11px] font-medium text-[#10B981] leading-4">
                  Partial exits repay and withdraw proportionally — Health Factor stays the same.
                  Remaining debt: ${projectedLiquidity.toFixed(2)}.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* CTA */}
        <div className={`w-full rounded-xl border p-5 ${cardBg}`}>
          <Button
            text={loading ? "Processing..." : exitPct === 100 ? "Close Position" : `Exit ${exitPct}% of Position`}
            size="large"
            type="gradient"
            disabled={loading || !userAddress || !marginAccountAddress}
            onClick={handleExit}
          />
          <p className={`text-[11px] text-center mt-2 ${subMuted}`}>
            Vanna handles the repay + withdraw in a single transaction.
          </p>
        </div>
      </motion.div>

      {/* ═══════ RIGHT: Morpho-style earnings breakdown ═══════ */}
      <motion.aside
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.35, delay: 0.1 }}
        className="w-full lg:w-[320px] h-fit shrink-0 flex flex-col gap-4"
      >
        {/* APR breakdown */}
        <div className={`w-full rounded-xl border overflow-hidden ${cardBg}`}>
          <div className="flex items-center gap-2 px-5 pt-5 pb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-gradient" />
            <h3 className={`text-[13px] font-semibold ${headingText}`}>
              APR Breakdown
            </h3>
          </div>

          <div className={`grid grid-cols-2 border-y ${divider}`}>
            <div className="flex flex-col gap-1 px-5 py-4">
              <span className={`text-[10px] font-semibold uppercase tracking-[0.5px] ${subMuted}`}>
                Supply APY
              </span>
              <span className={`text-[20px] font-bold leading-7 ${headingText}`}>
                {position.supplyApr.toFixed(2)}%
              </span>
              <span className={`text-[11px] ${subMuted}`}>Base pool yield</span>
            </div>
            <div
              className={`flex flex-col gap-1 px-5 py-4 border-l ${divider}`}
            >
              <span className={`text-[10px] font-semibold uppercase tracking-[0.5px] ${subMuted}`}>
                Vanna Fee
              </span>
              <span className={`text-[20px] font-bold leading-7 text-[#FC5457]`}>
                −{position.vannaFeeApr.toFixed(2)}%
              </span>
              <span className={`text-[11px] ${subMuted}`}>Borrow cost</span>
            </div>
          </div>

          {/* Net APR highlight */}
          <div
            className={`flex items-center justify-between gap-3 px-5 py-4 ${
              isDark ? "bg-[#222222]/60" : "bg-[#FAFAFA]"
            }`}
          >
            <span className={`text-[12px] font-semibold ${bodyText}`}>Net APR</span>
            <span className="text-[18px] font-bold" style={{ color: aprColor(position.netApr) }}>
              {fmtApr(position.netApr)}
            </span>
          </div>
        </div>

        {/* Detailed attributes — Morpho style */}
        <div className={`w-full rounded-xl border overflow-hidden ${cardBg}`}>
          <div className="flex items-center gap-2 px-5 pt-5 pb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-gradient" />
            <h3 className={`text-[13px] font-semibold ${headingText}`}>
              Position Details
            </h3>
          </div>

          <div className={`flex flex-col border-t ${divider}`}>
            {[
              {
                label: "Collateral",
                value: `${position.collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${position.collateralAsset}`,
                sub: `$${position.collateralUsd.toFixed(2)}`,
              },
              {
                label: `Loan (${position.borrowAsset})`,
                value: `${position.borrowAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${position.borrowAsset}`,
                sub: `$${position.borrowUsd.toFixed(2)}`,
              },
              {
                label: "Earnings",
                value: `${position.earningsUsd >= 0 ? "+" : ""}$${position.earningsUsd.toFixed(2)}`,
                sub: "since opening",
                valueColor: position.earningsUsd >= 0 ? "text-[#10B981]" : "text-[#FC5457]",
              },
              {
                label: "Leverage",
                value: `${position.leverage.toFixed(2)}×`,
              },
              {
                label: "Health Factor",
                value: position.healthFactor.toFixed(2),
                valueColor: status.color,
              },
              {
                label: "Liquidation LTV",
                value: `${position.liquidationLtv}%`,
              },
            ].map((row, i, arr) => (
              <div
                key={row.label}
                className={`flex items-center justify-between gap-3 px-5 py-3 ${
                  i < arr.length - 1 ? `border-b ${divider}` : ""
                }`}
              >
                <span className={`text-[12px] font-medium ${bodyText}`}>{row.label}</span>
                <div className="flex flex-col items-end">
                  <span
                    className={`text-[13px] font-semibold ${
                      typeof row.valueColor === "string" && row.valueColor.startsWith("text-")
                        ? row.valueColor
                        : headingText
                    }`}
                    style={
                      typeof row.valueColor === "string" && !row.valueColor.startsWith("text-")
                        ? { color: row.valueColor }
                        : undefined
                    }
                  >
                    {row.value}
                  </span>
                  {row.sub && <span className={`text-[11px] ${subMuted}`}>{row.sub}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.aside>
    </div>
    </>
  );
};
