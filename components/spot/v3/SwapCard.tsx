"use client";

/**
 * The Spot swap card (V3 design, Stellar data): swaps collateral inside the margin account through
 * the picked DEX (Soroswap / Aquarius), with percent chips, quote details, a route card, the
 * "after this swap" health factor and the safety floor.
 *
 * Every number and every transaction goes through the same services the previous Stellar swap card
 * used (SoroswapService / AquariusService quotes, swapFromMargin / aquariusSwapFromMargin execution,
 * margin-account token balances read straight from the token contracts). Only the UI changed.
 */
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { MarginAccountService } from "@/lib/margin-utils";
// refreshBorrowedBalances is called on connect to keep margin account address in sync
import { AquariusService, getAquariusSwapPartners, type AquariusSwapSymbol } from "@/lib/aquarius-utils";
import { SoroswapService, type SoroswapSwapSymbol } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { normalizeContractError } from "@/lib/errors/normalize";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useV3Account } from "@/hooks/use-v3-account";
import { OPEN_CONNECT_WALLET_EVENT } from "@/lib/assistant/client-tools";
import { LIQ_HF, SAFE_HF, WARN_HF, accountNumbers, hfZone } from "@/lib/account-model";
import { IC, Icon, VMark } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { hfFmt, nf } from "@/components/v3/format";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import {
  amountFromBalancePercent,
  capAmountToMaxBalance,
  getMaxSwappableBalance,
  parseTokenAmountToStroops,
} from "@/lib/utils/swap-amount";
import { SwapSettingsModal, TokenPickerModal, AUTO_SLIPPAGE_PERCENT } from "./swap-modals";
import { withSwap, type SwapPreview } from "./swap-model";
import type { Token } from "../spot-nonorderbook/types";

type DexId = "soroswap" | "aquarius";
type SwapMode = "wallet" | "margin";

/** Stellar token on a DEX, plus the margin store key its collateral line lives under. */
type SwapToken = Token & { modelSymbol: string };

// Stellar tokens supported for Aquarius swap. A single confirmed-live pool:
// XLM<->USDC.
const STELLAR_TOKENS: SwapToken[] = [
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_XLM,
    symbol: "XLM",
    name: "Stellar Lumens",
    logo: "/coins/xlm.png",
    decimals: 7,
    chain: "stellar",
    isNative: true,
    isVerified: true,
    modelSymbol: "XLM",
  },
  {
    id: CONTRACT_ADDRESSES.AQUARIUS_USDC,
    symbol: "USDC",
    displaySymbol: "AqUSDC",
    name: "USD Coin (Aquarius)",
    logo: "/coins/usdc.svg",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
    modelSymbol: "AQUSDC",
  },
];

// Stellar tokens supported for Soroswap swap (uses on-chain contract
// addresses). A single pool: XLM<->USDC.
const SOROSWAP_STELLAR_TOKENS: SwapToken[] = [
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_XLM,
    symbol: "XLM",
    name: "Stellar Lumens",
    logo: "/coins/xlm.png",
    decimals: 7,
    chain: "stellar",
    isNative: true,
    isVerified: true,
    modelSymbol: "XLM",
  },
  {
    id: CONTRACT_ADDRESSES.SOROSWAP_USDC,
    symbol: "USDC",
    displaySymbol: "SoUSDC",
    name: "USD Coin (Soroswap)",
    logo: "/icons/usdc-icon.svg",
    decimals: 7,
    chain: "stellar",
    isVerified: true,
    modelSymbol: "SOUSDC",
  },
];

/** The DEXes the user can pick in the header dropdown; quote and swap both go through the picked one. */
const DEXES: { id: DexId; label: string; sym: string; hint: string }[] = [
  { id: "soroswap", label: "Soroswap", sym: "SOROSWAP", hint: "Soroswap XLM / SoUSDC pool" },
  { id: "aquarius", label: "Aquarius", sym: "AQUARIUS", hint: "Aquarius XLM / AqUSDC pool" },
];

const tokensFor = (dex: DexId): SwapToken[] => (dex === "aquarius" ? STELLAR_TOKENS : SOROSWAP_STELLAR_TOKENS);

// Display symbol (e.g. "AqUSDC"/"SoUSDC" instead of the functional "USDC"
// every AquariusService/SoroswapService call, price lookup, and partner map
// in this file keys off). Only ever use it for display — state and service
// calls must keep using the real token symbol.
function displaySymbolOf(t: Token | null | undefined): string {
  return t ? t.displaySymbol ?? t.symbol : "";
}
/** Presentational copy of a token with `symbol` swapped for its display symbol (for the picker). */
function toDisplayToken(t: Token): Token {
  return { ...t, symbol: t.displaySymbol ?? t.symbol };
}

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
  const decimals = n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 7;
  return n.toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

// Soroswap supports a single pair: XLM<->USDC.
const SOROSWAP_PARTNERS: Record<string, string[]> = {
  XLM: ["USDC"],
  USDC: ["XLM"],
};

function swapPartnersFor(isAquarius: boolean, symbol: string): string[] {
  return isAquarius ? getAquariusSwapPartners(symbol) : (SOROSWAP_PARTNERS[symbol] ?? []);
}

/**
 * Resolves the correct swap-out token for a newly-selected swap-in token, so
 * the UI never lets a user land on a pair with no real on-chain pool. Both
 * DEXes currently support a single pair (XLM<->USDC) — when the fixed side
 * has multiple partners, keep whichever one was already selected if it's
 * still valid, instead of resetting to a fixed default.
 */
function resolveTokenOutForTokenIn(
  isAquarius: boolean,
  tokenList: SwapToken[],
  tokenInSymbol: string,
  currentTokenOutSymbol?: string,
): SwapToken | null {
  const partners = swapPartnersFor(isAquarius, tokenInSymbol);
  if (partners.length === 0) return null;
  if (currentTokenOutSymbol && partners.includes(currentTokenOutSymbol)) {
    return tokenList.find((t) => t.symbol === currentTokenOutSymbol) ?? null;
  }
  return tokenList.find((t) => t.symbol === partners[0]) ?? null;
}

/**
 * Tokens that actually have a real on-chain pool against `fixedSymbol` — used
 * to filter the token picker so a user picking the OTHER side only ever sees
 * choices that will actually work, instead of picking something with no real
 * route and having it silently snap to the actual partner.
 */
function getSwappablePartners(isAquarius: boolean, tokenList: SwapToken[], fixedSymbol?: string): SwapToken[] {
  if (!fixedSymbol) return tokenList;
  const partners = swapPartnersFor(isAquarius, fixedSymbol);
  return tokenList.filter((t) => partners.includes(t.symbol));
}

// Debounce window for quote fetches. Each Soroban simulateTransaction round
// trip costs ~1–3s on testnet, so firing on every keystroke creates a queue
// of 5–10 in-flight RPC calls for a single typed amount. Wait until the user
// pauses for `QUOTE_DEBOUNCE_MS` before asking the DEX.
const QUOTE_DEBOUNCE_MS = 400;

type ButtonState =
  | "connect_wallet"
  | "select_token"
  | "enter_amount"
  | "loading_quote"
  | "no_margin_account"
  | "insufficient_balance"
  | "no_route"
  | "disabled"
  | "ready";

interface SwapCardProps {
  baseSymbol?: string;
  /** Called with the pair and the quoted values, so the page's account panel can show "now → after". */
  onPreview?: (p: SwapPreview) => void;
}

export const SwapCard = ({ baseSymbol, onPreview }: SwapCardProps) => {
  // DEX picked in the header dropdown (quote + execution both go through it). Soroswap is the default, as before.
  const [dex, setDex] = useState<DexId>("soroswap");
  const isAquarius = dex === "aquarius";
  const isSoroswap = dex === "soroswap";
  const tokenList = tokensFor(dex);
  const [isDexMenuOpen, setIsDexMenuOpen] = useState(false);
  const dexMenuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!isDexMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!dexMenuRef.current?.contains(e.target as Node)) setIsDexMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [isDexMenuOpen]);

  const initialToken = baseSymbol
    ? tokenList.find((t) => t.symbol.toLowerCase() === baseSymbol.toLowerCase()) ?? tokenList[0]
    : tokenList[0];

  // Token state
  const [tokenIn, setTokenIn] = useState<SwapToken | null>(initialToken);
  const [tokenOut, setTokenOut] = useState<SwapToken | null>(
    resolveTokenOutForTokenIn(isAquarius, tokenList, initialToken.symbol),
  );

  // Amount state (amountOut is the live quote)
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  // Preset % state
  const [activePercent, setActivePercent] = useState<number | null>(null);

  // Swaps always run inside the margin account (health-checked on-chain by the
  // AccountManager after the swap). WB/MB tabs stay hidden — the wallet-mode
  // path below is kept but not exposed in the UI.
  const swapMode = "margin" as SwapMode;

  // Settings state
  const [slippage, setSlippage] = useState(AUTO_SLIPPAGE_PERCENT);
  const [slippageMode, setSlippageMode] = useState<"auto" | "custom">("auto");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const slippagePercent = slippageMode === "auto" ? AUTO_SLIPPAGE_PERCENT : slippage;

  // Modal state
  const [tokenModalTarget, setTokenModalTarget] = useState<"in" | "out" | null>(null);
  // Quote details open/closed; null = follow the default (open when the swap changes the health factor).
  const [isDetailsExpanded, setIsDetailsExpanded] = useState<boolean | null>(null);

  // Swap tx state
  const [txHash, setTxHash] = useState("");
  const [txError, setTxError] = useState("");

  // Wallet + margin account
  const userAddress = useUserStore((s) => s.address);
  const walletXlmBalance = useUserStore((s) => s.balance);
  const isWalletConnected = Boolean(userAddress);
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  // RiskEngine-exact account model (same health factor as every V3 page).
  const { state: modelState } = useV3Account();

  // Reset tokens and amounts when the DEX changes
  const handleDexChange = useCallback((next: DexId) => {
    const list = tokensFor(next);
    const first = list[0] ?? null;
    setDex(next);
    setTokenIn(first);
    setTokenOut(first ? resolveTokenOutForTokenIn(next === "aquarius", list, first.symbol) : null);
    setAmountIn("");
    setAmountOut("");
    setActivePercent(null);
    setTxHash("");
    setTxError("");
  }, []);

  // Live on-chain prices for the active pair, used for the per-input USD echo,
  // the oracle exchange rate, price impact and the health-factor projection.
  // The hook canonicalises symbols and refreshes every 30s; AqUSDC / SoUSDC
  // alias to USDC inside oracle-price.ts.
  const swapTokenPrices = useTokenPrices(
    [tokenIn?.symbol, tokenOut?.symbol].filter((s): s is string => Boolean(s)),
  );
  const tokenInPrice = tokenIn ? swapTokenPrices[tokenIn.symbol.toUpperCase()] ?? 0 : 0;
  const tokenOutPrice = tokenOut ? swapTokenPrices[tokenOut.symbol.toUpperCase()] ?? 0 : 0;

  // ---------------------------------------------------------------------------------------------
  // Balances. Margin mode: the tokens the margin account contract actually holds (read from the
  // token contracts, updated after every swap — borrowedBalances tracks lending debt, not swapped
  // holdings). Wallet mode (not exposed): wallet XLM minus the 1 XLM reserve, USDC via the DEX.
  // ---------------------------------------------------------------------------------------------
  const [walletUsdcBalance, setWalletUsdcBalance] = useState("0");
  const [marginBalances, setMarginBalances] = useState<Record<string, string>>({});
  const [balanceNonce, setBalanceNonce] = useState(0);

  // Load margin account address when wallet connects
  useEffect(() => {
    if (!userAddress) return;
    const stored = MarginAccountService.getStoredMarginAccount(userAddress);
    if (stored?.address) refreshBorrowedBalances(stored.address);
  }, [userAddress]);

  // Wallet USDC balance on the active DEX (only used by the hidden wallet mode).
  useEffect(() => {
    if (swapMode !== "wallet" || !userAddress) {
      setWalletUsdcBalance("0");
      return;
    }
    let cancelled = false;
    const read = isAquarius
      ? AquariusService.getAquariusUsdcWalletBalance(userAddress)
      : SoroswapService.getMarginAccountTokenBalance(userAddress, "USDC");
    read
      .then((bal) => {
        if (!cancelled) setWalletUsdcBalance(bal);
      })
      .catch(() => {
        if (!cancelled) setWalletUsdcBalance("0");
      });
    return () => {
      cancelled = true;
    };
  }, [swapMode, isAquarius, userAddress, balanceNonce]);

  // Margin-account token balances for every token in the active DEX's list (XLM, USDC).
  useEffect(() => {
    if (!marginAccountAddress || swapMode !== "margin") {
      setMarginBalances({});
      return;
    }
    let cancelled = false;
    const list = tokensFor(dex);
    Promise.all(
      list.map((t) =>
        (dex === "aquarius"
          ? AquariusService.getMarginAccountTokenBalance(marginAccountAddress, t.symbol as AquariusSwapSymbol)
          : SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, t.symbol as SoroswapSwapSymbol)
        ).then((bal) => [t.symbol, bal] as const),
      ),
    )
      .then((entries) => {
        if (!cancelled) setMarginBalances(Object.fromEntries(entries));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dex, marginAccountAddress, swapMode, balanceNonce]);

  // Balances for MAX / % — floor from on-chain precision (7 decimals), never round up.
  const getBalance = useCallback(
    (token: Token | null): string | null => {
      if (!isWalletConnected || !token) return null;
      if (swapMode === "wallet") {
        if (token.symbol === "XLM") {
          const xlm = parseFloat(walletXlmBalance || "0");
          return getMaxSwappableBalance(formatSwapAmount(Math.max(0, xlm - 1)));
        }
        return getMaxSwappableBalance(walletUsdcBalance || "0");
      }
      return getMaxSwappableBalance(marginBalances[token.symbol] || "0");
    },
    [isWalletConnected, swapMode, walletXlmBalance, walletUsdcBalance, marginBalances],
  );

  const tokenInBalance = getBalance(tokenIn);
  const tokenOutBalance = getBalance(tokenOut);

  const tokenListBalances = useMemo(() => {
    const map: Record<string, string> = {};
    tokenList.forEach((t) => {
      const b = getBalance(t);
      if (b !== null) map[t.id] = (parseFloat(b) || 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
    });
    return map;
  }, [tokenList, getBalance]);

  // What the token picker should actually offer for whichever side is being
  // picked — filtered to on-chain-real partners of the OTHER side, so the user
  // never picks something that would just get silently overridden.
  const modalTokens = useMemo(() => {
    if (tokenModalTarget === "in") return getSwappablePartners(isAquarius, tokenList, tokenOut?.symbol);
    if (tokenModalTarget === "out") return getSwappablePartners(isAquarius, tokenList, tokenIn?.symbol);
    return tokenList;
  }, [tokenModalTarget, isAquarius, tokenList, tokenIn?.symbol, tokenOut?.symbol]);

  // ---------------------------------------------------------------------------------------------
  // Quote (debounced) from the active DEX: Soroswap router_get_amounts_out / Aquarius router
  // estimate. Both services return null when the pool can't quote the amount.
  // ---------------------------------------------------------------------------------------------
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    setQuoteError(null);
    if (!tokenIn || !tokenOut || !amountIn || !(parseFloat(amountIn) > 0) || !userAddress) {
      setAmountOut("");
      setIsQuoteLoading(false);
      return;
    }
    let cancelled = false;
    // Show the loading affordance immediately so the UI feels responsive even
    // though the actual fetch is delayed by the debounce window.
    setIsQuoteLoading(true);
    setAmountOut("");
    const timer = setTimeout(() => {
      if (cancelled) return;
      const amt = parseFloat(amountIn);
      const request = isAquarius
        ? AquariusService.getSwapQuote(amt, tokenIn.symbol as AquariusSwapSymbol, userAddress, tokenOut.symbol as AquariusSwapSymbol)
        : SoroswapService.getSwapQuote(amt, tokenIn.symbol as SoroswapSwapSymbol, userAddress, tokenOut.symbol as SoroswapSwapSymbol);
      request
        .then((quote) => {
          if (cancelled) return;
          if (quote && parseFloat(quote) > 0) {
            setAmountOut(formatSwapAmount(parseFloat(quote)));
          } else {
            setAmountOut("");
            setQuoteError("no_route");
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setAmountOut("");
          setQuoteError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setIsQuoteLoading(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Keyed on primitives (token ids) to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, tokenIn?.id, tokenOut?.id, isAquarius, userAddress, refreshNonce]);

  // ---------------------------------------------------------------------------------------------
  // Quote-derived display values
  // ---------------------------------------------------------------------------------------------
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
  // the quote-derived rate when oracle data is missing.
  const oracleExchangeRate = useMemo(() => {
    if (!tokenIn || !tokenOut || tokenInPrice <= 0 || tokenOutPrice <= 0) return null;
    const rate = rateInverted ? tokenOutPrice / tokenInPrice : tokenInPrice / tokenOutPrice;
    const fromSymbol = rateInverted ? displaySymbolOf(tokenOut) : displaySymbolOf(tokenIn);
    const toSymbol = rateInverted ? displaySymbolOf(tokenIn) : displaySymbolOf(tokenOut);
    return `1 ${fromSymbol} = ${formatSwapRate(rate)} ${toSymbol}`;
  }, [tokenIn, tokenOut, tokenInPrice, tokenOutPrice, rateInverted]);
  // The pool's own rate from the quote (shown beside the oracle rate in the details).
  const quoteExchangeRate = useMemo(() => {
    const inN = parseFloat(amountIn);
    const outN = parseFloat(amountOut);
    if (!tokenIn || !tokenOut || !(inN > 0) || !(outN > 0)) return null;
    return rateInverted
      ? `1 ${displaySymbolOf(tokenOut)} = ${formatSwapRate(inN / outN)} ${displaySymbolOf(tokenIn)}`
      : `1 ${displaySymbolOf(tokenIn)} = ${formatSwapRate(outN / inN)} ${displaySymbolOf(tokenOut)}`;
  }, [amountIn, amountOut, tokenIn, tokenOut, rateInverted]);
  const exchangeRate = oracleExchangeRate ?? quoteExchangeRate;

  // Price impact = how far the executed swap rate diverges from oracle truth.
  //   impact_pct = (in_usd - out_usd) / in_usd * 100
  // A small positive number is normal (LP fee + tiny slippage).
  // Anything >3% is a red flag, >5% shows a warning banner.
  const priceImpactInfo = useMemo<{ pct: number | null; label: string | null; level: "low" | "medium" | "high" | null }>(() => {
    const inUsd = parseFloat(amountIn) * tokenInPrice;
    const outUsd = parseFloat(amountOut) * tokenOutPrice;
    if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0 || outUsd <= 0) {
      return { pct: null, label: null, level: null };
    }
    const pct = ((inUsd - outUsd) / inUsd) * 100;
    const level = pct < 1 ? "low" : pct < 3 ? "medium" : "high";
    const sign = pct >= 0 ? "-" : "+";
    return { pct, label: `${sign}${Math.abs(pct).toFixed(2)}%`, level };
  }, [amountIn, amountOut, tokenInPrice, tokenOutPrice]);
  const isHighPriceImpact = priceImpactInfo.pct !== null && priceImpactInfo.pct > 5;

  const minReceived =
    amountOut && tokenOut
      ? `${formatSwapAmount(parseFloat(amountOut) * (1 - (parseFloat(slippagePercent) || 0) / 100))} ${displaySymbolOf(tokenOut)}`
      : null;

  // Project the post-swap health factor for margin-mode swaps on the account model: the paid
  // token's collateral line falls by its USD value, the received one rises by the quote's, debt is
  // unchanged. Blocked below SAFE_HF (when it lowers the HF), amber below WARN_HF.
  const quoteUsd = useMemo(() => {
    const inN = parseFloat(amountIn);
    const outN = parseFloat(amountOut);
    if (!(inN > 0) || !(outN > 0) || !(tokenInPrice > 0) || !(tokenOutPrice > 0)) return null;
    return { inUsd: inN * tokenInPrice, outUsd: outN * tokenOutPrice };
  }, [amountIn, amountOut, tokenInPrice, tokenOutPrice]);
  const futureHealthFactor = useMemo<{ before: number; after: number; blocked: boolean; amber: boolean } | null>(() => {
    if (swapMode !== "margin" || !marginAccountAddress || !modelState || !quoteUsd || !tokenIn || !tokenOut) return null;
    const before = withSwap(modelState, tokenIn.modelSymbol, 0, tokenOut.modelSymbol, 0);
    const after = withSwap(modelState, tokenIn.modelSymbol, quoteUsd.inUsd, tokenOut.modelSymbol, quoteUsd.outUsd);
    const h0 = accountNumbers(before).hf;
    const h1 = accountNumbers(after).hf;
    if (!Number.isFinite(h0) && !Number.isFinite(h1)) return null; // no liquidation risk without debt
    const lowers = h1 < h0 - 1e-9;
    const blocked = lowers && h1 < SAFE_HF;
    return { before: h0, after: h1, blocked, amber: !blocked && lowers && h1 < WARN_HF };
  }, [swapMode, marginAccountAddress, modelState, quoteUsd, tokenIn, tokenOut]);

  // Tell the page what is about to happen (pair + quoted USD), for its account panel.
  const fromAmount = parseFloat(tokenInBalance ?? "0") || 0;
  useEffect(() => {
    if (!onPreview || !tokenIn || !tokenOut) return;
    onPreview({
      from: tokenIn.modelSymbol,
      to: tokenOut.modelSymbol,
      inUsd: quoteUsd?.inUsd ?? 0,
      outUsd: quoteUsd?.outUsd ?? 0,
      quoted: Boolean(quoteUsd) && !isQuoteLoading,
      fromLabel: displaySymbolOf(tokenIn),
      fromAmount,
    });
  }, [onPreview, tokenIn, tokenOut, quoteUsd, isQuoteLoading, fromAmount]);

  // ---------------------------------------------------------------------------------------------
  // Execution — margin: the DEX swap through the AccountManager (health-checked on-chain);
  // wallet (not exposed): the DEX router directly with slippage-protected min out.
  // ---------------------------------------------------------------------------------------------
  const qc = useQueryClient();
  const swapMutation = useMutation({
    mutationFn: async () => {
      const slippageVal = parseFloat(slippagePercent) || parseFloat(AUTO_SLIPPAGE_PERCENT);
      const requestedAmountIn = parseFloat(amountIn);
      const amountInToUse =
        tokenInBalance !== null ? capAmountToMaxBalance(requestedAmountIn, tokenInBalance) : requestedAmountIn;
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
      return result;
    },
    onMutate: () => {
      setTxError("");
      setTxHash("");
      showTxStep(
        `Swapping ${amountIn} ${displaySymbolOf(tokenIn)} for ${displaySymbolOf(tokenOut)}${swapMode === "margin" ? " in your margin account" : ""}`,
      );
    },
    onSuccess: (result) => {
      setTxHash(result.hash ?? "");
      showTxSuccess("Swap submitted!");
      setAmountIn("");
      setAmountOut("");
      setActivePercent(null);
      setBalanceNonce((n) => n + 1);
      if (marginAccountAddress) refreshBorrowedBalances(marginAccountAddress, true);
      qc.invalidateQueries({ queryKey: ["margin"] });
      qc.invalidateQueries({ queryKey: ["earn"] });
      qc.invalidateQueries({ queryKey: ["spot"] });
      // RPC normally exposes the confirmed transfer events immediately, while
      // Mercury can trail the ledger by a few seconds. Retry the on-chain
      // history refresh twice so a temporarily lagging indexer cannot leave
      // Spot History empty until the user reloads the page.
      window.setTimeout(() => qc.invalidateQueries({ queryKey: ["spot", "history"] }), 2_500);
      window.setTimeout(() => qc.invalidateQueries({ queryKey: ["spot", "history"] }), 7_500);
      // Spot Balances (Portfolio's spot-section.tsx) reads live per-venue
      // balances under these two separate query-key prefixes, not ['spot'] —
      // without this they only refreshed on the next ledger tick, showing
      // stale amounts right after a swap.
      qc.invalidateQueries({ queryKey: ["soroswap", "tokenBalance"] });
      qc.invalidateQueries({ queryKey: ["farm", "aquarius", "tokenBalance"] });
    },
    onError: (error) => {
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Swap failed");
      setTxError(errorMsg);
      showTxError(errorMsg);
    },
  });

  const isSwapping = swapMutation.isPending;

  const buttonState: ButtonState = (() => {
    if (!isWalletConnected) return "connect_wallet";
    if (!tokenIn || !tokenOut) return "select_token";
    if (!amountIn || !(parseFloat(amountIn) > 0)) return "enter_amount";
    if (isQuoteLoading) return "loading_quote";
    if (swapMode === "margin" && !marginAccountAddress) return "no_margin_account";
    if (tokenInBalance !== null && parseTokenAmountToStroops(amountIn) > parseTokenAmountToStroops(tokenInBalance))
      return "insufficient_balance";
    if (quoteError) return "no_route";
    if (!amountOut) return "disabled";
    return "ready";
  })();

  const hasQuote = Boolean(isWalletConnected && amountIn && amountOut && tokenIn && tokenOut && !isQuoteLoading);

  // Handlers
  const handleFlip = useCallback(() => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    // Carry the quoted output over as the new input.
    setAmountIn(amountOut);
    setActivePercent(null);
    setTxHash("");
  }, [tokenIn, tokenOut, amountOut]);

  const handleTokenSelect = useCallback(
    (displayToken: Token) => {
      // The picker renders display-only tokens (symbol swapped to "AqUSDC"/
      // "SoUSDC"), so recover the real functional token by id before touching
      // state — everything downstream (service calls, partner maps) keys off
      // the real "XLM"/"USDC" symbol. Then snap the OTHER side to a real
      // on-chain partner for the newly-picked token.
      const token = tokenList.find((t) => t.id === displayToken.id);
      if (!token) return;
      if (tokenModalTarget === "in") {
        setTokenIn(token);
        setTokenOut(resolveTokenOutForTokenIn(isAquarius, tokenList, token.symbol, tokenOut?.symbol));
      } else {
        setTokenOut(token);
        setTokenIn(resolveTokenOutForTokenIn(isAquarius, tokenList, token.symbol, tokenIn?.symbol));
      }
      setAmountIn("");
      setAmountOut("");
      setActivePercent(null);
      setTokenModalTarget(null);
    },
    [tokenModalTarget, tokenIn, tokenOut, isAquarius, tokenList],
  );

  const handlePercentClick = useCallback(
    (pct: number) => {
      setActivePercent(pct);
      // getBalance(tokenIn) (== tokenInBalance) already covers wallet vs margin
      // mode and every token in both DEXes' lists — no need to re-derive it here.
      const rawBal = tokenInBalance;
      if (!rawBal || parseTokenAmountToStroops(rawBal) <= BigInt(0)) return;
      setAmountIn(amountFromBalancePercent(rawBal, pct));
      setTxHash("");
    },
    [tokenInBalance],
  );

  const handleButtonClick = useCallback(() => {
    if (buttonState === "connect_wallet") {
      // Same Connect modal as the navbar (Freighter / Privy).
      window.dispatchEvent(new CustomEvent(OPEN_CONNECT_WALLET_EVENT, { detail: { prefer: "modal" } }));
      return;
    }
    if (buttonState !== "ready" || futureHealthFactor?.blocked) return;
    if (!userAddress || !tokenIn) return;
    if (swapMode === "margin" && !marginAccountAddress) return;
    if (!isAquarius && !isSoroswap) return;
    swapMutation.mutate();
  }, [buttonState, futureHealthFactor?.blocked, userAddress, tokenIn, swapMode, marginAccountAddress, isAquarius, isSoroswap, swapMutation]);

  // Quote details default open when the swap moves the health factor (design behaviour).
  const detailsOpen = isDetailsExpanded ?? Boolean(futureHealthFactor);
  const balanceNum = (b: string | null) => (b === null ? 0 : parseFloat(b) || 0);
  const tokFmtSwap = (b: string | null, sym: string) =>
    balanceNum(b).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: sym === "USDC" ? 2 : 4 });
  const swappableTip = (sym: string) =>
    `${sym} in your margin account. In Vanna every token in the margin account is collateral and swappable at the same time: a swap trades it inside the account and the health check runs after the swap.`;

  // CTA label / style per state (the live states plus the safety floor).
  const cta: { label: string; kind: "g" | "off" | "danger" } = (() => {
    if (isSwapping) return { label: "Swapping…", kind: "off" };
    switch (buttonState) {
      case "connect_wallet":
        return { label: "Connect Wallet", kind: "g" };
      case "select_token":
        return { label: "Select a token", kind: "off" };
      case "enter_amount":
        return { label: "Enter an Amount", kind: "off" };
      case "loading_quote":
        return { label: "Fetching the best price…", kind: "off" };
      case "no_margin_account":
        return { label: "Create a margin account first", kind: "off" };
      case "insufficient_balance":
        return { label: "Insufficient Balance", kind: "danger" };
      case "no_route":
        return { label: "No quote", kind: "danger" };
      case "ready":
        return futureHealthFactor?.blocked ? { label: `Health factor would fall below ${nf(SAFE_HF, 2)}`, kind: "danger" } : { label: "Swap", kind: "g" };
      default:
        return { label: "Swap", kind: "off" };
    }
  })();
  const ctaEnabled = cta.kind === "g" && !isSwapping;
  const dexOption = DEXES.find((d) => d.id === dex) ?? DEXES[0];
  const hfAfter = futureHealthFactor;
  const inLabel = displaySymbolOf(tokenIn);
  const outLabel = displaySymbolOf(tokenOut);

  return (
    <>
      <section className="sp-card" aria-label="Swap">
        {/* Swap heading + DEX picker + Settings */}
        <div className="sp-hd">
          <div className="sp-hdl">
            <span className="sp-ttl">Swap</span>
            {/* DEX picker: the quote and the swap both go through the picked one. */}
            <span className="sp-dexw" ref={dexMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="sp-dex"
                onClick={() => setIsDexMenuOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={isDexMenuOpen}
              >
                <span className="sp-via">via</span>
                <Icon sym={dexOption.sym} className="sp-ico s16" />
                <b>{dexOption.label}</b>
                <span className={`sp-chev ${isDexMenuOpen ? "up" : ""}`}>{IC.chev}</span>
              </button>
              {isDexMenuOpen && (
                <div className="pop sp-dexm" role="listbox">
                  {DEXES.map((d) => {
                    const selected = d.id === dex;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`sp-dexo ${selected ? "on" : ""}`}
                        onClick={() => {
                          if (!selected) handleDexChange(d.id);
                          setIsDexMenuOpen(false);
                        }}
                      >
                        <Icon sym={d.sym} className="sp-ico s28" />
                        <span>
                          <b>{d.label}</b>
                          <small>{d.hint}</small>
                        </span>
                        {selected && <span className="sp-ok">{IC.check}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </span>
          </div>
          <button type="button" className="sp-gear" aria-label="Swap settings" onClick={() => setIsSettingsOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6.5 2.5L7.2 1.2C7.3 1.1 7.5 1 7.6 1H8.4C8.5 1 8.7 1.1 8.8 1.2L9.5 2.5L11 3.1L12.3 2.7C12.5 2.6 12.7 2.7 12.8 2.8L13.4 3.4C13.5 3.5 13.6 3.7 13.5 3.9L13.1 5.2L13.7 6.7L15 7.4C15.1 7.5 15.2 7.7 15.2 7.8V8.6C15.2 8.7 15.1 8.9 15 9L13.7 9.7L13.1 11.2L13.5 12.5C13.6 12.7 13.5 12.9 13.4 13L12.8 13.6C12.7 13.7 12.5 13.8 12.3 13.7L11 13.3L9.5 13.9L8.8 15.2C8.7 15.3 8.5 15.4 8.4 15.4H7.6C7.5 15.4 7.3 15.3 7.2 15.2L6.5 13.9L5 13.3L3.7 13.7C3.5 13.8 3.3 13.7 3.2 13.6L2.6 13C2.5 12.9 2.4 12.7 2.5 12.5L2.9 11.2L2.3 9.7L1 9C0.9 8.9 0.8 8.7 0.8 8.6V7.8C0.8 7.7 0.9 7.5 1 7.4L2.3 6.7L2.9 5.2L2.5 3.9C2.4 3.7 2.5 3.5 2.6 3.4L3.2 2.8C3.3 2.7 3.5 2.6 3.7 2.7L5 3.1L6.5 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="8" cy="8.2" r="2.2" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>

        {/* You Pay */}
        <div className="sp-in">
          <div className="sp-lr">
            <span className="sp-lbl">You Pay</span>
            {isWalletConnected && (
              <span className="sp-pcs">
                {[25, 50, 75, 100].map((p) => (
                  <button key={p} type="button" className={`sp-pc p${p} ${activePercent === p ? "on" : ""}`} onClick={() => handlePercentClick(p)}>
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </span>
            )}
          </div>
          <div className="sp-tr">
            <button type="button" className="sp-tok" aria-label={`Select token, now ${inLabel || "none"}`} onClick={() => setTokenModalTarget("in")}>
              {tokenIn && <Icon sym={inLabel} className="sp-ico s24" />}
              <span>{inLabel || "Select"}</span>
              {IC.chev}
            </button>
            <input
              className="sp-amt num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amountIn}
              aria-label="Amount to pay"
              onChange={(e) => {
                let v = e.target.value.replace(/,/g, "").replace(/[^0-9.]/g, "");
                const dot = v.indexOf(".");
                if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "").slice(0, 7);
                setAmountIn(v);
                setActivePercent(null);
                setTxHash("");
              }}
            />
          </div>
          <div className="sp-br">
            {isWalletConnected && tokenIn ? (
              <span className="sp-bal">
                <span className="num">Swappable: {tokFmtSwap(tokenInBalance, tokenIn.symbol)}</span>
                <Info text={swappableTip(inLabel)} />
                {/* No MAX link here: the card's 25/50/75/Max buttons above already do it. */}
              </span>
            ) : (
              <span />
            )}
            {amountInUsd && <span className="sp-usd num">~ ${amountInUsd}</span>}
          </div>
        </div>

        <div className="sp-flipw">
          <button type="button" className="sp-flip" aria-label="Reverse swap direction" onClick={handleFlip}>
            <VMark size={24} />
          </button>
        </div>

        {/* You Receive */}
        <div className="sp-in">
          <div className="sp-lr">
            <span className="sp-lbl">You Receive</span>
          </div>
          <div className="sp-tr">
            <button type="button" className="sp-tok" aria-label={`Select token, now ${outLabel || "none"}`} onClick={() => setTokenModalTarget("out")}>
              {tokenOut && <Icon sym={outLabel} className="sp-ico s24" />}
              <span>{outLabel || "Select"}</span>
              {IC.chev}
            </button>
            <input className="sp-amt num" readOnly tabIndex={-1} placeholder={isQuoteLoading ? "…" : "0"} value={isQuoteLoading ? "" : amountOut} aria-label="Amount you receive" />
          </div>
          <div className="sp-br">
            {isWalletConnected && tokenOut ? <span className="sp-bal num">Swappable: {tokFmtSwap(tokenOutBalance, tokenOut.symbol)}</span> : <span />}
            {amountOutUsd && <span className="sp-usd num">~ ${amountOutUsd}</span>}
          </div>
        </div>

        <div className="sp-dyn" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {hasQuote ? (
            <>
              {/* Quote details */}
              <div className="sp-det">
                <div
                  className="sp-dh"
                  role="button"
                  tabIndex={0}
                  aria-expanded={detailsOpen}
                  onClick={() => setIsDetailsExpanded(!detailsOpen)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setIsDetailsExpanded(!detailsOpen);
                    }
                  }}
                >
                  <span className="sp-dl">
                    {exchangeRate && (
                      <button
                        type="button"
                        className="sp-rate num"
                        title="Click to flip direction"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFlipRate();
                        }}
                      >
                        {exchangeRate}
                      </button>
                    )}
                    {hfAfter && (
                      <span className="sp-hfh">
                        · HF <span>{hfFmt(hfAfter.before)}</span> {IC.arrow} <b className={hfAfter.after < SAFE_HF ? "neg" : ""}>{hfFmt(hfAfter.after)}</b>
                      </span>
                    )}
                    <button
                      type="button"
                      className="sp-ref"
                      aria-label="Refresh quote"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRefreshNonce((n) => n + 1);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M11.67 7A4.67 4.67 0 1 1 7 2.33M7 2.33L9.33 4.67M7 2.33L4.67 4.67" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </span>
                  <span className={`sp-chev ${detailsOpen ? "up" : ""}`}>{IC.chev}</span>
                </div>
                {detailsOpen && (
                  <div className="sp-db num">
                    {oracleExchangeRate && quoteExchangeRate && (
                      <div className="sp-dr">
                        <span>Pool Rate</span>
                        <span>{quoteExchangeRate}</span>
                      </div>
                    )}
                    {priceImpactInfo.label && (
                      <div className="sp-dr">
                        <span>Price Impact</span>
                        <span className={`sp-imp ${priceImpactInfo.level === "medium" ? "med" : priceImpactInfo.level ?? "low"}`}>
                          {priceImpactInfo.label}
                          <i />
                        </span>
                      </div>
                    )}
                    {hfAfter && (
                      <div className="sp-dr">
                        <span>Health Factor</span>
                        <span>
                          {hfFmt(hfAfter.before)} <em>{IC.arrow}</em> <b className={hfAfter.after < SAFE_HF ? "neg" : ""}>{hfFmt(hfAfter.after)}</b>
                        </span>
                      </div>
                    )}
                    <div className="sp-dr">
                      <span>Slippage Tolerance</span>
                      <span>
                        {slippagePercent}%{" "}
                        <button type="button" className="sp-edit" onClick={() => setIsSettingsOpen(true)}>
                          Edit
                        </button>
                      </span>
                    </div>
                    {minReceived && (
                      <div className="sp-dr">
                        <span>Min. Received</span>
                        <span>{minReceived}</span>
                      </div>
                    )}
                    <div className="sp-dr">
                      <span>LP Fee</span>
                      <span>0.30%</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Route card: one direct pool on the picked DEX (both DEXes route XLM <-> USDC directly). */}
              {tokenIn && tokenOut && (
                <div className="sp-route">
                  <div className="sp-rh">
                    <span className="sp-rl">
                      <b>Route</b>
                      <span>· 1 hop · {dexOption.label}</span>
                    </span>
                    <span className="sp-via2">
                      <Icon sym={dexOption.sym} className="sp-ico s16" />
                      via {dexOption.label}
                    </span>
                  </div>
                  <div className="sp-rpath">
                    <span className="sp-rt">
                      <Icon sym={inLabel} className="sp-ico s36" />
                      <b>{inLabel}</b>
                    </span>
                    <span className="sp-rline">
                      <small title={`${dexOption.label} ${inLabel}/${outLabel} pool`}>{dexOption.label}</small>
                      <i />
                    </span>
                    <span className="sp-rt">
                      <Icon sym={outLabel} className="sp-ico s36" />
                      <b>{outLabel}</b>
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="sp-sp" />
          )}

          {/* No quote / quote failure — shown honestly, never replaced by an estimate. */}
          {quoteError && !isQuoteLoading && (
            <div className="sp-warn info">
              {IC.warn}
              <span>
                {quoteError === "no_route"
                  ? `${dexOption.label} couldn't quote ${inLabel} → ${outLabel} at this amount. Try a different amount or DEX.`
                  : `Couldn't fetch a quote: ${quoteError}`}
              </span>
            </div>
          )}

          {/* High price-impact warning banner — visible when the executed
              quote diverges materially from the oracle (e.g. thin pool). */}
          {isHighPriceImpact && (
            <div className="sp-warn danger">
              {IC.warn}
              <span>
                High price impact{priceImpactInfo.label ? ` (${priceImpactInfo.label})` : ""}. You&apos;ll receive far less than fair value; this pool&apos;s liquidity is too thin for
                this trade size. Reduce the amount or pick another DEX.
              </span>
            </div>
          )}

          {/* Health-factor floor: blocked below SAFE_HF, amber below WARN_HF, both only when the swap lowers it. */}
          {hfAfter?.blocked ? (
            <div className="sp-warn danger">
              {IC.warn}
              <span>
                This swap would take your health factor from {hfFmt(hfAfter.before)} to {hfFmt(hfAfter.after)}, below the {nf(SAFE_HF, 2)} safety floor (liquidation at{" "}
                {nf(LIQ_HF, 2)}). Reduce the amount or repay debt before swapping.
              </span>
            </div>
          ) : hfAfter?.amber ? (
            <div className="sp-warn warn">
              {IC.warn}
              <span>
                Health factor would be <span className={hfZone(hfAfter.after)}>{hfFmt(hfAfter.after)}</span>, close to the {nf(SAFE_HF, 2)} safety floor (liquidation at {nf(LIQ_HF, 2)}).
              </span>
            </div>
          ) : null}

          {/* Margin mode needs a margin account (the swap runs inside it). */}
          {swapMode === "margin" && isWalletConnected && !marginAccountAddress && (
            <div className="sp-warn warn">
              {IC.warn}
              <span>
                Swaps run inside your margin account — create one on the <a href="/margin" style={{ textDecoration: "underline" }}>Margin</a> page first.
              </span>
            </div>
          )}

          {/* Swap CTA */}
          <button type="button" className={`sp-cta ${cta.kind}`} disabled={!ctaEnabled} onClick={handleButtonClick}>
            {cta.label}
          </button>

          {/* Last swap result */}
          {txHash && (
            <a className="sp-done" href={`https://stellar.expert/explorer/testnet/tx/${txHash}`} target="_blank" rel="noopener noreferrer">
              Swap confirmed — view transaction
            </a>
          )}
          {txError && !isSwapping && <p className="sp-warn danger">{txError}</p>}
        </div>
      </section>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SwapSettingsModal
          slippage={slippage}
          onSlippageChange={setSlippage}
          mode={slippageMode}
          onModeChange={setSlippageMode}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {/* Token picker — only the real on-chain partners of the other side on the picked DEX. */}
      {tokenModalTarget !== null && (
        <TokenPickerModal
          tokens={modalTokens.map(toDisplayToken)}
          popular={modalTokens.map(toDisplayToken)}
          balances={isWalletConnected ? tokenListBalances : undefined}
          onSelect={handleTokenSelect}
          onClose={() => setTokenModalTarget(null)}
        />
      )}
    </>
  );
};
