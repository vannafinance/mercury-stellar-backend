"use client";

import { useTheme } from "@/contexts/theme-context";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { MarginAccountService } from "@/lib/margin-utils";
// refreshBorrowedBalances is called on connect to keep margin account address in sync
import { AquariusService } from "@/lib/aquarius-utils";
import { SoroswapService } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { SwapInput } from "./SwapInput";
import { SwapDirectionButton } from "./SwapDirectionButton";
import { SwapDetails } from "./SwapDetails";
import { SwapButton } from "./SwapButton";
import { TokenSearchModal } from "./TokenSearchModal";
import { SwapSettings } from "./SwapSettings";
import { Token, SwapButtonState, DexOption } from "./types";
import { MOCK_TOKENS, MOCK_DEXES } from "./mock-data";
import { AnimatePresence, motion } from "framer-motion";
import toast from "react-hot-toast";

// Stellar tokens supported for Aquarius swap
const STELLAR_TOKENS: Token[] = [
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_XLM,
    symbol: "XLM",
    name: "Stellar Lumens",
    logo: "/coins/xlm.png",
    decimals: 7,
    chain: "stellar",
    isNative: true,
    isVerified: true,
  },
  {
    id: CONTRACT_ADDRESSES.AQUARIUS_USDC,
    symbol: "USDC",
    name: "USD Coin (Aquarius)",
    logo: "/coins/usdc.svg",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
  },
];

// Stellar tokens supported for Soroswap swap (uses on-chain contract addresses)
const SOROSWAP_STELLAR_TOKENS: Token[] = [
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_XLM,
    symbol: "XLM",
    name: "Stellar Lumens",
    logo: "/coins/xlm.png",
    decimals: 7,
    chain: "stellar",
    isNative: true,
    isVerified: true,
  },
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_USDC,
    symbol: "USDC",
    name: "USD Coin",
    logo: "/icons/usdc-icon.svg",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
  },
];

function deriveSwapButtonState(
  isWalletConnected: boolean,
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  isLoading: boolean,
  amountOut: string,
  tokenInBalance: string | null,
): SwapButtonState {
  if (!isWalletConnected) return "connect_wallet";
  if (!tokenIn || !tokenOut) return "select_token";
  if (!amountIn || amountIn === "0") return "enter_amount";
  if (isLoading) return "loading_quote";
  if (
    tokenInBalance !== null &&
    parseFloat(amountIn) > parseFloat(tokenInBalance.replace(/,/g, ""))
  )
    return "insufficient_balance";
  if (!amountOut) return "disabled";
  return "ready";
}

interface SwapCardProps {
  baseSymbol?: string;
  selectedDex?: string;
  dexes?: DexOption[];
  onDexChange?: (dexId: string) => void;
  onSwitchToOrderbook?: () => void;
}

export const SwapCard = ({
  baseSymbol,
  selectedDex,
  dexes = MOCK_DEXES,
  onDexChange,
  onSwitchToOrderbook,
}: SwapCardProps) => {
  const { isDark } = useTheme();
  const [isDexDropdownOpen, setIsDexDropdownOpen] = useState(false);
  const dexDropdownRef = useRef<HTMLDivElement>(null);

  const activeDex = dexes.find((d) => d.id === selectedDex) || dexes[0];
  const isAquarius = activeDex?.id === "aquarius";
  const isSoroswap = activeDex?.id === "soroswap";

  const tokenList = isAquarius ? STELLAR_TOKENS : isSoroswap ? SOROSWAP_STELLAR_TOKENS : MOCK_TOKENS;
  const initialToken = baseSymbol
    ? tokenList.find((t) => t.symbol.toLowerCase() === baseSymbol.toLowerCase()) ?? tokenList[0]
    : tokenList[0];

  // Token state
  const [tokenIn, setTokenIn] = useState<Token | null>(initialToken);
  const [tokenOut, setTokenOut] = useState<Token | null>(tokenList[1] ?? null);

  // Amount state
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");

  // Quote state
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<string | null>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  // Swap tx state
  const [txStatus, setTxStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState("");
  const [txError, setTxError] = useState("");

  // Reset tokens and amounts when DEX changes
  useEffect(() => {
    const list = selectedDex === "aquarius" ? STELLAR_TOKENS : selectedDex === "soroswap" ? SOROSWAP_STELLAR_TOKENS : MOCK_TOKENS;
    setTokenIn(list[0] ?? null);
    setTokenOut(list[1] ?? null);
    setAmountIn("");
    setAmountOut("");
    setExchangeRate(null);
    setTxStatus("idle");
    setTxError("");
  }, [selectedDex]);

  // Settings state
  const [slippage, setSlippage] = useState("0.5");
  const [slippageMode, setSlippageMode] = useState<"auto" | "custom">("auto");
  const [deadline, setDeadline] = useState(20);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Modal state
  const [tokenModalTarget, setTokenModalTarget] = useState<"in" | "out" | null>(null);

  // Swap mode: wallet or margin account
  const [swapMode, setSwapMode] = useState<"wallet" | "margin">("margin");

  // Wallet + margin account
  const userAddress = useUserStore((s) => s.address);
  const walletXlmBalance = useUserStore((s) => s.balance);
  const isWalletConnected = Boolean(userAddress);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const [aquariusUsdcWalletBalance, setAquariusUsdcWalletBalance] = useState("0");
  // Actual token balances held by the margin account contract (updated after swap)
  const [marginXlmBalance, setMarginXlmBalance] = useState("0");
  const [marginUsdcBalance, setMarginUsdcBalance] = useState("0");

  // Soroswap wallet + margin balances
  const [soroswapUsdcWalletBalance, setSoroswapUsdcWalletBalance] = useState("0");
  const [ssMarginXlmBalance, setSsMarginXlmBalance] = useState("0");
  const [ssMarginUsdcBalance, setSsMarginUsdcBalance] = useState("0");

  useEffect(() => {
    if (!isAquarius || !userAddress) {
      setAquariusUsdcWalletBalance("0");
      return;
    }

    let cancelled = false;
    AquariusService.getAquariusUsdcWalletBalance(userAddress)
      .then((bal) => {
        if (!cancelled) setAquariusUsdcWalletBalance(bal);
      })
      .catch(() => {
        if (!cancelled) setAquariusUsdcWalletBalance("0");
      });

    return () => {
      cancelled = true;
    };
  }, [isAquarius, userAddress, txHash]);

  // Fetch Soroswap USDC wallet balance
  useEffect(() => {
    if (!isSoroswap || !userAddress) {
      setSoroswapUsdcWalletBalance("0");
      return;
    }
    let cancelled = false;
    SoroswapService.getMarginAccountTokenBalance(userAddress, 'USDC')
      .then((bal) => { if (!cancelled) setSoroswapUsdcWalletBalance(bal); })
      .catch(() => { if (!cancelled) setSoroswapUsdcWalletBalance("0"); });
    return () => { cancelled = true; };
  }, [isSoroswap, userAddress, txHash]);

  // Load margin account address when wallet connects
  useEffect(() => {
    if (!userAddress) return;
    const stored = MarginAccountService.getStoredMarginAccount(userAddress);
    if (stored?.address) refreshBorrowedBalances(stored.address);
  }, [userAddress]);

  // Fetch actual XLM/USDC token balances held by the margin account contract.
  // These update after every swap since borrowedBalances tracks lending debt (not swapped holdings).
  useEffect(() => {
    if (!isAquarius || !marginAccountAddress || swapMode !== "margin") return;
    let cancelled = false;
    Promise.all([
      AquariusService.getMarginAccountTokenBalance(marginAccountAddress, 'XLM'),
      AquariusService.getMarginAccountTokenBalance(marginAccountAddress, 'USDC'),
    ]).then(([xlm, usdc]) => {
      if (!cancelled) {
        setMarginXlmBalance(xlm);
        setMarginUsdcBalance(usdc);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isAquarius, marginAccountAddress, swapMode, txHash]);

  // Fetch Soroswap margin account token balances
  useEffect(() => {
    if (!isSoroswap || !marginAccountAddress || swapMode !== "margin") return;
    let cancelled = false;
    Promise.all([
      SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, 'XLM'),
      SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, 'USDC'),
    ]).then(([xlm, usdc]) => {
      if (!cancelled) {
        setSsMarginXlmBalance(xlm);
        setSsMarginUsdcBalance(usdc);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isSoroswap, marginAccountAddress, swapMode, txHash]);

  // Balances: Aquarius/Soroswap → wallet or margin balance depending on mode; others → null
  // Keep 7-decimal precision (Stellar token precision) so MAX/validation never overshoots.
  const getBalance = useCallback((token: Token | null): string | null => {
    if (!isWalletConnected || !token) return null;
    if (isAquarius) {
      if (swapMode === "wallet") {
        if (token.symbol === "XLM") {
          const xlm = parseFloat(walletXlmBalance || "0");
          return Math.max(0, xlm - 1).toFixed(2);
        }
        return parseFloat(aquariusUsdcWalletBalance || "0").toFixed(2);
      } else {
        if (token.symbol === "XLM") return parseFloat(marginXlmBalance).toFixed(2);
        if (token.symbol === "USDC") return parseFloat(marginUsdcBalance).toFixed(2);
        return "0.00";
      }
    }
    if (isSoroswap) {
      if (swapMode === "wallet") {
        if (token.symbol === "XLM") {
          const xlm = parseFloat(walletXlmBalance || "0");
          return Math.max(0, xlm - 1).toFixed(2);
        }
        return parseFloat(soroswapUsdcWalletBalance || "0").toFixed(2);
      } else {
        if (token.symbol === "XLM") return parseFloat(ssMarginXlmBalance).toFixed(2);
        if (token.symbol === "USDC") return parseFloat(ssMarginUsdcBalance).toFixed(2);
        return "0.00";
      }
    }
    return null;
  }, [isWalletConnected, isAquarius, isSoroswap, swapMode, walletXlmBalance, aquariusUsdcWalletBalance, marginXlmBalance, marginUsdcBalance, soroswapUsdcWalletBalance, ssMarginXlmBalance, ssMarginUsdcBalance]);

  const tokenInBalance = getBalance(tokenIn);
  const tokenOutBalance = getBalance(tokenOut);

  const tokenListBalances = useMemo(() => {
    const map: Record<string, string> = {};
    tokenList.forEach((t) => {
      const b = getBalance(t);
      if (b !== null) map[t.id] = parseFloat(b).toFixed(2);
    });
    return map;
  }, [tokenList, getBalance]);

  // Preset % state
  const [activePercent, setActivePercent] = useState<number | null>(null);

  const handlePercentClick = useCallback((pct: number) => {
    setActivePercent(pct);
    if (!tokenInBalance) return;
    const bal = parseFloat(tokenInBalance.replace(/,/g, ""));
    if (!Number.isFinite(bal) || bal <= 0) return;
    const val = (bal * pct / 100).toFixed(2);
    setAmountIn(val);
    setTxStatus("idle");
  }, [tokenInBalance]);

  // Auto-fetch quote when amountIn changes (Aquarius only)
  useEffect(() => {
    if (!isAquarius || !tokenIn || !amountIn || parseFloat(amountIn) <= 0 || !userAddress) {
      if (isAquarius) { setAmountOut(""); setExchangeRate(null); }
      return;
    }
    let cancelled = false;
    setIsQuoteLoading(true);
    AquariusService.getSwapQuote(
      parseFloat(amountIn),
      tokenIn.symbol as "XLM" | "USDC",
      userAddress,
    ).then((quote) => {
      if (cancelled) return;
      if (quote && parseFloat(quote) > 0) {
        const outNum = parseFloat(quote);
        setAmountOut(outNum.toFixed(2));
        setExchangeRate(
          `1 ${tokenIn.symbol} = ${(outNum / parseFloat(amountIn)).toFixed(2)} ${tokenOut?.symbol ?? ""}`,
        );
      } else {
        setAmountOut("");
        setExchangeRate(null);
      }
    }).finally(() => { if (!cancelled) setIsQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [amountIn, tokenIn?.id, isAquarius, userAddress]);

  // Auto-fetch quote when amountIn changes (Soroswap)
  useEffect(() => {
    if (!isSoroswap || !tokenIn || !amountIn || parseFloat(amountIn) <= 0 || !userAddress) {
      if (isSoroswap) { setAmountOut(""); setExchangeRate(null); }
      return;
    }
    let cancelled = false;
    setIsQuoteLoading(true);
    SoroswapService.getSwapQuote(
      parseFloat(amountIn),
      tokenIn.symbol as "XLM" | "USDC",
      userAddress,
    ).then((quote) => {
      if (cancelled) return;
      if (quote && parseFloat(quote) > 0) {
        const outNum = parseFloat(quote);
        setAmountOut(outNum.toFixed(2));
        setExchangeRate(
          `1 ${tokenIn.symbol} = ${(outNum / parseFloat(amountIn)).toFixed(2)} ${tokenOut?.symbol ?? ""}`,
        );
      } else {
        setAmountOut("");
        setExchangeRate(null);
      }
    }).finally(() => { if (!cancelled) setIsQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [amountIn, tokenIn?.id, isSoroswap, userAddress]);

  const isActionLoading = isQuoteLoading || txStatus === "loading";

  const buttonState = deriveSwapButtonState(
    isWalletConnected,
    tokenIn,
    tokenOut,
    amountIn,
    isActionLoading,
    amountOut,
    tokenInBalance,
  );

  const hasQuote = Boolean(
    isWalletConnected && amountIn && amountOut && tokenIn && tokenOut && !isQuoteLoading,
  );

  // Handlers
  const handleFlip = useCallback(() => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn(amountOut);
    setAmountOut(amountIn);
  }, [tokenIn, tokenOut, amountIn, amountOut]);

  const handleTokenSelect = useCallback((token: Token) => {
    if (tokenModalTarget === "in") {
      if (token.id === tokenOut?.id) setTokenOut(tokenIn);
      setTokenIn(token);
    } else {
      if (token.id === tokenIn?.id) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setAmountIn("");
    setAmountOut("");
    setTokenModalTarget(null);
  }, [tokenModalTarget, tokenIn, tokenOut]);

  const handleMaxClick = useCallback(() => {
    if (tokenInBalance) setAmountIn(tokenInBalance.replace(/,/g, ""));
  }, [tokenInBalance]);

  const handleButtonClick = useCallback(async () => {
    if (buttonState !== "ready") return;
    if (!userAddress || !tokenIn) return;
    if (swapMode === "margin" && !marginAccountAddress) return;
    if (!isAquarius && !isSoroswap) return;

    setTxStatus("loading");
    setTxError("");
    setTxHash("");

    const slippageVal = slippageMode === "auto" ? 0.5 : parseFloat(slippage);
    const requestedAmountIn = parseFloat(amountIn);
    const availableAmountIn = tokenInBalance ? parseFloat(tokenInBalance.replace(/,/g, "")) : null;
    const amountInToUse = availableAmountIn !== null
      ? Math.min(requestedAmountIn, availableAmountIn)
      : requestedAmountIn;
    if (!Number.isFinite(amountInToUse) || amountInToUse <= 0) {
      setTxStatus("error");
      setTxError("Invalid amount");
      return;
    }

    let result: { success: boolean; hash?: string; error?: string };

    if (isAquarius) {
      if (swapMode === "wallet") {
        result = await AquariusService.aquariusSwap(
          userAddress,
          marginAccountAddress ?? "",
          tokenIn.symbol as "XLM" | "USDC",
          amountInToUse,
          slippageVal,
        );
      } else {
        result = await AquariusService.aquariusSwapFromMargin(
          userAddress,
          marginAccountAddress!,
          tokenIn.symbol as "XLM" | "USDC",
          amountInToUse,
        );
      }
    } else {
      // Soroswap
      if (swapMode === "wallet") {
        result = await SoroswapService.swap(
          userAddress,
          tokenIn.symbol as "XLM" | "USDC",
          amountInToUse,
          slippageVal,
        );
      } else {
        result = await SoroswapService.swapFromMargin(
          userAddress,
          marginAccountAddress!,
          tokenIn.symbol as "XLM" | "USDC",
          amountInToUse,
        );
      }
    }

    if (result.success) {
      setTxStatus("success");
      setTxHash(result.hash ?? "");
      toast.success(`Swap submitted! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
      setAmountIn("");
      setAmountOut("");
      if (marginAccountAddress) refreshBorrowedBalances(marginAccountAddress);
    } else {
      setTxStatus("error");
      const errorMsg = result.error ?? "Swap failed";
      setTxError(errorMsg);
      toast.error(errorMsg);
    }
  }, [buttonState, isAquarius, isSoroswap, swapMode, userAddress, marginAccountAddress, tokenIn, amountIn, tokenInBalance, slippageMode, slippage]);

  const minReceived = amountOut && slippage
    ? `${(parseFloat(amountOut) * (1 - parseFloat(slippageMode === "auto" ? "0.5" : slippage) / 100)).toFixed(2)} ${tokenOut?.symbol ?? ""}`
    : null;

  return (
    <>
      <div
        className={`w-full max-w-[480px] rounded-2xl sm:rounded-3xl overflow-hidden flex flex-col transition-colors ${
          isDark
            ? "bg-[#1A1A1A] border border-[#2A2A2A]"
            : "bg-white border border-[#E8E8E8]"
        }`}
        style={{
          boxShadow: isDark
            ? "0 8px 32px rgba(0,0,0,0.3)"
            : "0 4px 20px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {/* Card body */}
        <div className="p-3 sm:p-4 flex flex-col gap-1">
          {/* Swap heading + Protocol dropdown + Settings */}
          <div className="flex items-center justify-between px-0.5 pb-2">
            {/* Swap text + via DEX dropdown */}
            <div className="relative flex items-center" ref={dexDropdownRef}>
              <span
                className={`text-[14px] sm:text-[16px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}
              >
                Swap
              </span>
              <button
                type="button"
                onClick={() => setIsDexDropdownOpen((prev) => !prev)}
                className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-1 rounded-lg text-[12px] sm:text-[14px] font-medium leading-[18px] cursor-pointer transition-colors ${
                  isDark ? "text-[#777777] hover:text-[#A7A7A7]" : "text-[#A7A7A7] hover:text-[#777777]"
                }`}
              >
                <span>via</span>
                {activeDex?.logo && (
                  <img
                    src={activeDex.logo}
                    alt={activeDex.name}
                    className="w-4 h-4 sm:w-5 sm:h-5 rounded-full object-cover"
                  />
                )}
                <span className={`font-semibold ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}>
                  {activeDex?.name}
                </span>
                <motion.svg
                  width="20"
                  height="20"
                  viewBox="0 0 10 10"
                  fill="none"
                  animate={{ rotate: isDexDropdownOpen ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <path
                    d="M2.5 3.75L5 6.25L7.5 3.75"
                    stroke={isDark ? "#555555" : "#B0B0B0"}
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </motion.svg>
              </button>

              <AnimatePresence>
                {isDexDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsDexDropdownOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: -4, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.97 }}
                      transition={{ duration: 0.12 }}
                      className={`absolute top-full left-0 mt-1 z-50 min-w-[170px] rounded-xl overflow-hidden border ${
                        isDark ? "bg-[#222222] border-[#333333]" : "bg-white border-[#E8E8E8]"
                      }`}
                      style={{
                        boxShadow: isDark ? "0 8px 24px rgba(0,0,0,0.4)" : "0 8px 24px rgba(0,0,0,0.1)",
                      }}
                    >
                      {dexes.map((dex) => {
                        const isActive = selectedDex === dex.id;
                        return (
                          <button
                            key={dex.id}
                            type="button"
                            onClick={() => { onDexChange?.(dex.id); setIsDexDropdownOpen(false); }}
                            disabled={dex.isAvailable === false}
                            className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left cursor-pointer transition-colors ${
                              isActive
                                ? isDark ? "bg-[#703AE6]/10" : "bg-[#F6F2FE]"
                                : isDark ? "hover:bg-[#2A2A2A]" : "hover:bg-[#FAFAFA]"
                            } ${dex.isAvailable === false ? "opacity-40 cursor-not-allowed" : ""}`}
                          >
                            {dex.logo && (
                              <img src={dex.logo} alt={dex.name} className="w-5 h-5 rounded-full object-cover" />
                            )}
                            <span
                              className={`text-[13px] font-semibold leading-[18px] ${
                                isActive ? "text-[#703AE6]" : isDark ? "text-[#CCCCCC]" : "text-[#333333]"
                              }`}
                            >
                              {dex.name}
                            </span>
                            {isActive && (
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="ml-auto">
                                <path d="M3 7L6 10L11 4" stroke="#703AE6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            <button
              type="button"
              onClick={() => setIsSettingsOpen((prev) => !prev)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${
                isSettingsOpen
                  ? isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"
                  : isDark ? "hover:bg-[#2A2A2A]" : "hover:bg-[#F4F4F4]"
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6.5 2.5L7.2 1.2C7.3 1.1 7.5 1 7.6 1H8.4C8.5 1 8.7 1.1 8.8 1.2L9.5 2.5L11 3.1L12.3 2.7C12.5 2.6 12.7 2.7 12.8 2.8L13.4 3.4C13.5 3.5 13.6 3.7 13.5 3.9L13.1 5.2L13.7 6.7L15 7.4C15.1 7.5 15.2 7.7 15.2 7.8V8.6C15.2 8.7 15.1 8.9 15 9L13.7 9.7L13.1 11.2L13.5 12.5C13.6 12.7 13.5 12.9 13.4 13L12.8 13.6C12.7 13.7 12.5 13.8 12.3 13.7L11 13.3L9.5 13.9L8.8 15.2C8.7 15.3 8.5 15.4 8.4 15.4H7.6C7.5 15.4 7.3 15.3 7.2 15.2L6.5 13.9L5 13.3L3.7 13.7C3.5 13.8 3.3 13.7 3.2 13.6L2.6 13C2.5 12.9 2.4 12.7 2.5 12.5L2.9 11.2L2.3 9.7L1 9C0.9 8.9 0.8 8.7 0.8 8.6V7.8C0.8 7.7 0.9 7.5 1 7.4L2.3 6.7L2.9 5.2L2.5 3.9C2.4 3.7 2.5 3.5 2.6 3.4L3.2 2.8C3.3 2.7 3.5 2.6 3.7 2.7L5 3.1L6.5 2.5Z" stroke={isSettingsOpen ? "#703AE6" : isDark ? "#555555" : "#B0B0B0"} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <circle cx="8" cy="8.2" r="2.2" stroke={isSettingsOpen ? "#703AE6" : isDark ? "#555555" : "#B0B0B0"} strokeWidth="1.2" fill="none" />
              </svg>
            </button>
          </div>

          {/* From Token Input */}
          <SwapInput
            label="You Pay"
            token={tokenIn}
            amount={amountIn}
            amountUsd={null}
            balance={tokenInBalance}
            onTokenSelect={() => setTokenModalTarget("in")}
            onAmountChange={(val) => { setAmountIn(val); setActivePercent(null); setTxStatus("idle"); }}
            onMaxClick={handleMaxClick}
            showMax
            showPresets
            activePercent={activePercent}
            onPercentClick={handlePercentClick}
            showModeTabs={isAquarius || isSoroswap}
            swapMode={swapMode}
            onSwapModeChange={setSwapMode}
          />

          <SwapDirectionButton onClick={handleFlip} />

          {/* To Token Input */}
          <SwapInput
            label="You Receive"
            token={tokenOut}
            amount={amountOut}
            amountUsd={null}
            balance={tokenOutBalance}
            isReadOnly
            isLoading={isQuoteLoading}
            onTokenSelect={() => setTokenModalTarget("out")}
          />

          {/* Swap Details */}
          <div className="mt-2">
            <SwapDetails
              isVisible={hasQuote}
              isExpanded={isDetailsExpanded}
              onToggleExpand={() => setIsDetailsExpanded((prev) => !prev)}
              exchangeRate={exchangeRate}
              priceImpact={null}
              priceImpactLevel={null}
              slippage={slippageMode === "auto" ? "0.5" : slippage}
              minReceived={minReceived}
              fee="0.30%"
              networkCost={null}
              onRefreshRate={() => {}}
              isRefreshing={false}
              onEditSlippage={() => setIsSettingsOpen(true)}
            />
          </div>

          {/* No margin account warning (Aquarius margin mode) */}
          {isAquarius && swapMode === "margin" && isWalletConnected && !marginAccountAddress && (
            <div className={`mt-1 px-3 py-2 rounded-xl text-[12px] font-medium ${isDark ? "bg-yellow-500/10 text-yellow-400" : "bg-yellow-50 text-yellow-700"}`}>
              Margin account required. Create one in the Margin section.
            </div>
          )}

          {/* Swap CTA Button */}
          <div className="mt-2">
            <SwapButton
              state={buttonState}
              onClick={handleButtonClick}
              tokenSymbol={tokenIn?.symbol}
              isLoading={isActionLoading}
            />
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      <SwapSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        slippage={slippage}
        onSlippageChange={setSlippage}
        slippageMode={slippageMode}
        onSlippageModeChange={setSlippageMode}
        deadline={deadline}
        onDeadlineChange={setDeadline}
      />

      {/* Token Search Modal */}
      <TokenSearchModal
        isOpen={tokenModalTarget !== null}
        onClose={() => setTokenModalTarget(null)}
        onSelect={handleTokenSelect}
        tokens={tokenList}
        popularTokens={tokenList.slice(0, 5)}
        balances={tokenListBalances}
      />
    </>
  );
};
