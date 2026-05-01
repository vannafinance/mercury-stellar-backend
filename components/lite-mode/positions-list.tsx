"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { iconPaths } from "@/lib/constants";
import type { LitePosition } from "./lite-position-types";

interface PositionsListProps {
  positions: LitePosition[];
  onSelect: (id: string) => void;
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

const statusLabel = (s: LitePosition["status"]) =>
  s === "active" ? "Safe" : s === "risky" ? "At Risk" : "Liquidation";

const statusColor = (s: LitePosition["status"]) =>
  s === "active" ? "#10B981" : s === "risky" ? "#F59E0B" : "#FC5457";

export const PositionsList = ({ positions, onSelect }: PositionsListProps) => {
  const { isDark } = useTheme();

  const cardBg = isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]";
  const headingText = isDark ? "text-white" : "text-[#111111]";
  const mutedText = isDark ? "text-[#919191]" : "text-[#6B7280]";
  const subMuted = isDark ? "text-[#595959]" : "text-[#A9A9A9]";
  const rowHover = isDark ? "hover:bg-[#222222]" : "hover:bg-[#FAFAFA]";
  const divider = isDark ? "border-[#2C2C2C]" : "border-[#F0F0F0]";

  if (positions.length === 0) {
    return (
      <div
        className={`w-full rounded-xl border flex flex-col items-center justify-center py-16 px-6 ${cardBg}`}
      >
        <div
          className={`w-12 h-12 rounded-full mb-4 flex items-center justify-center ${
            isDark ? "bg-[#222222]" : "bg-[#F4F4F4]"
          }`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 12h4l3-9 4 18 3-9h4"
              stroke={isDark ? "#595959" : "#A9A9A9"}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <p className={`text-[14px] font-semibold mb-1 ${headingText}`}>No open positions</p>
        <p className={`text-[12px] text-center max-w-[260px] ${mutedText}`}>
          Head to Deposit &amp; Deploy to open your first leveraged yield position.
        </p>
      </div>
    );
  }

  return (
    <div className={`w-full rounded-xl border overflow-hidden ${cardBg}`}>
      {/* Header row — desktop only */}
      <div
        className={`hidden md:grid grid-cols-[1.4fr_1fr_1fr_1fr_0.9fr_0.9fr_auto] items-center gap-4 px-5 py-3 border-b ${divider}`}
      >
        {["Pool", "Collateral", "Borrowed", "Net APR", "Earnings", "Health", ""].map((h, i) => (
          <span
            key={i}
            className={`text-[10px] font-semibold uppercase tracking-[0.6px] ${subMuted}`}
          >
            {h}
          </span>
        ))}
      </div>

      {/* Rows */}
      <div>
        {positions.map((p, idx) => (
          <motion.button
            key={p.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: idx * 0.04, ease: "easeOut" }}
            onClick={() => onSelect(p.id)}
            className={`w-full text-left transition-colors cursor-pointer ${rowHover} ${
              idx !== positions.length - 1 ? `border-b ${divider}` : ""
            }`}
          >
            {/* Desktop row */}
            <div className="hidden md:grid grid-cols-[1.4fr_1fr_1fr_1fr_0.9fr_0.9fr_auto] items-center gap-4 px-5 py-4">
              {/* Pool */}
              <div className="flex items-center gap-3 min-w-0">
                <TokenIcon symbol={p.collateralAsset} size={28} />
                <div className="flex flex-col min-w-0">
                  <span className={`text-[13px] font-semibold leading-5 truncate ${headingText}`}>
                    {p.poolLabel}
                  </span>
                  <span className={`text-[11px] leading-4 ${subMuted}`}>
                    {p.protocol} {p.poolVersion} · {p.openedAt}
                  </span>
                </div>
              </div>

              {/* Collateral */}
              <div className="flex flex-col">
                <span className={`text-[13px] font-semibold ${headingText}`}>
                  ${p.collateralUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <span className={`text-[11px] ${subMuted}`}>
                  {p.collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {p.collateralAsset}
                </span>
              </div>

              {/* Borrowed */}
              <div className="flex flex-col">
                <span className={`text-[13px] font-semibold ${headingText}`}>
                  ${p.borrowUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <span className={`text-[11px] ${subMuted}`}>
                  {p.leverage.toFixed(1)}× leverage
                </span>
              </div>

              {/* Net APR */}
              <div className="flex flex-col">
                <span
                  className="text-[13px] font-semibold"
                  style={{ color: p.netApr >= 0 ? "#10B981" : "#FC5457" }}
                >
                  {p.netApr >= 0 ? "+" : ""}
                  {p.netApr.toFixed(2)}%
                </span>
                <span className={`text-[11px] ${subMuted}`}>annualized</span>
              </div>

              {/* Earnings */}
              <div className="flex flex-col">
                <span
                  className={`text-[13px] font-semibold ${
                    p.earningsUsd >= 0 ? headingText : "text-[#FC5457]"
                  }`}
                >
                  {p.earningsUsd >= 0 ? "+" : ""}${p.earningsUsd.toFixed(2)}
                </span>
                <span className={`text-[11px] ${subMuted}`}>to date</span>
              </div>

              {/* Health */}
              <div className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: statusColor(p.status) }}
                />
                <div className="flex flex-col">
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: statusColor(p.status) }}
                  >
                    {statusLabel(p.status)}
                  </span>
                  <span className={`text-[11px] ${subMuted}`}>HF {p.healthFactor.toFixed(2)}</span>
                </div>
              </div>

              {/* Chevron */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke={isDark ? "#595959" : "#A9A9A9"}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>

            {/* Mobile row */}
            <div className="md:hidden flex flex-col gap-3 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <TokenIcon symbol={p.collateralAsset} size={28} />
                  <div className="flex flex-col min-w-0">
                    <span className={`text-[13px] font-semibold truncate ${headingText}`}>
                      {p.poolLabel}
                    </span>
                    <span className={`text-[11px] ${subMuted}`}>
                      {p.protocol} {p.poolVersion} · {p.leverage.toFixed(1)}×
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end shrink-0">
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: p.netApr >= 0 ? "#10B981" : "#FC5457" }}
                  >
                    {p.netApr >= 0 ? "+" : ""}
                    {p.netApr.toFixed(2)}%
                  </span>
                  <span className={`text-[11px] ${subMuted}`}>net APR</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col">
                  <span className={`text-[10px] uppercase tracking-[0.5px] ${subMuted}`}>
                    Collateral
                  </span>
                  <span className={`text-[12px] font-semibold ${headingText}`}>
                    ${p.collateralUsd.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className={`text-[10px] uppercase tracking-[0.5px] ${subMuted}`}>
                    Earnings
                  </span>
                  <span
                    className={`text-[12px] font-semibold ${
                      p.earningsUsd >= 0 ? headingText : "text-[#FC5457]"
                    }`}
                  >
                    {p.earningsUsd >= 0 ? "+" : ""}${p.earningsUsd.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className={`text-[10px] uppercase tracking-[0.5px] ${subMuted}`}>
                    Health
                  </span>
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: statusColor(p.status) }}
                  >
                    HF {p.healthFactor.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
};
