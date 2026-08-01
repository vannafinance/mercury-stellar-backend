"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";

import { Dropdown } from "../ui/dropdown";
import { LeverageSlider } from "../ui/leverage-slider";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { DropdownOptions } from "@/lib/constants";
import { MAX_LEVERAGE } from "@/lib/constants/margin";
import type { BorrowInfo } from "@/lib/types";

const BRAND_RED = "#FC5457";
const GRADIENT = "linear-gradient(135deg, #FC5457 10%, #703AE6 80%)";

/** Canonicalise a UI token symbol to the key used by the price hook. */
const priceKey = (sym: string): string => {
  const s = sym.toUpperCase();
  if (
    s === "BLUSDC" || s === "BLEND_USDC" || s === "USDC" ||
    s === "AQUSDC" || s === "AQUARIUS_USDC" ||
    s === "SOUSDC" || s === "SOROSWAP_USDC" ||
    sym === "AqUSDC" || sym === "SoUSDC"
  ) return "USDC";
  return sym;
};

const fmtUsd = (n: number) =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Validated state emitted to the parent so it can gate the submit button. */
export interface DualBorrowState {
  items: BorrowInfo[];
  totalUsd: number;
  maxUsd: number;
  isValid: boolean;
  error: string | null;
}

interface DualBorrowProps {
  /** Collateral USD being deposited — drives the borrow ceiling. */
  depositUsd: number;
  leverage: number;
  setLeverage: (v: number) => void;
  /** Fires on every change with the assembled items + validity. */
  onChange?: (state: DualBorrowState) => void;
}

type BorrowMode = "single" | "dual";

/**
 * Dual-borrow surface: borrow one or two assets against deposited collateral.
 *
 * Manual amounts are primary — the user types how much of each asset to borrow.
 * The leverage slider sets the borrow ceiling (`Max = deposit × (leverage − 1)`);
 * exceeding it turns the affected card + the Total line red and reports an
 * invalid state to the parent (which disables submit). Responsive: the two
 * borrow cards stack on mobile and sit side-by-side from `lg` up. Borrow
 * execution is wired by the parent — this component owns input + validation only.
 */
export const DualBorrow = ({ depositUsd, leverage, setLeverage, onChange }: DualBorrowProps) => {
  const { isDark } = useTheme();
  const prices = useTokenPrices(["XLM", "USDC"]);
  const bgColor = isDark ? "#1A1A1A" : "#ffffff";

  const [mode, setMode] = useState<BorrowMode>("single");
  // Default to two distinct assets so dual mode is valid out of the box.
  const [tokens, setTokens] = useState<[string, string]>(["USDC", "XLM"]);
  const [amounts, setAmounts] = useState<[string, string]>(["", ""]);

  const slotCount = mode === "dual" ? 2 : 1;

  const priceOf = useCallback((sym: string) => prices[priceKey(sym)] ?? 0, [prices]);

  const maxUsd = useMemo(() => Math.max(0, depositUsd * (leverage - 1)), [depositUsd, leverage]);

  // Leverage-driven auto-calc. The borrow follows the deposit × (leverage − 1)
  // ceiling: single mode puts the whole amount on the one asset; dual mode
  // splits it 50/50. So saving the deposit (or moving the slider) fills the
  // borrow automatically — no Max Value click needed. The user can still type to
  // override a card; a manual edit pauses auto-fill (so a price tick doesn't
  // clobber it) until a driving input — deposit, leverage, mode, or asset —
  // changes, which returns control to auto-calc.
  const manualRef = useRef(false);
  const fmtAmt = (amt: number) => (amt > 0 ? amt.toFixed(7).replace(/\.?0+$/, "") : "");
  const fillFromLeverage = useCallback(() => {
    if (mode === "single") {
      const p0 = priceOf(tokens[0]);
      setAmounts([p0 > 0 ? fmtAmt(maxUsd / p0) : "", ""]);
    } else {
      const half = maxUsd / 2;
      const p0 = priceOf(tokens[0]);
      const p1 = priceOf(tokens[1]);
      setAmounts([p0 > 0 ? fmtAmt(half / p0) : "", p1 > 0 ? fmtAmt(half / p1) : ""]);
    }
  }, [mode, maxUsd, tokens, priceOf]);

  // Driving inputs (deposit/leverage via maxUsd, mode, asset) → reset to auto.
  useEffect(() => {
    manualRef.current = false;
    fillFromLeverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, maxUsd, tokens[0], tokens[1]]);

  // Price tick → keep the auto amounts in sync, but never clobber a manual edit.
  useEffect(() => {
    if (!manualRef.current) fillFromLeverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices]);

  const usds = useMemo(
    () => [0, 1].map((i) => (i < slotCount ? (parseFloat(amounts[i]) || 0) * priceOf(tokens[i]) : 0)),
    [amounts, tokens, slotCount, priceOf],
  );
  const totalUsd = usds[0] + usds[1];

  // ── Validation: every "more than borrowable" scenario the user can hit ──────
  const { error, exceeds, duplicate } = useMemo(() => {
    const duplicate = slotCount === 2 && tokens[0] === tokens[1];
    if (totalUsd > 0 && depositUsd <= 0) {
      return { error: "Add collateral before borrowing.", exceeds: false, duplicate };
    }
    if (duplicate) {
      return { error: "Pick two different assets to borrow.", exceeds: false, duplicate };
    }
    // 1-cent tolerance: the leverage auto-fill targets exactly maxUsd, and
    // amount→USD rounding can land a hair above it — don't flag that as an
    // over-borrow. Only a real manual overshoot trips the red text.
    if (totalUsd > maxUsd + 0.01) {
      return {
        error: `Total borrow ${fmtUsd(totalUsd)} exceeds your limit of ${fmtUsd(maxUsd)}. Lower an amount or raise leverage.`,
        exceeds: true,
        duplicate,
      };
    }
    return { error: null, exceeds: false, duplicate };
  }, [totalUsd, maxUsd, depositUsd, slotCount, tokens]);

  const isValid = totalUsd > 0 && error === null;

  // Emit assembled items + validity to the parent.
  useEffect(() => {
    const items: BorrowInfo[] = [];
    for (let i = 0; i < slotCount; i++) {
      const amount = parseFloat(amounts[i]) || 0;
      if (amount > 0) {
        items.push({
          assetData: { asset: tokens[i], amount: amounts[i] },
          percentage: depositUsd > 0 ? Number(((usds[i] / depositUsd) * 100).toFixed(2)) : 0,
          usdValue: usds[i],
        });
      }
    }
    onChange?.({ items, totalUsd, maxUsd, isValid, error });
    // onChange is treated as stable by callers (memoised); excluding it avoids
    // a feedback loop on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amounts, tokens, slotCount, totalUsd, maxUsd, isValid, error, depositUsd]);

  const setToken = (i: number) => (v: string | ((p: string) => string)) =>
    setTokens((prev) => {
      const next: [string, string] = [...prev];
      next[i] = typeof v === "function" ? v(prev[i]) : v;
      return next;
    });

  const setAmount = (i: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return; // numeric only
    manualRef.current = true; // user override → pause leverage auto-fill
    setAmounts((prev) => {
      const next: [string, string] = [...prev];
      next[i] = raw;
      return next;
    });
  };

  // "Max Value" (single mode): snap leverage to the max. The borrow is
  // leverage-driven, so this maxes the slider and the auto-fill then fills the
  // amount to deposit × (MAX_LEVERAGE − 1) — one click for the largest position.
  const handleMaxValue = () => setLeverage(MAX_LEVERAGE);

  const cardBase = isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]";
  const labelMuted = isDark ? "text-[#A7A7A7]" : "text-[#888888]";
  const subMuted = isDark ? "text-[#777777]" : "text-[#A7A7A7]";

  const renderCard = (i: number) => {
    const usd = usds[i];
    // A slot is in error when the total over-borrows (highlight all active slots)
    // or it's a duplicate-asset slot.
    const cardError = (exceeds && usd > 0) || (duplicate && i === 1);
    return (
      <motion.article
        key={i}
        className={`w-full min-w-0 rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 border transition-colors ${cardBase}`}
        style={cardError ? { borderColor: BRAND_RED } : undefined}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25, delay: i * 0.06 }}
      >
        <div className="flex items-center justify-between min-h-[26px]">
          <span className={`text-sm font-medium ${labelMuted}`}>Borrow</span>
          {/* Max Value only in single mode. In dual mode the amount is auto-split
              50/50 from leverage, so a per-card "max" would overfill one side
              and zero the other — it has no meaning here. */}
          {mode === "single" && (
            <motion.button
              type="button"
              onClick={handleMaxValue}
              className={`px-3 py-1 rounded-lg shrink-0 text-[11px] font-semibold whitespace-nowrap cursor-pointer ${
                isDark ? "text-white" : "text-[#111111]"
              }`}
              style={{
                background: `linear-gradient(${bgColor}, ${bgColor}) padding-box, ${GRADIENT} border-box`,
                border: "1.2px solid transparent",
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              aria-label="Borrow the maximum — set leverage to 10X"
            >
              Max Value
            </motion.button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="shrink-0">
            <Dropdown
              dropdownClassname="text-[13px] gap-2"
              items={DropdownOptions}
              selectedOption={tokens[i]}
              setSelectedOption={setToken(i)}
              classname={`gap-2 px-3 py-2 rounded-full! text-[14px] font-semibold transition-colors ${
                isDark ? "bg-[#2A2A2A] hover:bg-[#333333] text-white" : "bg-[#EEEEEE] hover:bg-[#E2E2E2] text-[#111111]"
              }`}
              arrowClassname="size-3"
            />
          </div>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={amounts[i]}
            onChange={setAmount(i)}
            aria-invalid={cardError}
            className={`flex-1 min-w-0 text-[22px] sm:text-[28px] font-semibold bg-transparent text-right outline-none placeholder:opacity-20 ${
              isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
            }`}
          />
        </div>

        <div className={`flex items-center justify-between gap-2 text-[12px] font-medium ${subMuted}`}>
          <ConversionRatio tokenSymbol={tokens[i]} tokenPrice={priceOf(tokens[i])} variant="inline" />
          <span className="shrink-0">≈ {fmtUsd(usd)}</span>
        </div>
      </motion.article>
    );
  };

  return (
    <section className="w-full min-w-0 flex flex-col gap-3">
      {/* Header: Borrow + Single/Dual toggle */}
      <div className="flex items-center justify-between gap-2">
        <span className={`text-base font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>Borrow</span>
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <span className={mode === "single" ? (isDark ? "text-white" : "text-[#111111]") : subMuted}>
            Single Borrow
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={mode === "dual"}
            aria-label="Toggle dual borrow"
            onClick={() => setMode((m) => (m === "single" ? "dual" : "single"))}
            className="relative w-10 h-5 rounded-full transition-colors cursor-pointer shrink-0"
            style={{ background: mode === "dual" ? GRADIENT : isDark ? "#333333" : "#D1D5DB" }}
          >
            <motion.span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow"
              animate={{ left: mode === "dual" ? "calc(100% - 1.125rem)" : "0.125rem" }}
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
            />
          </button>
          <span className={mode === "dual" ? (isDark ? "text-white" : "text-[#111111]") : subMuted}>
            Dual Borrow
          </span>
        </div>
      </div>

      {/* Borrow cards — stacked on mobile, side-by-side from lg up */}
      <div className={`w-full min-w-0 grid gap-3 ${mode === "dual" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>
        {Array.from({ length: slotCount }).map((_, i) => renderCard(i))}
      </div>

      {/* Total + Max */}
      <div className="flex items-center justify-between text-sm">
        <span className={`font-semibold ${exceeds ? "" : isDark ? "text-white" : "text-[#111111]"}`} style={exceeds ? { color: BRAND_RED } : undefined}>
          Total: {fmtUsd(totalUsd)}
        </span>
        <span className={`font-medium ${subMuted}`}>Max: {fmtUsd(maxUsd)}</span>
      </div>

      {/* Inline validation message */}
      {error && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[12px] font-medium"
          style={{ color: BRAND_RED }}
          role="alert"
        >
          {error}
        </motion.p>
      )}

      {/* Leverage slider — sets the borrow ceiling (Max) */}
      <section className="relative z-0 flex items-start justify-between gap-3">
        <div className={`flex gap-0.5 items-center rounded-lg border p-0.5 shrink-0 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}>
          <button
            type="button"
            onClick={() => leverage > 1 && setLeverage(leverage - 1)}
            disabled={leverage <= 1}
            className={`w-4 h-8 flex items-center justify-center rounded-md text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? "text-white hover:bg-[#222222]" : "hover:bg-[#F7F7F7]"}`}
            aria-label="Decrease leverage"
          >
            −
          </button>
          <span className={`w-8 h-8 flex items-center justify-center text-[14px] font-medium ${isDark ? "text-white" : ""}`}>
            {leverage}
          </span>
          <button
            type="button"
            onClick={() => leverage < MAX_LEVERAGE && setLeverage(leverage + 1)}
            disabled={leverage >= MAX_LEVERAGE}
            className={`w-4 h-8 flex items-center justify-center rounded-md text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? "text-white hover:bg-[#222222]" : "hover:bg-[#F7F7F7]"}`}
            aria-label="Increase leverage"
          >
            +
          </button>
        </div>
        <div className="flex-1 min-w-0 pl-2 mt-1.5">
          <LeverageSlider value={leverage} onChange={setLeverage} max={MAX_LEVERAGE} min={1} step={1} markers={[1, 3, 5, 7, 10]} />
        </div>
      </section>
    </section>
  );
};
