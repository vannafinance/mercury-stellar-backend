"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, createMarginAccount } from "@/store/margin-account-info-store";
import { executeOneClickStrategy } from "@/lib/one-click-strategy";
import { iconPaths } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { LeverageSlider } from "@/components/ui/leverage-slider";
import { Modal } from "@/components/ui/modal";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

/* ═══════════════════════════════════════════════════════════════
   Pool & Token types
   ═══════════════════════════════════════════════════════════════ */

type PoolType = "lp" | "single";

interface PoolOption {
  id: string;
  type: PoolType;
  tokens: string[];
  protocol: string;
  poolVersion: string;
  feeTier: string;
  supplyApr: number;
  borrowApr: number;
  tvl: string;
  vannaTvl: string;
  tags: string[];
}

const POOL_OPTIONS: PoolOption[] = [
  // ─── Blend Lending Pools ───
  {
    id: "usdc-blend", type: "single", tokens: ["USDC"], protocol: "Blend", poolVersion: "V1",
    feeTier: "-", supplyApr: 8.1, borrowApr: 5.0, tvl: "$9.8M", vannaTvl: "$6.5M", tags: ["Vanna", "Blend"],
  },
  {
    id: "xlm-blend", type: "single", tokens: ["XLM"], protocol: "Blend", poolVersion: "V1",
    feeTier: "-", supplyApr: 5.2, borrowApr: 3.5, tvl: "$12.4M", vannaTvl: "$8.2M", tags: ["Vanna", "Blend"],
  },
  // ─── Aquarius AMM LP Pools ───
  {
    id: "xlm-usdc-aquarius", type: "lp", tokens: ["XLM", "USDC"], protocol: "Aquarius", poolVersion: "AMM",
    feeTier: "0.3%", supplyApr: 12.5, borrowApr: 6.0, tvl: "$5.3M", vannaTvl: "$3.1M", tags: ["Vanna", "Aquarius"],
  },
  // ─── Soroswap DEX LP Pools ───
  {
    id: "xlm-usdc-soroswap", type: "lp", tokens: ["XLM", "USDC"], protocol: "Soroswap", poolVersion: "DEX",
    feeTier: "0.3%", supplyApr: 10.2, borrowApr: 5.5, tvl: "$3.8M", vannaTvl: "$2.4M", tags: ["Vanna", "Soroswap"],
  },
];

/* ─── token helpers ─── */
type TokenAsset = "XLM" | "USDC";

const TOKEN_LIST: { asset: TokenAsset; icon: string; label: string }[] = [
  { asset: "XLM", icon: iconPaths.XLM, label: "XLM" },
  { asset: "USDC", icon: iconPaths.USDC, label: "USDC" },
];

const getTokenIcon = (symbol: string) => {
  const icons: Record<string, string> = iconPaths;
  return icons[symbol] || "";
};

/* ─── Scenario types ─── */
type StrategyScenario = "same-asset" | "cross-asset-keep" | "cross-asset-swap";

/* ─── animation variants ─── */
const expandCollapse: Variants = {
  hidden: { opacity: 0, height: 0 },
  visible: { opacity: 1, height: "auto", transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] } },
  exit: { opacity: 0, height: 0, transition: { duration: 0.3, ease: "easeInOut" } },
};

const metricCardVariant: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.97 },
  visible: (i: number) => ({
    opacity: 1, y: 0, scale: 1,
    transition: { duration: 0.3, delay: i * 0.05, ease: "easeOut" },
  }),
};

/* ─── Pool Token Badge ─── */
const PoolTokenBadge = ({ symbol, size = 20 }: { symbol: string; size?: number }) => {
  const icon = getTokenIcon(symbol);
  if (icon) {
    return <Image src={icon} alt={symbol} width={size} height={size} className="rounded-full" />;
  }
  const palette: Record<string, string> = {
    XLM: "#703AE6", USDC: "#2775CA", BLUSDC: "#10B981", AqUSDC: "#F59E0B", SoUSDC: "#FF007A",
  };
  const bg = palette[symbol] || "#595959";
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold shrink-0 border-2 border-white/20"
      style={{ width: size, height: size, fontSize: size * 0.4, backgroundColor: bg }}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════════════════════ */

export const OneClickStrategy = () => {
  const { isDark } = useTheme();
  const userAddress = useUserStore((s) => s.address);
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);

  // ─── Pool selection ───
  const [selectedPoolId, setSelectedPoolId] = useState("xlm-blend");
  const [poolDropdownOpen, setPoolDropdownOpen] = useState(false);
  const selectedPool = useMemo(
    () => POOL_OPTIONS.find((p) => p.id === selectedPoolId) || POOL_OPTIONS[0],
    [selectedPoolId]
  );

  // ─── Form state ───
  const [collateralAsset, setCollateralAsset] = useState<TokenAsset>("XLM");
  const [tokenDropdownOpen, setTokenDropdownOpen] = useState(false);
  const tokenDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tokenDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (tokenDropdownRef.current && !tokenDropdownRef.current.contains(e.target as Node)) {
        setTokenDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tokenDropdownOpen]);
  const [collateralAmount, setCollateralAmount] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [scenario, setScenario] = useState<StrategyScenario>("same-asset");
  const [prices, setPrices] = useState<Record<string, number>>({ XLM: 1.0, USDC: 1.0 });
  const [loading, setLoading] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [txModal, setTxModal] = useState<{
    open: boolean;
    status: "pending" | "success" | "error";
    title: string;
    message: string;
    txHash?: string;
  }>({ open: false, status: "pending", title: "", message: "" });

  useEffect(() => {
    fetch("/api/prices")
      .then((r) => r.json())
      .then((d) => setPrices((p) => ({ ...p, ...d })))
      .catch(() => {});
  }, []);

  // Wallet balance from Stellar user store
  const walletBalance = tokenBalances?.[collateralAsset] ?? "0";
  const balanceNum = Number(walletBalance) || 0;

  /* ═══════════════════════════════════════
     Scenario Detection
     ═══════════════════════════════════════ */
  const isSameAsset = useMemo(() => {
    if (selectedPool.type === "single") return selectedPool.tokens[0] === collateralAsset;
    return selectedPool.tokens.includes(collateralAsset);
  }, [selectedPool, collateralAsset]);

  useEffect(() => {
    setScenario(isSameAsset ? "same-asset" : "cross-asset-keep");
  }, [isSameAsset]);

  /* ═══════════════════════════════════════
     Calculations
     ═══════════════════════════════════════ */
  const collateralNum = Number(collateralAmount) || 0;
  const collateralPrice = prices[collateralAsset] || 0;
  const collateralUsd = collateralNum * collateralPrice;

  const borrowAsset = useMemo(() => {
    if (isSameAsset) return collateralAsset;
    if (selectedPool.type === "single") return selectedPool.tokens[0] as TokenAsset;
    return (selectedPool.tokens.find((t) => t !== collateralAsset) || selectedPool.tokens[0]) as TokenAsset;
  }, [selectedPool, collateralAsset, isSameAsset]);

  const borrowPrice = prices[borrowAsset] || 1;

  const borrowedAmount = useMemo(() => {
    if (leverage <= 1 || collateralNum <= 0) return 0;
    const borrowUsdNeeded = collateralUsd * (leverage - 1);
    return borrowUsdNeeded / borrowPrice;
  }, [leverage, collateralNum, collateralUsd, borrowPrice]);

  const borrowUsd = borrowedAmount * borrowPrice;
  const totalPositionUsd = collateralUsd + borrowUsd;

  // APR calculations
  const aprCalc = useMemo(() => {
    const supplyApr = selectedPool.supplyApr;
    const vannaBorrowApr = selectedPool.borrowApr;

    if (scenario === "same-asset") {
      const totalDeployed = collateralNum + borrowedAmount;
      const totalMultiplier = collateralNum > 0 ? totalDeployed / collateralNum : 1;
      const supplyEarnings = totalMultiplier * supplyApr;
      const borrowCost = (leverage - 1) * vannaBorrowApr;
      const netApr = supplyEarnings - borrowCost;
      return {
        netApr, supplyEarnings, borrowCost,
        legs: [{ label: `${selectedPool.tokens.join("/")} Supply`, apr: supplyApr, multiplier: totalMultiplier, earning: supplyEarnings }],
      };
    }

    if (scenario === "cross-asset-keep") {
      const collateralPool = POOL_OPTIONS.find((p) => p.tokens[0] === collateralAsset);
      const collateralSupplyApr = collateralPool?.supplyApr ?? 0;
      const collateralEarning = collateralSupplyApr;
      const borrowMultiplier = collateralNum > 0 ? (borrowedAmount * borrowPrice) / collateralUsd : 0;
      const targetEarning = borrowMultiplier * supplyApr;
      const borrowCost = borrowMultiplier * vannaBorrowApr;
      const netApr = collateralEarning + targetEarning - borrowCost;
      return {
        netApr, supplyEarnings: collateralEarning + targetEarning, borrowCost,
        legs: [
          { label: `${selectedPool.protocol} ${collateralAsset} pool`, apr: collateralSupplyApr, multiplier: 1, earning: collateralEarning },
          { label: `${selectedPool.protocol} ${selectedPool.tokens[0]} pool`, apr: supplyApr, multiplier: borrowMultiplier, earning: targetEarning },
        ],
      };
    }

    // cross-asset-swap
    const totalTargetUsd = collateralUsd + borrowUsd;
    const totalMultiplier = collateralUsd > 0 ? totalTargetUsd / collateralUsd : 1;
    const supplyEarnings = totalMultiplier * supplyApr;
    const borrowMultiplier = collateralUsd > 0 ? borrowUsd / collateralUsd : 0;
    const borrowCost = borrowMultiplier * vannaBorrowApr;
    const netApr = supplyEarnings - borrowCost;
    return {
      netApr, supplyEarnings, borrowCost,
      legs: [{ label: `${selectedPool.tokens.join("/")} (all-in)`, apr: supplyApr, multiplier: totalMultiplier, earning: supplyEarnings }],
    };
  }, [scenario, selectedPool, collateralNum, borrowedAmount, leverage, collateralUsd, borrowUsd, borrowPrice, collateralAsset]);

  const totalCollateralUsd = totalCollateralValue + collateralUsd;
  const totalBorrowUsd = totalBorrowedValue + borrowUsd;
  const newHF = totalBorrowUsd > 0 ? totalCollateralUsd / totalBorrowUsd : 0;
  const newLTV = totalCollateralUsd > 0 ? (totalBorrowUsd / totalCollateralUsd) * 100 : 0;
  const maxBorrowUsd = collateralUsd * 0.8 + Math.max(0, totalCollateralValue - totalBorrowedValue) * 0.8;
  const liquidationPrice = collateralNum > 0 && borrowedAmount > 0 ? (borrowUsd * 1.1) / collateralNum : 0;
  const liquidationBuffer = newHF > 0 ? ((newHF - 1) / newHF) * 100 : 0;

  const hasDeposit = collateralNum > 0;
  const hasBorrow = borrowedAmount > 0;

  const maxLeverageForAsset = (asset: string) => (asset === "USDC" ? 7 : 5);
  const maxLev = maxLeverageForAsset(collateralAsset);

  const dailyEarning = (aprCalc.netApr / 100 / 365) * collateralUsd;
  const monthlyEarning = dailyEarning * 30;
  const yearlyEarning = (aprCalc.netApr / 100) * collateralUsd;

  /* ─── Create margin account ─── */
  const handleCreateAccount = async () => {
    if (!userAddress) return;
    setLoading(true);
    setTxModal({ open: true, status: "pending", title: "Creating Margin Account", message: "Creating your Vanna margin account on Stellar..." });
    try {
      const success = await createMarginAccount(userAddress);
      if (success) {
        setTxModal({ open: true, status: "success", title: "Account Created", message: "Your Vanna margin account is ready!" });
      } else {
        throw new Error("Failed to create margin account");
      }
    } catch (err: any) {
      setTxModal({ open: true, status: "error", title: "Failed", message: err?.message || "Failed to create margin account" });
    } finally {
      setLoading(false);
    }
  };

  /* ─── Execute strategy ─── */
  const handleExecute = async () => {
    if (!userAddress || !marginAccountAddress || collateralNum <= 0) return;
    setLoading(true);

    setTxModal({
      open: true, status: "pending", title: "Opening Leveraged Position",
      message: `Preparing transaction...`,
    });

    try {
      const result = await executeOneClickStrategy({
        userAddress,
        marginAccountAddress,
        collateralAsset,
        collateralAmount: collateralNum,
        borrowAsset,
        borrowAmount: borrowedAmount,
        leverage,
        poolProtocol: selectedPool.protocol,
        poolType: selectedPool.type,
        poolTokens: selectedPool.tokens,
        scenario,
        prices,
        onStep: (msg) => {
          setTxModal((p) => ({ ...p, message: msg }));
        },
      });

      if (!result.success) throw new Error(result.error);

      setTxModal({
        open: true, status: "success",
        title: "Strategy Deployed!",
        message: `Deployed $${totalPositionUsd.toFixed(2)} to ${selectedPool.tokens.join("/")} on ${selectedPool.protocol}. Net APR: ~${aprCalc.netApr.toFixed(1)}%`,
        txHash: result.hash,
      });
      setCollateralAmount("");
      setLeverage(1);
    } catch (err: any) {
      const rejected =
        err?.message?.includes("cancelled") ||
        err?.message?.includes("rejected") ||
        err?.message?.includes("denied");
      setTxModal({
        open: true, status: "error",
        title: rejected ? "Cancelled" : "Failed",
        message: rejected ? "Transaction cancelled" : err?.message || "Operation failed",
      });
    } finally {
      setLoading(false);
    }
  };

  const isValid =
    collateralNum > 0 &&
    collateralNum <= balanceNum &&
    (borrowedAmount <= 0 || (borrowUsd <= maxBorrowUsd && newHF > 1.2)) &&
    !!userAddress &&
    !!marginAccountAddress;

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!hasMarginAccount) return "Create Margin Account";
    if (collateralNum <= 0) return "Enter Deposit Amount";
    if (collateralNum > balanceNum) return "Insufficient Balance";
    if (borrowedAmount > 0 && borrowUsd > maxBorrowUsd) return "Exceeds Borrow Limit";
    if (borrowedAmount > 0 && newHF > 0 && newHF <= 1.2) return "Position Too Risky";
    if (loading) return "Processing...";
    return leverage > 1 ? "Deploy Strategy" : "Deposit Margin";
  };

  /* ─── theme helpers ─── */
  const cardBg = isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]";
  const inputBg = isDark ? "bg-[#111111] border-[#2C2C2C]" : "bg-[#F7F7F7] border-[#E5E7EB]";
  const mutedText = isDark ? "text-[#595959]" : "text-[#A9A9A9]";
  const labelText = isDark ? "text-[#919191]" : "text-[#76737B]";
  const headingText = isDark ? "text-white" : "text-[#111111]";
  const subtleCard = isDark ? "bg-[#151515] border-[#2C2C2C]" : "bg-[#FAFAFA] border-[#F4F4F4]";
  const hfColor = newHF >= 1.5 ? "#703AE6" : newHF >= 1.2 ? "#F59E0B" : "#FC5457";

  return (
    <>
      {/* ─── Transaction Status Modal ─── */}
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
            <h3 className={`text-[16px] font-bold mb-1.5 ${headingText}`}>{txModal.title}</h3>
            <p className={`text-[13px] leading-[20px] ${labelText}`}>{txModal.message}</p>
            {txModal.txHash && (
              <p className={`text-[11px] mt-2 font-mono ${mutedText}`}>
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
              Close
            </button>
          )}
        </div>
      </Modal>

      <div className="w-full h-fit flex flex-col lg:flex-row gap-5">
        {/* ═══════ LEFT: Strategy Form ═══════ */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="w-full lg:flex-[1_1_0%] min-w-0 h-fit flex flex-col"
        >
          {/* ── POOL SELECTOR ── */}
          <div className={`w-full border rounded-t-xl p-4 sm:p-5 ${cardBg}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-2 h-2 rounded-full bg-gradient shrink-0" />
              <h3 className={`text-[13px] font-semibold leading-5 ${headingText}`}>Yield Pool</h3>
              <span className={`text-[10px] font-semibold uppercase tracking-[0.5px] px-2 py-0.5 rounded-full ${isDark ? "bg-[#2C2C2C] text-[#919191]" : "bg-[#F4F4F4] text-[#76737B]"}`}>
                {selectedPool.protocol}
              </span>
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setPoolDropdownOpen(!poolDropdownOpen)}
                className={`w-full flex items-center justify-between rounded-[12px] border-[1px] p-[14px] sm:p-[16px] cursor-pointer transition-all duration-200 ${inputBg} ${poolDropdownOpen ? (isDark ? "border-[#703AE6]/40" : "border-[#703AE6]/30") : ""} hover:border-[#703AE6]/20`}
              >
                <div className="flex items-center gap-[12px]">
                  <div className="flex items-center -space-x-[6px]">
                    {selectedPool.tokens.map((t, i) => (
                      <div key={t} className="relative" style={{ zIndex: selectedPool.tokens.length - i }}>
                        <PoolTokenBadge symbol={t} size={28} />
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-[2px]">
                    <span className={`text-[15px] sm:text-[16px] font-bold leading-[22px] ${headingText}`}>
                      {selectedPool.tokens.join(" / ")}
                    </span>
                    <span className={`text-[11px] leading-[14px] ${mutedText}`}>
                      {selectedPool.protocol} {selectedPool.poolVersion} {selectedPool.feeTier !== "-" && `· ${selectedPool.feeTier}`}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-[12px]">
                  <div className="flex flex-col items-end gap-[1px]">
                    <span className="text-[14px] font-bold text-[#10B981] leading-[20px]">{selectedPool.supplyApr}%</span>
                    <span className={`text-[10px] leading-[13px] ${mutedText}`}>Supply APR</span>
                  </div>
                  <motion.svg
                    animate={{ rotate: poolDropdownOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke={isDark ? "#595959" : "#A9A9A9"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </motion.svg>
                </div>
              </button>

              <AnimatePresence>
                {poolDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                    className={`absolute top-full left-0 right-0 mt-[4px] rounded-[12px] border-[1px] overflow-hidden z-50 max-h-[320px] overflow-y-auto ${isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]"}`}
                  >
                    {POOL_OPTIONS.map((pool) => (
                      <button
                        key={pool.id}
                        type="button"
                        onClick={() => { setSelectedPoolId(pool.id); setPoolDropdownOpen(false); }}
                        className={`w-full flex items-center justify-between px-[14px] py-[12px] cursor-pointer transition-colors ${
                          pool.id === selectedPoolId
                            ? isDark ? "bg-[#703AE6]/10" : "bg-[#F1EBFD]"
                            : isDark ? "hover:bg-[#222]" : "hover:bg-[#FAFAFA]"
                        }`}
                      >
                        <div className="flex items-center gap-[10px]">
                          <div className="flex items-center -space-x-[4px]">
                            {pool.tokens.map((t, i) => (
                              <div key={t} style={{ zIndex: pool.tokens.length - i }}>
                                <PoolTokenBadge symbol={t} size={22} />
                              </div>
                            ))}
                          </div>
                          <div className="flex flex-col items-start gap-[1px]">
                            <span className={`text-[13px] font-semibold ${headingText}`}>{pool.tokens.join("/")}</span>
                            <span className={`text-[10px] ${mutedText}`}>{pool.protocol} {pool.poolVersion}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-[16px]">
                          <div className="flex flex-col items-end">
                            <span className="text-[12px] font-bold text-[#10B981]">{pool.supplyApr}%</span>
                            <span className={`text-[9px] ${mutedText}`}>APR</span>
                          </div>
                          <span className={`text-[10px] font-medium px-[6px] py-[1px] rounded-[4px] ${isDark ? "bg-[#2C2C2C] text-[#919191]" : "bg-[#F4F4F4] text-[#76737B]"}`}>
                            {pool.tvl}
                          </span>
                        </div>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* ── STEP 1: DEPOSIT COLLATERAL ── */}
          <div className={`w-full border border-t-0 p-4 sm:p-5 ${cardBg}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-7 h-7 rounded-full bg-gradient flex items-center justify-center text-white text-[12px] font-bold shrink-0 shadow-[0_2px_8px_rgba(112,58,230,0.3)]">
                1
              </div>
              <div className="flex flex-col">
                <h3 className={`text-[14px] font-semibold leading-5 ${headingText}`}>Deposit Collateral</h3>
                <span className={`text-[11px] leading-4 ${mutedText}`}>Your initial capital on Stellar</span>
              </div>
            </div>

            <div className={`rounded-lg border p-3 transition-all duration-300 ${inputBg} ${hasDeposit ? (isDark ? "border-[#703AE6]/30" : "border-[#703AE6]/20") : ""}`}>
              <div className="flex items-center justify-between mb-3">
                <span className={`text-[11px] font-semibold uppercase tracking-[0.5px] ${labelText}`}>You Deposit</span>
                <span className={`text-[11px] ${mutedText}`}>
                  Wallet: {Number(walletBalance).toFixed(collateralAsset === "XLM" ? 4 : 2)}
                  <button
                    type="button"
                    onClick={() => {
                      const val = collateralAsset === "XLM" ? Math.max(balanceNum - 0.5, 0) : balanceNum;
                      setCollateralAmount(val.toFixed(2));
                    }}
                    className="ml-1.5 text-[10px] font-bold text-[#703AE6] bg-[#F1EBFD] rounded px-1.5 py-[1px] cursor-pointer hover:bg-[#703AE6]/20 transition-colors"
                  >
                    MAX
                  </button>
                </span>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={collateralAmount}
                  onChange={(e) => {
                    const sanitized = validateAmountChange(e.target.value);
                    if (sanitized === null) return;
                    setCollateralAmount(sanitized);
                  }}
                  className={`flex-1 min-w-0 bg-transparent outline-none text-[20px] sm:text-[24px] font-bold leading-8 sm:leading-9 ${headingText} placeholder:${isDark ? "text-[#2C2C2C]" : "text-[#DFDFDF]"}`}
                />
                <div className="relative shrink-0" ref={tokenDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setTokenDropdownOpen(!tokenDropdownOpen)}
                    className={`flex items-center gap-2 pl-[10px] pr-[10px] py-[8px] sm:py-[10px] rounded-[12px] text-[14px] font-semibold cursor-pointer outline-none border-[1px] transition-colors ${
                      isDark ? "bg-[#2C2C2C] text-white border-[#333] hover:border-[#444]" : "bg-[#EEEEEE] text-[#111] border-[#E5E7EB] hover:border-[#D1D5DB]"
                    }`}
                    aria-haspopup="listbox"
                    aria-expanded={tokenDropdownOpen}
                  >
                    <PoolTokenBadge symbol={collateralAsset} size={20} />
                    <span>{collateralAsset}</span>
                    <svg
                      className={`shrink-0 transition-transform duration-200 ${tokenDropdownOpen ? "rotate-180" : ""}`}
                      width="12" height="12" viewBox="0 0 24 24" fill="none"
                      stroke={isDark ? "#919191" : "#76737B"}
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <AnimatePresence>
                    {tokenDropdownOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.15 }}
                        className={`absolute right-0 top-full mt-1 z-50 rounded-xl border shadow-lg overflow-hidden min-w-[120px] ${
                          isDark ? "bg-[#222222] border-[#333333]" : "bg-white border-[#E8E8E8]"
                        }`}
                        role="listbox"
                      >
                        {TOKEN_LIST.map((t) => (
                          <button
                            key={t.asset}
                            type="button"
                            onClick={() => {
                              setCollateralAsset(t.asset as TokenAsset);
                              setCollateralAmount("");
                              setTokenDropdownOpen(false);
                            }}
                            className={`flex items-center gap-2 w-full px-4 py-2.5 text-[13px] font-medium transition-colors ${
                              t.asset === collateralAsset
                                ? "text-[#703AE6]"
                                : isDark
                                  ? "text-white hover:bg-[#333]"
                                  : "text-[#111] hover:bg-[#F5F5F5]"
                            }`}
                            role="option"
                            aria-selected={t.asset === collateralAsset}
                          >
                            <PoolTokenBadge symbol={t.asset} size={16} />
                            {t.label}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <AnimatePresence>
                {hasDeposit && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                    <span className={`text-[12px] font-medium mt-[8px] block ${mutedText}`}>
                      ≈ ${collateralUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* ── CROSS-ASSET SCENARIO TOGGLE ── */}
          <AnimatePresence>
            {hasDeposit && !isSameAsset && (
              <motion.div key="scenario-toggle" initial="hidden" animate="visible" exit="exit" variants={expandCollapse} className="overflow-hidden">
                <div className={`w-full border border-t-0 px-4 sm:px-5 py-4 ${cardBg}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-[6px] h-[6px] rounded-full bg-[#703AE6] shrink-0" />
                    <span className={`text-[13px] font-semibold ${headingText}`}>Deploy Strategy</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-[6px] font-semibold ${isDark ? "bg-[#2C2C2C] text-[#919191]" : "bg-[#F4F4F4] text-[#76737B]"}`}>
                      {collateralAsset} → {selectedPool.tokens[0]}
                    </span>
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setScenario("cross-asset-keep")}
                      className={`flex-1 rounded-[12px] border px-4 py-3 text-left transition-all cursor-pointer ${
                        scenario === "cross-asset-keep"
                          ? isDark ? "border-[#703AE6]/40 bg-[#1A1035]" : "border-[#703AE6]/30 bg-[#F1EBFD]/60"
                          : isDark ? "border-[#2C2C2C] bg-[#151515] hover:border-[#333]" : "border-[#E5E7EB] bg-[#FAFAFA] hover:border-[#D1D5DB]"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[12px] font-semibold ${scenario === "cross-asset-keep" ? (isDark ? "text-[#B794F6]" : "text-[#703AE6]") : headingText}`}>
                          Keep {collateralAsset} Exposure
                        </span>
                        <span className="text-[9px] font-bold uppercase tracking-[0.5px] px-1.5 py-[2px] rounded-[5px] bg-gradient text-white leading-none">
                          2 Pools
                        </span>
                      </div>
                      <span className={`text-[10px] leading-[15px] block ${mutedText}`}>
                        Supply {collateralAsset} to {selectedPool.protocol} {collateralAsset} pool + supply borrowed {borrowAsset} to {selectedPool.protocol} {borrowAsset} pool
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setScenario("cross-asset-swap")}
                      className={`flex-1 rounded-[12px] border px-4 py-3 text-left transition-all cursor-pointer ${
                        scenario === "cross-asset-swap"
                          ? isDark ? "border-[#703AE6]/40 bg-[#1A1035]" : "border-[#703AE6]/30 bg-[#F1EBFD]/60"
                          : isDark ? "border-[#2C2C2C] bg-[#151515] hover:border-[#333]" : "border-[#E5E7EB] bg-[#FAFAFA] hover:border-[#D1D5DB]"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[12px] font-semibold ${scenario === "cross-asset-swap" ? (isDark ? "text-[#B794F6]" : "text-[#703AE6]") : headingText}`}>
                          Full {selectedPool.tokens[0]} Exposure
                        </span>
                        <span className={`text-[9px] font-bold uppercase tracking-[0.5px] px-1.5 py-[2px] rounded-[5px] leading-none ${isDark ? "bg-[#2C2C2C] text-[#919191]" : "bg-[#EEF2FF] text-[#6B7280]"}`}>
                          1 Pool
                        </span>
                      </div>
                      <span className={`text-[10px] leading-[15px] block ${mutedText}`}>
                        Swap via Soroswap {collateralAsset} → {selectedPool.tokens[0]}, supply all to {selectedPool.protocol} {selectedPool.tokens[0]} pool
                      </span>
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── PROGRESSIVE REVEAL: Leverage + Metrics ── */}
          <AnimatePresence>
            {hasDeposit && (
              <motion.div key="leverage-section" initial="hidden" animate="visible" exit="exit" variants={expandCollapse} className="overflow-hidden">
                {/* Connector */}
                <div className={`flex items-center border-x-[1px] ${isDark ? "border-[#2C2C2C]" : "border-[#E5E7EB]"}`}>
                  <div className={`w-full flex items-center justify-center py-[6px] ${isDark ? "bg-[#151515]" : "bg-[#FAFAFA]"}`}>
                    <div className="flex flex-col items-center gap-[2px]">
                      <div className={`w-[2px] h-[8px] rounded-full ${isDark ? "bg-[#2C2C2C]" : "bg-[#DFDFDF]"}`} />
                      <motion.div
                        initial={{ scale: 0, rotate: -90 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25, delay: 0.15 }}
                        className={`w-[28px] h-[28px] rounded-full flex items-center justify-center ${isDark ? "bg-[#2C2C2C]" : "bg-[#E5E7EB]"}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#595959" : "#A9A9A9"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 5v14M19 12l-7 7-7-7" />
                        </svg>
                      </motion.div>
                      <div className={`w-[2px] h-[8px] rounded-full ${isDark ? "bg-[#2C2C2C]" : "bg-[#DFDFDF]"}`} />
                    </div>
                  </div>
                </div>

                {/* STEP 2: LEVERAGE */}
                <div className={`w-full border border-t-0 p-4 sm:p-5 ${cardBg}`}>
                  <div className="flex items-center gap-3 mb-4">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.2 }}
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 transition-all duration-300 ${
                        hasBorrow ? "bg-gradient text-white shadow-[0_2px_8px_rgba(112,58,230,0.3)]" : isDark ? "bg-[#2C2C2C] text-[#595959]" : "bg-[#E5E7EB] text-[#A9A9A9]"
                      }`}
                    >
                      2
                    </motion.div>
                    <div className="flex flex-col">
                      <h3 className={`text-[14px] font-semibold leading-5 ${headingText}`}>Set Leverage</h3>
                      <span className={`text-[11px] leading-4 ${mutedText}`}>
                        Borrow {borrowAsset} from Vanna at {selectedPool.borrowApr}% APR
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-[12px] font-semibold ${labelText}`}>Leverage</span>
                      <motion.span key={leverage} initial={{ scale: 1.2, color: "#703AE6" }} animate={{ scale: 1, color: isDark ? "#B794F6" : "#703AE6" }} className="text-[13px] font-bold">
                        {leverage}x
                      </motion.span>
                    </div>
                    <LeverageSlider
                      min={1}
                      max={maxLev}
                      step={1}
                      value={leverage}
                      onChange={setLeverage}
                      markers={maxLev === 7 ? [1, 3, 5, 7] : [1, 2, 3, 4, 5]}
                    />
                  </div>

                  <AnimatePresence>
                    {hasBorrow && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-2">
                        <div className={`rounded-[10px] border p-[12px] flex flex-col gap-[8px] ${subtleCard}`}>
                          <div className="flex items-center justify-between">
                            <span className={`text-[11px] font-medium ${labelText}`}>Borrowing</span>
                            <div className="flex items-center gap-[6px]">
                              <PoolTokenBadge symbol={borrowAsset} size={14} />
                              <span className={`text-[13px] font-bold ${headingText}`}>
                                {borrowedAmount.toFixed(collateralAsset === "XLM" ? 4 : 2)} {borrowAsset}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className={`text-[11px] font-medium ${labelText}`}>Borrow Value</span>
                            <span className={`text-[12px] font-semibold ${mutedText}`}>
                              ${borrowUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className={`text-[11px] font-medium ${labelText}`}>Total Deployed</span>
                            <span className="text-[13px] font-bold text-[#10B981]">
                              ${totalPositionUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Deployment route */}
                  <AnimatePresence>
                    {hasBorrow && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-[12px]">
                        <div className={`rounded-[10px] p-[12px] ${isDark ? "bg-[#703AE6]/8 border border-[#703AE6]/15" : "bg-[#F1EBFD] border border-[#703AE6]/10"}`}>
                          {scenario === "same-asset" && (
                            <div className="flex items-center gap-[8px]">
                              <PoolTokenBadge symbol={collateralAsset} size={14} />
                              <span className={`text-[12px] font-medium ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                                <strong>{collateralNum.toFixed(2)} + {borrowedAmount.toFixed(2)} = {(collateralNum + borrowedAmount).toFixed(2)} {collateralAsset}</strong>
                                {" "}→ <strong>{selectedPool.protocol} {collateralAsset} pool</strong>
                              </span>
                            </div>
                          )}
                          {scenario === "cross-asset-keep" && (
                            <div className="flex flex-col gap-[6px]">
                              <div className="flex items-center gap-[6px] mb-[2px]">
                                <span className={`text-[10px] font-semibold uppercase tracking-[0.5px] ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                                  Dual Supply — 2 {selectedPool.protocol} positions
                                </span>
                              </div>
                              <div className="flex items-center gap-[8px]">
                                <PoolTokenBadge symbol={collateralAsset} size={14} />
                                <span className={`text-[11px] font-medium ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                                  {collateralNum.toFixed(2)} {collateralAsset} → <strong>{selectedPool.protocol} {collateralAsset} pool</strong>
                                </span>
                              </div>
                              <div className="flex items-center gap-[8px]">
                                <PoolTokenBadge symbol={borrowAsset} size={14} />
                                <span className={`text-[11px] font-medium ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                                  {borrowedAmount.toFixed(2)} {borrowAsset} → <strong>{selectedPool.protocol} {borrowAsset} pool</strong>
                                </span>
                              </div>
                            </div>
                          )}
                          {scenario === "cross-asset-swap" && (
                            <div className="flex flex-col gap-[6px]">
                              <div className="flex items-center gap-[8px]">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#B794F6" : "#703AE6"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 014-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 01-4 4H3" />
                                </svg>
                                <span className={`text-[11px] font-medium ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                                  {collateralNum.toFixed(2)} {collateralAsset} swapped via Soroswap → {selectedPool.tokens[0]}
                                </span>
                              </div>
                              <div className="flex items-center gap-[8px]">
                                <PoolTokenBadge symbol={selectedPool.tokens[0]} size={14} />
                                <span className={`text-[11px] font-medium ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                                  <strong>${totalPositionUsd.toFixed(2)}</strong> total → <strong>{selectedPool.protocol} {selectedPool.tokens[0]} pool</strong>
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* ── NET APR ── */}
                <AnimatePresence>
                  {hasBorrow && (
                    <motion.div initial="hidden" animate="visible" exit="exit" variants={expandCollapse} className="overflow-hidden">
                      <div className={`w-full border border-t-0 p-4 sm:p-5 ${cardBg}`}>
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <div className="w-[6px] h-[6px] rounded-full bg-[#703AE6] shrink-0" />
                            <span className={`text-[13px] font-semibold ${headingText}`}>Estimated Returns</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowBreakdown(!showBreakdown)}
                            className={`text-[11px] font-semibold cursor-pointer px-2.5 py-1 rounded-[6px] transition-colors ${isDark ? "text-[#B794F6] hover:bg-[#703AE6]/10" : "text-[#703AE6] hover:bg-[#F1EBFD]"}`}
                          >
                            {showBreakdown ? "Hide details" : "View details"}
                          </button>
                        </div>

                        <div className="flex items-end justify-between mb-4">
                          <div>
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] block mb-1 ${labelText}`}>Net APR</span>
                            <motion.span
                              key={aprCalc.netApr.toFixed(1)}
                              initial={{ scale: 0.95, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              className={`text-[36px] sm:text-[42px] font-bold leading-none block ${headingText}`}
                            >
                              {aprCalc.netApr.toFixed(1)}%
                            </motion.span>
                          </div>
                          {collateralUsd > 0 && (
                            <div className="flex gap-5">
                              {[
                                { label: "Daily", value: dailyEarning },
                                { label: "Monthly", value: monthlyEarning },
                                { label: "Yearly", value: yearlyEarning },
                              ].map((item) => (
                                <div key={item.label} className="flex flex-col items-end gap-[2px]">
                                  <span className={`text-[10px] font-medium ${mutedText}`}>{item.label}</span>
                                  <span className={`text-[14px] font-bold ${headingText}`}>
                                    {item.value >= 0 ? "+" : "-"}${Math.abs(item.value).toFixed(2)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <AnimatePresence>
                          {showBreakdown && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                              <div className={`rounded-[12px] overflow-hidden border ${isDark ? "border-[#2C2C2C]" : "border-[#E5E7EB]"}`}>
                                {aprCalc.legs.map((leg, i) => (
                                  <div key={i} className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#1E1E1E]" : "bg-white"} ${i > 0 ? (isDark ? "border-t border-[#2C2C2C]" : "border-t border-[#F4F4F4]") : ""}`}>
                                    <span className={`text-[12px] font-medium ${headingText}`}>{leg.label}</span>
                                    <div className="flex items-center gap-2">
                                      <span className={`text-[12px] font-bold ${headingText}`}>+{leg.earning.toFixed(1)}%</span>
                                      <span className={`text-[10px] font-medium ${mutedText}`}>{leg.apr}% × {leg.multiplier.toFixed(1)}x</span>
                                    </div>
                                  </div>
                                ))}
                                <div className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#1E1E1E] border-t border-[#2C2C2C]" : "bg-white border-t border-[#F4F4F4]"}`}>
                                  <span className={`text-[12px] font-medium ${headingText}`}>Vanna Borrow Cost</span>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-bold text-[#FC5457]">-{aprCalc.borrowCost.toFixed(1)}%</span>
                                    <span className={`text-[10px] font-medium ${mutedText}`}>{selectedPool.borrowApr}% × {(leverage - 1).toFixed(1)}x</span>
                                  </div>
                                </div>
                                <div className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#703AE6]/8 border-t border-[#703AE6]/15" : "bg-[#F1EBFD]/50 border-t border-[#703AE6]/10"}`}>
                                  <span className={`text-[12px] font-semibold ${headingText}`}>Net APR</span>
                                  <span className={`text-[14px] font-bold ${headingText}`}>
                                    {aprCalc.netApr > 0 ? "+" : ""}{aprCalc.netApr.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* ── RISK METRICS ── */}
                <AnimatePresence>
                  {hasBorrow && (
                    <motion.div initial="hidden" animate="visible" exit="exit" variants={expandCollapse} className="overflow-hidden">
                      <div className={`w-full border border-t-0 p-4 sm:p-5 ${cardBg}`}>
                        <div className="flex items-center gap-2 mb-4">
                          <div className="w-[6px] h-[6px] rounded-full bg-[#703AE6] shrink-0" />
                          <span className={`text-[13px] font-semibold ${headingText}`}>Position Overview</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-[10px]">
                          <motion.div custom={0} variants={metricCardVariant} initial="hidden" animate="visible"
                            className={`rounded-[12px] p-[14px] flex flex-col gap-[6px] ${isDark ? "bg-[#1E1E1E] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}
                          >
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] ${labelText}`}>Health Factor</span>
                            <span className={`text-[20px] font-bold ${headingText}`}>{newHF > 0 ? newHF.toFixed(2) : "—"}</span>
                            {newHF > 0 && (
                              <div className={`w-full h-[3px] rounded-full overflow-hidden ${isDark ? "bg-[#2C2C2C]" : "bg-[#F4F4F4]"}`}>
                                <motion.div
                                  className="h-full rounded-full"
                                  initial={{ width: 0 }}
                                  animate={{ width: `${Math.min((newHF / 3) * 100, 100)}%` }}
                                  style={{ backgroundColor: hfColor }}
                                />
                              </div>
                            )}
                          </motion.div>
                          <motion.div custom={1} variants={metricCardVariant} initial="hidden" animate="visible"
                            className={`rounded-[12px] p-[14px] flex flex-col gap-[4px] ${isDark ? "bg-[#1E1E1E] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}
                          >
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] ${labelText}`}>LTV</span>
                            <span className={`text-[20px] font-bold ${headingText}`}>{newLTV > 0 ? `${newLTV.toFixed(1)}%` : "—"}</span>
                          </motion.div>
                          {liquidationPrice > 0 && (
                            <motion.div custom={2} variants={metricCardVariant} initial="hidden" animate="visible"
                              className={`rounded-[12px] p-[14px] flex flex-col gap-[4px] ${isDark ? "bg-[#1E1E1E] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}
                            >
                              <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] ${labelText}`}>Liq. Price ({collateralAsset})</span>
                              <span className={`text-[20px] font-bold ${headingText}`}>${liquidationPrice.toFixed(collateralAsset === "XLM" ? 4 : 2)}</span>
                            </motion.div>
                          )}
                          <motion.div custom={3} variants={metricCardVariant} initial="hidden" animate="visible"
                            className={`rounded-[12px] p-[14px] flex flex-col gap-[4px] ${isDark ? "bg-[#1E1E1E] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}
                          >
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] ${labelText}`}>Liq. Buffer</span>
                            <span className={`text-[20px] font-bold ${headingText}`}>{liquidationBuffer > 0 ? `${liquidationBuffer.toFixed(1)}%` : "—"}</span>
                          </motion.div>
                          <motion.div custom={4} variants={metricCardVariant} initial="hidden" animate="visible"
                            className={`rounded-[12px] p-[14px] flex flex-col gap-[4px] ${isDark ? "bg-[#1E1E1E] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}
                          >
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] ${labelText}`}>Borrow Cost</span>
                            <span className="text-[20px] font-bold text-[#703AE6]">{aprCalc.borrowCost.toFixed(1)}%</span>
                          </motion.div>
                          <motion.div custom={5} variants={metricCardVariant} initial="hidden" animate="visible"
                            className={`rounded-[12px] p-[14px] flex flex-col gap-[4px] ${isDark ? "bg-[#1E1E1E] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}
                          >
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.3px] ${labelText}`}>Effective Leverage</span>
                            <span className={`text-[20px] font-bold ${headingText}`}>{leverage.toFixed(1)}x</span>
                          </motion.div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* ── HOW IT WORKS ── */}
                <AnimatePresence>
                  {hasBorrow && leverage > 1 && (
                    <motion.div initial="hidden" animate="visible" exit="exit" variants={expandCollapse} className="overflow-hidden">
                      <div className={`w-full border border-t-0 p-4 sm:p-5 ${cardBg}`}>
                        <div className="flex items-center gap-2 mb-3">
                          <span className={`text-[13px] font-semibold ${headingText}`}>How This Works</span>
                        </div>
                        <ol className={`flex flex-col gap-2 text-[13px] font-medium leading-[20px] ${isDark ? "text-[#919191]" : "text-[#6B7280]"}`}>
                          <li className="flex gap-[10px]">
                            <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>1.</span>
                            <span>
                              You deposit{" "}
                              <span className={`font-semibold ${headingText}`}>{collateralNum.toFixed(2)} {collateralAsset}</span>{" "}
                              (~${collateralUsd.toFixed(2)}) as collateral to your Vanna margin account on Stellar.
                            </span>
                          </li>
                          <li className="flex gap-[10px]">
                            <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>2.</span>
                            <span>
                              Vanna lenders fund{" "}
                              <span className={`font-semibold ${headingText}`}>{borrowedAmount.toFixed(2)} {borrowAsset}</span>{" "}
                              (~${borrowUsd.toFixed(2)}) at {selectedPool.borrowApr}% APR.
                            </span>
                          </li>
                          {scenario === "same-asset" && (
                            <li className="flex gap-[10px]">
                              <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>3.</span>
                              <span>
                                <span className={`font-semibold ${headingText}`}>{(collateralNum + borrowedAmount).toFixed(2)} {collateralAsset}</span>{" "}
                                deployed to{" "}
                                <span className={`font-semibold ${headingText}`}>{selectedPool.tokens.join("/")}</span>{" "}
                                on {selectedPool.protocol} at {selectedPool.supplyApr}% supply APR.
                              </span>
                            </li>
                          )}
                          {scenario === "cross-asset-keep" && (
                            <>
                              <li className="flex gap-[10px]">
                                <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>3.</span>
                                <span>
                                  Your <span className={`font-semibold ${headingText}`}>{collateralNum.toFixed(2)} {collateralAsset}</span>{" "}
                                  supplied to <span className={`font-semibold ${headingText}`}>{selectedPool.protocol} {collateralAsset} pool</span> at {POOL_OPTIONS.find((p) => p.tokens[0] === collateralAsset)?.supplyApr ?? 0}% APR.
                                </span>
                              </li>
                              <li className="flex gap-[10px]">
                                <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>4.</span>
                                <span>
                                  <span className={`font-semibold ${headingText}`}>{borrowedAmount.toFixed(2)} {borrowAsset}</span>{" "}
                                  supplied to <span className={`font-semibold ${headingText}`}>{selectedPool.protocol} {borrowAsset} pool</span> at {selectedPool.supplyApr}% APR.
                                </span>
                              </li>
                            </>
                          )}
                          {scenario === "cross-asset-swap" && (
                            <>
                              <li className="flex gap-[10px]">
                                <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>3.</span>
                                <span>
                                  Your {collateralAsset} is <span className={`font-semibold ${headingText}`}>swapped via Soroswap to {selectedPool.tokens[0]}</span> — no more {collateralAsset} exposure.
                                </span>
                              </li>
                              <li className="flex gap-[10px]">
                                <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>4.</span>
                                <span>
                                  <span className={`font-semibold ${headingText}`}>${totalPositionUsd.toFixed(2)}</span>{" "}
                                  total deployed to <span className={`font-semibold ${headingText}`}>{selectedPool.tokens.join("/")}</span>{" "}
                                  on {selectedPool.protocol} at {selectedPool.supplyApr}% APR.
                                </span>
                              </li>
                            </>
                          )}
                          <li className="flex gap-[10px]">
                            <span className={`shrink-0 ${isDark ? "text-[#595959]" : "text-[#A9A9A9]"}`}>
                              {scenario === "same-asset" ? "4" : "5"}.
                            </span>
                            <span>
                              Net result:{" "}
                              <span className={`font-semibold ${headingText}`}>{aprCalc.netApr.toFixed(1)}% APR</span>{" "}
                              on your ${collateralUsd.toFixed(2)} deposit.
                            </span>
                          </li>
                        </ol>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── CTA BUTTON ── */}
          <div className={`w-full border border-t-0 p-4 sm:p-5 rounded-b-xl ${cardBg}`}>
            <AnimatePresence>
              {newHF > 0 && newHF <= 1.5 && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className={`mb-3 rounded-[12px] px-4 py-3 text-[12px] font-medium flex items-center gap-3 ${
                    newHF <= 1.2
                      ? "bg-[#FC5457]/10 text-[#FC5457] border border-[#FC5457]/20"
                      : "bg-[#F59E0B]/10 text-[#F59E0B] border border-[#F59E0B]/20"
                  }`}>
                    <div className={`w-[6px] h-[6px] rounded-full shrink-0 ${newHF <= 1.2 ? "bg-[#FC5457]" : "bg-[#F59E0B]"}`} />
                    {newHF <= 1.2
                      ? <span>Health Factor is <strong>{newHF.toFixed(2)}</strong> — critically low, reduce leverage</span>
                      : <span>Health Factor is <strong>{newHF.toFixed(2)}</strong> — consider reducing leverage</span>
                    }
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <Button
              text={getButtonText()}
              size="large"
              type="gradient"
              disabled={hasMarginAccount ? !isValid || loading : !userAddress || loading}
              onClick={!hasMarginAccount ? handleCreateAccount : handleExecute}
            />
          </div>
        </motion.div>

        {/* ═══════ RIGHT: Info Panel ═══════ */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1, ease: "easeOut" }}
          className="w-full lg:w-[320px] xl:w-[360px] shrink-0 h-fit flex flex-col gap-4"
        >
          {/* Network Badge */}
          <div className={`rounded-[14px] border p-4 flex items-center gap-3 ${isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]"}`}>
            <div className="w-9 h-9 rounded-full bg-[#703AE6]/10 flex items-center justify-center shrink-0">
              <Image src={iconPaths.XLM} alt="Stellar" width={20} height={20} className="rounded-full" />
            </div>
            <div>
              <p className={`text-[13px] font-semibold ${headingText}`}>Stellar Network</p>
              <p className={`text-[11px] ${mutedText}`}>Freighter wallet · Testnet</p>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
              <span className={`text-[11px] font-medium text-[#10B981]`}>Connected</span>
            </div>
          </div>

          {/* Pool Stats */}
          <div className={`rounded-[14px] border p-4 flex flex-col gap-3 ${isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]"}`}>
            <div className="flex items-center gap-2">
              <div className="w-[6px] h-[6px] rounded-full bg-[#703AE6] shrink-0" />
              <span className={`text-[12px] font-semibold ${headingText}`}>{selectedPool.protocol} · {selectedPool.tokens.join("/")} Pool</span>
            </div>
            {[
              { label: "Supply APR", value: `${selectedPool.supplyApr}%`, color: "text-[#10B981]" },
              { label: "Borrow APR", value: `${selectedPool.borrowApr}%`, color: "text-[#FC5457]" },
              { label: "Total TVL", value: selectedPool.tvl, color: headingText },
              { label: "Vanna TVL", value: selectedPool.vannaTvl, color: headingText },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between">
                <span className={`text-[12px] ${labelText}`}>{row.label}</span>
                <span className={`text-[13px] font-bold ${row.color}`}>{row.value}</span>
              </div>
            ))}
          </div>

          {/* Yield Protocols */}
          <div className={`rounded-[14px] border p-4 flex flex-col gap-3 ${isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]"}`}>
            <span className={`text-[12px] font-semibold ${headingText}`}>Supported Protocols</span>
            {[
              { name: "Blend Capital", desc: "Lending & borrowing", apr: "5–8% APR" },
              { name: "Aquarius AMM", desc: "XLM/USDC LP yield", apr: "12.5% APR" },
              { name: "Soroswap DEX", desc: "XLM/USDC LP yield", apr: "10.2% APR" },
            ].map((proto) => (
              <div key={proto.name} className="flex items-center justify-between">
                <div>
                  <p className={`text-[12px] font-semibold ${headingText}`}>{proto.name}</p>
                  <p className={`text-[10px] ${mutedText}`}>{proto.desc}</p>
                </div>
                <span className="text-[11px] font-bold text-[#10B981]">{proto.apr}</span>
              </div>
            ))}
          </div>

          {/* Risk Notice */}
          <div className={`rounded-[14px] border p-4 ${isDark ? "bg-[#FC5457]/5 border-[#FC5457]/15" : "bg-[#FFF5F5] border-[#FC5457]/20"}`}>
            <p className={`text-[11px] leading-[18px] ${isDark ? "text-[#FC5457]/80" : "text-[#FC5457]"}`}>
              <strong>Risk notice:</strong> Leveraged positions can be liquidated if your Health Factor drops below 1.1. XLM price volatility can affect your position significantly. Only deposit what you can afford to lose.
            </p>
          </div>
        </motion.div>
      </div>
    </>
  );
};
