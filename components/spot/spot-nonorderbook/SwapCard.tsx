"use client";

import { useTheme } from "@/contexts/theme-context";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { MarginAccountService } from "@/lib/margin-utils";
// refreshBorrowedBalances is called on connect to keep margin account address in sync
import { AquariusService, getAquariusSwapPartners, AquariusSwapSymbol } from "@/lib/aquarius-utils";
import { SoroswapService, getSoroswapSwapPartner, SoroswapSwapSymbol } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { normalizeContractError } from "@/lib/errors/normalize";
import { appendSpotHistory } from "@/lib/spot-history";
import { useTokenPrices } from "@/hooks/use-token-prices";
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
import {
  amountFromBalancePercent,
  capAmountToMaxBalance,
  getMaxSwappableBalance,
  parseTokenAmountToStroops,
} from "@/lib/utils/swap-amount";

// Stellar tokens supported for Aquarius swap. Two disjoint, confirmed-live
// pools: XLM<->USDC and WETH<->AQUA (no XLM<->WETH/AQUA pool exists).
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
  {
    id: CONTRACT_ADDRESSES.WETH_TOKEN,
    symbol: "WETH",
    name: "Wrapped Ether",
    logo: "/icons/eth-icon.png",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
  },
  {
    id: CONTRACT_ADDRESSES.AQUA_TOKEN,
    symbol: "AQUA",
    name: "Aquarius",
    logo: "/icons/aquarius-logo.png",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
  },
];

// Stellar tokens supported for Soroswap swap (uses on-chain contract
// addresses). Both non-XLM tokens hub through XLM: XLM<->USDC, XLM<->EURC.
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
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_EURC,
    symbol: "EURC",
    name: "Euro Coin",
    logo: "/icons/eurc.svg",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
  },
];

// Format a swap amount with adaptive precision (up to 7 decimals, trim trailing zeros).
// Matches how Aquarius/Soroswap display amounts (e.g. 0.6960407 instead of 0.70).
function formatSwapAmount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n.toFixed(7).replace(/\.?0+$/, "") || "0";
}

// Format a price/rate with adaptive precision. Smaller rates need more decimals
// to be meaningful (e.g. 0.0696041 USDC per XLM).
function formatSwapRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const decimals = n >= 1 ? 4 : n >= 0.01 ? 6 : 7;
  return n.toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

// Soroswap's non-XLM tokens (USDC, EURC) both hub through XLM — no direct
// USDC<->EURC pool exists. XLM and AQUA are both genuine hubs on Aquarius
// (each has more than one real on-chain partner — see getAquariusSwapPartners).
const SOROSWAP_PARTNERS: Record<string, string[]> = {
  XLM: ["USDC", "EURC"],
  USDC: ["XLM"],
  EURC: ["XLM"],
};

function swapPartnersFor(isAquarius: boolean, symbol: string): string[] {
  return isAquarius ? getAquariusSwapPartners(symbol) : (SOROSWAP_PARTNERS[symbol] ?? []);
}

/**
 * Resolves the correct swap-out token for a newly-selected swap-in token, so
 * the UI never lets a user land on a pair with no real on-chain pool. Both
 * DEXes now have genuine hub tokens with more than one valid partner (XLM
 * and AQUA on Aquarius; XLM on Soroswap) — when the fixed side has multiple
 * partners, keep whichever one was already selected if it's still valid,
 * instead of resetting to a fixed default.
 */
function resolveTokenOutForTokenIn(
  isAquarius: boolean,
  tokenList: Token[],
  tokenInSymbol: string,
  currentTokenOutSymbol?: string,
): Token | null {
  const partners = swapPartnersFor(isAquarius, tokenInSymbol);
  if (partners.length === 0) return null;
  if (currentTokenOutSymbol && partners.includes(currentTokenOutSymbol)) {
    return tokenList.find((t) => t.symbol === currentTokenOutSymbol) ?? null;
  }
  return tokenList.find((t) => t.symbol === partners[0]) ?? null;
}

/**
 * Tokens that actually have a real on-chain pool against `fixedSymbol` — used
 * to filter the token-search modal so a user picking the OTHER side only ever
 * sees choices that will actually work, instead of picking something with no
 * real route and having it silently snap to the actual partner.
 */
function getSwappablePartners(isAquarius: boolean, tokenList: Token[], fixedSymbol?: string): Token[] {
  if (!fixedSymbol) return tokenList;
  const partners = swapPartnersFor(isAquarius, fixedSymbol);
  return tokenList.filter((t) => partners.includes(t.symbol));
}

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
    parseTokenAmountToStroops(amountIn) > parseTokenAmountToStroops(tokenInBalance)
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

  // Live on-chain prices for the active pair, used for the per-input USD echo
  // and the click-to-swap conversion ratio chip. The hook canonicalises symbols
  // and refreshes every 30s; AqUSDC / SoUSDC alias to USDC inside oracle-price.ts.
  const swapTokenPrices = useTokenPrices(
    [tokenIn?.symbol, tokenOut?.symbol].filter((s): s is string => Boolean(s)),
  );
  const tokenInPrice = tokenIn ? swapTokenPrices[tokenIn.symbol.toUpperCase()] ?? 0 : 0;
  const tokenOutPrice = tokenOut ? swapTokenPrices[tokenOut.symbol.toUpperCase()] ?? 0 : 0;

  const formatUsd = (value: number): string =>
    value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const amountInUsd = useMemo(() => {
    const n = parseFloat(amountIn);
    if (!Number.isFinite(n) || n <= 0 || tokenInPrice <= 0) return null;
    return formatUsd(n * tokenInPrice);
  }, [amountIn, tokenInPrice]);

  const amountOutUsd = useMemo(() => {
    const n = parseFloat(amountOut);
    if (!Number.isFinite(n) || n <= 0 || tokenOutPrice <= 0) return null;
    return formatUsd(n * tokenOutPrice);
  }, [amountOut, tokenOutPrice]);

  // Click-to-flip direction for the displayed exchange-rate row.
  const [rateInverted, setRateInverted] = useState(false);
  const handleFlipRate = useCallback(() => setRateInverted((v) => !v), []);

  // Oracle-derived cross rate. We prefer this over the raw DEX quote ratio
  // because thin testnet liquidity can produce wildly off-fair rates
  // (e.g. "1 USDC = 0.62 XLM" when fair value is ~6.25 XLM). Falls back to
  // the quote-derived `exchangeRate` (set below) when oracle data is missing.
  const formatRate = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value >= 100) return value.toFixed(2);
    if (value >= 1) return value.toFixed(4);
    return value.toFixed(6);
  };

  const oracleExchangeRate = useMemo(() => {
    if (!tokenIn || !tokenOut) return null;
    if (tokenInPrice <= 0 || tokenOutPrice <= 0) return null;
    const rate = rateInverted
      ? tokenOutPrice / tokenInPrice
      : tokenInPrice / tokenOutPrice;
    const fromSymbol = rateInverted ? tokenOut.symbol : tokenIn.symbol;
    const toSymbol = rateInverted ? tokenIn.symbol : tokenOut.symbol;
    return `1 ${fromSymbol} = ${formatRate(rate)} ${toSymbol}`;
  }, [tokenIn, tokenOut, tokenInPrice, tokenOutPrice, rateInverted]);

  // Price impact = how far the executed swap rate diverges from oracle truth.
  //   impact_pct = (in_usd - out_usd) / in_usd * 100
  // A small positive number is normal (LP fee + tiny slippage).
  // Anything >3% is a red flag, >5% blocks the swap with a warning banner.
  const priceImpactInfo = useMemo<{
    pct: number | null;
    label: string | null;
    level: "low" | "medium" | "high" | null;
  }>(() => {
    const inUsd = parseFloat(amountIn) * tokenInPrice;
    const outUsd = parseFloat(amountOut) * tokenOutPrice;
    if (
      !Number.isFinite(inUsd) ||
      !Number.isFinite(outUsd) ||
      inUsd <= 0 ||
      outUsd <= 0
    ) {
      return { pct: null, label: null, level: null };
    }
    const pct = ((inUsd - outUsd) / inUsd) * 100;
    const level = pct < 1 ? "low" : pct < 3 ? "medium" : "high";
    const sign = pct >= 0 ? "-" : "+";
    return { pct, label: `${sign}${Math.abs(pct).toFixed(2)}%`, level };
  }, [amountIn, amountOut, tokenInPrice, tokenOutPrice]);

  const isHighPriceImpact =
    priceImpactInfo.pct !== null && priceImpactInfo.pct > 5;

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
    const first = list[0] ?? null;
    setTokenIn(first);
    setTokenOut(
      first && selectedDex !== "aquarius" && selectedDex !== "soroswap"
        ? list[1] ?? null
        : first
          ? resolveTokenOutForTokenIn(selectedDex === "aquarius", list, first.symbol)
          : null,
    );
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
  // Actual token balances held by the margin account contract (updated after
  // swap), keyed by symbol — generic over whichever tokens the active DEX's
  // token list has (XLM/USDC, WETH/AQUA for Aquarius; XLM/USDC/EURC for Soroswap).
  const [aquariusMarginBalances, setAquariusMarginBalances] = useState<Record<string, string>>({});

  // Soroswap wallet + margin balances
  const [soroswapUsdcWalletBalance, setSoroswapUsdcWalletBalance] = useState("0");
  const [soroswapMarginBalances, setSoroswapMarginBalances] = useState<Record<string, string>>({});

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

  // Fetch actual token balances held by the margin account contract, for
  // every token in Aquarius's swap list (XLM, USDC, WETH, AQUA). These update
  // after every swap since borrowedBalances tracks lending debt (not swapped holdings).
  useEffect(() => {
    if (!isAquarius || !marginAccountAddress || swapMode !== "margin") return;
    let cancelled = false;
    Promise.all(
      STELLAR_TOKENS.map((t) =>
        AquariusService.getMarginAccountTokenBalance(marginAccountAddress, t.symbol as AquariusSwapSymbol)
          .then((bal) => [t.symbol, bal] as const)
      )
    ).then((entries) => {
      if (!cancelled) setAquariusMarginBalances(Object.fromEntries(entries));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isAquarius, marginAccountAddress, swapMode, txHash]);

  // Fetch Soroswap margin account token balances (XLM, USDC, EURC).
  useEffect(() => {
    if (!isSoroswap || !marginAccountAddress || swapMode !== "margin") return;
    let cancelled = false;
    Promise.all(
      SOROSWAP_STELLAR_TOKENS.map((t) =>
        SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, t.symbol as SoroswapSwapSymbol)
          .then((bal) => [t.symbol, bal] as const)
      )
    ).then((entries) => {
      if (!cancelled) setSoroswapMarginBalances(Object.fromEntries(entries));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isSoroswap, marginAccountAddress, swapMode, txHash]);

  // Balances for MAX / % — floor from on-chain precision (7 decimals), never round up.
  const getBalance = useCallback((token: Token | null): string | null => {
    if (!isWalletConnected || !token) return null;
    if (isAquarius) {
      if (swapMode === "wallet") {
        if (token.symbol === "XLM") {
          const xlm = parseFloat(walletXlmBalance || "0");
          return getMaxSwappableBalance(formatSwapAmount(Math.max(0, xlm - 1)));
        }
        // Wallet-mode swaps are currently unreachable (swapMode is locked to
        // "margin" in the UI) — only USDC has a dedicated wallet-balance
        // fetch; WETH/AQUA fall back to "0" until that mode is re-enabled.
        return getMaxSwappableBalance(aquariusUsdcWalletBalance || "0");
      }
      return getMaxSwappableBalance(aquariusMarginBalances[token.symbol] || "0");
    }
    if (isSoroswap) {
      if (swapMode === "wallet") {
        if (token.symbol === "XLM") {
          const xlm = parseFloat(walletXlmBalance || "0");
          return getMaxSwappableBalance(formatSwapAmount(Math.max(0, xlm - 1)));
        }
        return getMaxSwappableBalance(soroswapUsdcWalletBalance || "0");
      }
      return getMaxSwappableBalance(soroswapMarginBalances[token.symbol] || "0");
    }
    return null;
  }, [isWalletConnected, isAquarius, isSoroswap, swapMode, walletXlmBalance, aquariusUsdcWalletBalance, aquariusMarginBalances, soroswapUsdcWalletBalance, soroswapMarginBalances]);

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

  // What the token-search modal should actually offer for whichever side is
  // being picked — filtered to on-chain-real partners of the OTHER side, so
  // the user never picks something that would just get silently overridden.
  const modalTokens = useMemo(() => {
    if (tokenModalTarget === "in") return getSwappablePartners(isAquarius, tokenList, tokenOut?.symbol);
    if (tokenModalTarget === "out") return getSwappablePartners(isAquarius, tokenList, tokenIn?.symbol);
    return tokenList;
  }, [tokenModalTarget, isAquarius, tokenList, tokenIn?.symbol, tokenOut?.symbol]);

  // Preset % state
  const [activePercent, setActivePercent] = useState<number | null>(null);

  const handlePercentClick = useCallback((pct: number) => {
    setActivePercent(pct);
    // getBalance(tokenIn) (== tokenInBalance) already covers wallet vs margin
    // mode and every token in both DEXes' lists — no need to re-derive it here.
    const rawBal = tokenInBalance;
    if (!rawBal || parseTokenAmountToStroops(rawBal) <= BigInt(0)) return;
    setAmountIn(amountFromBalancePercent(rawBal, pct));
    setTxStatus("idle");
  }, [tokenInBalance]);

  // Debounce window for quote fetches. Each Soroban simulateTransaction round
  // trip costs ~1–3s on testnet, so firing on every keystroke creates a queue
  // of 5–10 in-flight RPC calls for a single typed amount. Wait until the user
  // pauses for `QUOTE_DEBOUNCE_MS` before asking the DEX.
  const QUOTE_DEBOUNCE_MS = 400;

  // Auto-fetch quote when amountIn changes (Aquarius only)
  useEffect(() => {
    if (!isAquarius || !tokenIn || !tokenOut || !amountIn || parseFloat(amountIn) <= 0 || !userAddress) {
      if (isAquarius) { setAmountOut(""); setExchangeRate(null); setIsQuoteLoading(false); }
      return;
    }
    let cancelled = false;
    // Show the loading affordance immediately so the UI feels responsive even
    // though the actual fetch is delayed by the debounce window.
    setIsQuoteLoading(true);
    AquariusService.getSwapQuote(
      parseFloat(amountIn),
      tokenIn.symbol as AquariusSwapSymbol,
      userAddress,
      tokenOut.symbol as AquariusSwapSymbol,
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
  }, [amountIn, tokenIn?.id, tokenOut?.id, isAquarius, userAddress]);

  // Auto-fetch quote when amountIn changes (Soroswap)
  useEffect(() => {
    if (!isSoroswap || !tokenIn || !tokenOut || !amountIn || parseFloat(amountIn) <= 0 || !userAddress) {
      if (isSoroswap) { setAmountOut(""); setExchangeRate(null); setIsQuoteLoading(false); }
      return;
    }
    let cancelled = false;
    setIsQuoteLoading(true);
    const timer = setTimeout(() => {
      if (cancelled) return;
      SoroswapService.getSwapQuote(
        parseFloat(amountIn),
        tokenIn.symbol as SoroswapSwapSymbol,
        userAddress,
        tokenOut.symbol as SoroswapSwapSymbol,
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
    }, QUOTE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [amountIn, tokenIn?.id, tokenOut?.id, isSoroswap, userAddress]);

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
    // Snap the OTHER side to a real on-chain partner for the newly-picked
    // token, rather than blindly swapping the two prior selections — Aquarius
    // now has two disjoint pairs (XLM<->USDC, WETH<->AQUA), so picking WETH
    // while USDC was the other side must reset the other side to AQUA, not
    // leave an XLM+WETH combo with no pool.
    if (tokenModalTarget === "in") {
      setTokenIn(token);
      setTokenOut(resolveTokenOutForTokenIn(isAquarius, tokenList, token.symbol, tokenOut?.symbol));
    } else {
      setTokenOut(token);
      setTokenIn(resolveTokenOutForTokenIn(isAquarius, tokenList, token.symbol, tokenIn?.symbol));
    }
    setAmountIn("");
    setAmountOut("");
    setTokenModalTarget(null);
  }, [tokenModalTarget, tokenIn, tokenOut, isAquarius, tokenList]);

  const handleMaxClick = useCallback(() => {
    if (tokenInBalance) setAmountIn(tokenInBalance.replace(/,/g, ""));
  }, [tokenInBalance]);

  const qc = useQueryClient();

  const swapMutation = useMutation({
    mutationFn: async () => {
      const slippageVal = slippageMode === "auto" ? 0.5 : parseFloat(slippage);
      const requestedAmountIn = parseFloat(amountIn);
      const amountInToUse =
        tokenInBalance !== null
          ? capAmountToMaxBalance(requestedAmountIn, tokenInBalance)
          : requestedAmountIn;
      if (!Number.isFinite(amountInToUse) || amountInToUse <= 0) {
        throw new Error("Invalid amount");
      }

      let result: { success: boolean; hash?: string; error?: string };

      if (isAquarius) {
        if (swapMode === "wallet") {
          result = await AquariusService.aquariusSwap(
            userAddress!,
            marginAccountAddress ?? "",
            tokenIn!.symbol as AquariusSwapSymbol,
            amountInToUse,
            slippageVal,
            tokenOut!.symbol as AquariusSwapSymbol,
          );
        } else {
          result = await AquariusService.aquariusSwapFromMargin(
            userAddress!,
            marginAccountAddress!,
            tokenIn!.symbol as AquariusSwapSymbol,
            amountInToUse,
            tokenOut!.symbol as AquariusSwapSymbol,
          );
        }
      } else {
        if (swapMode === "wallet") {
          result = await SoroswapService.swap(
            userAddress!,
            tokenIn!.symbol as SoroswapSwapSymbol,
            amountInToUse,
            slippageVal,
            tokenOut!.symbol as SoroswapSwapSymbol,
          );
        } else {
          result = await SoroswapService.swapFromMargin(
            userAddress!,
            marginAccountAddress!,
            tokenIn!.symbol as SoroswapSwapSymbol,
            amountInToUse,
            tokenOut!.symbol as SoroswapSwapSymbol,
          );
        }
      }

      if (!result.success) {
        throw new Error(result.error ?? "Swap failed");
      }
      return {
        ...result,
        dexProtocol: (isAquarius ? "aquarius" : "soroswap") as "aquarius" | "soroswap",
        tokenInSymbol: tokenIn!.symbol,
        tokenOutSymbol: tokenOut!.symbol,
        amountInUsed: amountInToUse,
        amountOutAtSubmit: amountOut,
      };
    },
    onMutate: () => {
      setTxStatus("loading");
      setTxError("");
      setTxHash("");
    },
    onSuccess: (result) => {
      setTxStatus("success");
      setTxHash(result.hash ?? "");
      toast.success(`Swap submitted! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
      // Spot swaps always route through the margin account (swapMode is
      // locked to "margin" — see the showModeTabs comment below), so its
      // history is scoped to marginAccountAddress like Farm/Lender history.
      if (swapMode === "margin" && marginAccountAddress) {
        appendSpotHistory({
          protocol: result.dexProtocol,
          marginAccountAddress,
          tokenIn: result.tokenInSymbol,
          tokenOut: result.tokenOutSymbol,
          amountIn: result.amountInUsed.toFixed(7),
          amountOut: result.amountOutAtSubmit || "0",
          txHash: result.hash ?? "",
        });
      }
      setAmountIn("");
      setAmountOut("");
      if (marginAccountAddress) refreshBorrowedBalances(marginAccountAddress, true);
      qc.invalidateQueries({ queryKey: ['margin'] });
      qc.invalidateQueries({ queryKey: ['earn'] });
      qc.invalidateQueries({ queryKey: ['spot'] });
      // Spot Balances (Portfolio's spot-section.tsx) reads live per-venue
      // balances under these two separate query-key prefixes, not ['spot'] —
      // without this they only refreshed on the next ledger tick, showing
      // stale amounts right after a swap.
      qc.invalidateQueries({ queryKey: ['soroswap', 'tokenBalance'] });
      qc.invalidateQueries({ queryKey: ['farm', 'aquarius', 'tokenBalance'] });
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Swap failed");
      setTxError(errorMsg);
      toast.error(errorMsg);
    },
  });

  const handleButtonClick = useCallback(() => {
    if (buttonState !== "ready") return;
    if (!userAddress || !tokenIn) return;
    if (swapMode === "margin" && !marginAccountAddress) return;
    if (!isAquarius && !isSoroswap) return;
    swapMutation.mutate();
  }, [buttonState, isAquarius, isSoroswap, swapMode, userAddress, marginAccountAddress, tokenIn, swapMutation]);

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
            amountUsd={amountInUsd}
            balance={tokenInBalance}
            onTokenSelect={() => setTokenModalTarget("in")}
            onAmountChange={(val) => { setAmountIn(val); setActivePercent(null); setTxStatus("idle"); }}
            onMaxClick={handleMaxClick}
            showMax
            showPresets
            activePercent={activePercent}
            onPercentClick={handlePercentClick}
            // WB/MB tabs hidden — spot swaps always go through the margin
            // account (wallet-balance path was redundant), so locking
            // swapMode to "margin" keeps the underlying flow correct
            // without exposing the toggle.
            showModeTabs={false}
            swapMode={swapMode}
            onSwapModeChange={setSwapMode}
          />

          <SwapDirectionButton onClick={handleFlip} />

          {/* To Token Input */}
          <SwapInput
            label="You Receive"
            token={tokenOut}
            amount={amountOut}
            amountUsd={amountOutUsd}
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
              exchangeRate={oracleExchangeRate ?? exchangeRate}
              onFlipRate={oracleExchangeRate ? handleFlipRate : undefined}
              quoteRate={oracleExchangeRate && exchangeRate ? exchangeRate : null}
              priceImpact={priceImpactInfo.label}
              priceImpactLevel={priceImpactInfo.level}
              slippage={slippageMode === "auto" ? "0.5" : slippage}
              minReceived={minReceived}
              fee="0.30%"
              networkCost={null}
              onRefreshRate={() => {}}
              isRefreshing={false}
              onEditSlippage={() => setIsSettingsOpen(true)}
            />
          </div>

          {/* High price-impact warning banner — visible when the executed
              quote diverges materially from the oracle (e.g. thin pool). */}
          {isHighPriceImpact && (
            <div
              className={`mt-2 px-3 py-2 rounded-xl text-[12px] font-semibold flex items-start gap-2 ${
                isDark ? "bg-[#FC5457]/10 text-[#FC5457] border border-[#FC5457]/30" : "bg-[#FFF1F1] text-[#C62525] border border-[#FFB3B3]"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0 mt-0.5">
                <path d="M7 1.5L13 12.5H1L7 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="M7 5.5V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <circle cx="7" cy="10" r="0.7" fill="currentColor" />
              </svg>
              <span>
                High price impact{priceImpactInfo.label ? ` (${priceImpactInfo.label})` : ""}.
                You'll receive far less than fair value  this pool's liquidity is too thin
                for this trade size. Reduce the amount or pick another DEX.
              </span>
            </div>
          )}

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
        tokens={modalTokens}
        popularTokens={modalTokens.slice(0, 5)}
        balances={tokenListBalances}
      />
    </>
  );
};
