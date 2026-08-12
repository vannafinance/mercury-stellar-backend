"use client";

/**
 * Farm "Add Liquidity" panel. Handles two flows from the user's margin account:
 * - Single-asset supply into a Blend lending pool (with a projected-earnings
 *   {@link DepositSummary} and borrow-vs-collateral source attribution).
 * - Dual-asset add into an Aquarius or Soroswap LP pool, auto-computing the
 *   paired amount from live pool reserves to keep the deposit on-ratio.
 *
 * Requires a connected wallet and an existing margin account; the submit button
 * surfaces the specific gating reason. Pool type (Blend vs Aquarius/Soroswap) is
 * inferred from the selected farm row.
 */
import Image from "next/image";
import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useFarmStore } from "@/store/farm-store";
import { Button } from "../ui/button";
import { BlendService, BLEND_POOL_ASSETS } from "@/lib/blend-utils";
import { AquariusService, AquariusPoolStats, AQUARIUS_POOLS, AquariusSwapSymbol } from "@/lib/aquarius-utils";
import { SoroswapService, SoroswapPoolStats, SOROSWAP_POOLS, SoroswapSwapSymbol } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { MarginAccountService } from "@/lib/margin-utils";
import { iconPaths } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { useBlendPoolStats } from "@/hooks/use-farm";
import { useTokenPrice } from "@/hooks/use-token-prices";
import { DepositSummary } from "./deposit-summary";
import { appendFarmHistory, buildFarmPoolKey } from "@/lib/farm-history";
import { normalizeContractError } from "@/lib/errors/normalize";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { formatUsdValue } from "@/lib/utils/format-amount";
import { attributeFarmDeposit } from "@/lib/utils/margin-token-attribution";

const SUPPORTED_TOKENS = ["XLM", "USDC"] as const;
type TokenSymbol = (typeof SUPPORTED_TOKENS)[number];

/**
 * Memoized add-liquidity panel. Resolves the selected pool's protocol + tokens
 * from the farm store, loads the relevant margin-account balances, and dispatches
 * either the Blend deposit or the DEX add-liquidity mutation.
 */
export const AddLiquidity = memo(function AddLiquidity() {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const selectedRow = useFarmStore((state) => state.selectedRow);
  const tabType = useFarmStore((state) => state.tabType);

  // `selectedRow` lives in a client-side store populated only when navigating
  // here by clicking a row on the Farm list page — a hard reload (or a direct
  // URL visit) starts with it empty, which silently misclassified every
  // Aquarius/Soroswap pool as single-asset Blend (this panel rendered its
  // one-token form for a pool that needs two). Mirrors the URL-derived
  // detection `app/farm/[id]/page.tsx` already uses for its header/tabs,
  // which is why THOSE kept showing the correct protocol after a refresh
  // while this panel didn't. Only used as a fallback when the store is empty,
  // so the existing store-driven behavior is unchanged when it IS populated.
  const params = useParams();
  const urlId = (params?.id as string | undefined)?.toLowerCase();
  const urlIsSoroswapPool = urlId?.startsWith("soroswap-") ?? false;
  const urlIsAquariusPool = !urlIsSoroswapPool && urlId != null && !["xlm", "usdc"].includes(urlId);
  const urlMatchedSoroswapPool = urlIsSoroswapPool
    ? SOROSWAP_POOLS.find((p) => p.id === urlId) ?? SOROSWAP_POOLS[0]
    : null;
  const urlMatchedAquariusPool = urlIsAquariusPool
    ? AQUARIUS_POOLS.find((p) => p.id === urlId || p.tokens.join("-").toLowerCase() === urlId) ?? AQUARIUS_POOLS[0]
    : null;

  const isAquariusPool = selectedRow
    ? tabType === "multi" &&
      ((selectedRow?.cell?.[1] as any)?.title?.toLowerCase?.() === "aquarius" ||
        (selectedRow?.cell?.[0] as any)?.tags?.includes?.("Aquarius"))
    : urlIsAquariusPool;

  const isSoroswapPool = selectedRow
    ? tabType === "multi" &&
      ((selectedRow?.cell?.[1] as any)?.title?.toLowerCase?.() === "soroswap" ||
        (selectedRow?.cell?.[0] as any)?.tags?.includes?.("Soroswap"))
    : urlIsSoroswapPool;

  const poolTokens = selectedRow
    ? (selectedRow?.cell?.[0] as any)?.titles?.map((t: string) => t.toUpperCase()) ?? ["XLM", "USDC"]
    : (urlMatchedSoroswapPool?.tokens ?? urlMatchedAquariusPool?.tokens ?? ["XLM", "USDC"]);
  const tokenA = poolTokens[0] ?? "XLM";
  const tokenB = poolTokens[1] ?? "USDC";
  // Display-only — every balance fetch, reserve lookup, and the actual
  // addLiquidity() call below MUST keep using the raw tokenB ("XLM"/"USDC"),
  // not this label. Only ever use tokenBLabel in rendered text.
  const tokenBLabel = tokenB === "USDC" ? (isAquariusPool ? "AqUSDC" : "SoUSDC") : tokenB;

  // Resolve which actual on-chain pool this row is (order-insensitive on
  // tokens) — every stats/balance fetch below MUST use this pool's own
  // address, not a hardcoded XLM/USDC default, or it silently shows the
  // wrong pool's numbers relabeled with this pool's token symbols.
  const matchedSoroswapPoolConfig = SOROSWAP_POOLS.find(
    (p) => p.tokens.includes(tokenA) && p.tokens.includes(tokenB)
  );
  const matchedAquariusPoolConfig = AQUARIUS_POOLS.find(
    (p) => p.tokens.includes(tokenA) && p.tokens.includes(tokenB)
  );

  // Determine initial token from store (for single asset / lending rows) —
  // same hard-refresh gap as above: fall back to the URL slug (literally
  // "xlm"/"usdc" for a Blend pool) when the store hasn't been populated.
  const getInitialToken = useCallback((): TokenSymbol => {
    if (tabType === "single" && selectedRow) {
      const firstCell = selectedRow.cell?.[0] as any;
      const title = (firstCell?.title as string | undefined)?.toUpperCase();
      if (title && SUPPORTED_TOKENS.includes(title as TokenSymbol)) {
        return title as TokenSymbol;
      }
    }
    if (!selectedRow && urlId) {
      const upper = urlId.toUpperCase();
      if (SUPPORTED_TOKENS.includes(upper as TokenSymbol)) return upper as TokenSymbol;
    }
    return "XLM";
  }, [tabType, selectedRow, urlId]);

  const [selectedToken, setSelectedToken] = useState<TokenSymbol>(getInitialToken);
  const [value, setValue] = useState<string>("");
  const [tokenDropdownOpen, setTokenDropdownOpen] = useState(false);
  const tokenDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!tokenDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (tokenDropdownRef.current && !tokenDropdownRef.current.contains(e.target as Node)) setTokenDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tokenDropdownOpen]);
  const [amountA, setAmountA] = useState<string>("");
  const [amountB, setAmountB] = useState<string>("");
  // Which quick-fill percentage (if any) is currently active per token — drives
  // the highlighted state on the 10/25/50/100% buttons, matching Remove
  // Liquidity's percentage pills. Cleared on manual typing in either input
  // since the paired auto-calc means an edit to one token can make the
  // other's percentage highlight stale.
  const [selectedPctA, setSelectedPctA] = useState<number>(0);
  const [selectedPctB, setSelectedPctB] = useState<number>(0);
  // Borrowed balances from margin account (amounts available to route into Blend)
  const borrowedBalances = useMarginAccountInfoStore((s) => s.borrowedBalances);
  const isLoadingBorrowedBalances = useMarginAccountInfoStore((s) => s.isLoadingBorrowedBalances);
  const { stats: poolStats } = useBlendPoolStats();
  const [txStatus, setTxStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState<string>("");
  const [txError, setTxError] = useState<string>("");
  const [marginAccountAddress, setMarginAccountAddress] = useState<string | null>(null);
  const [blendConfigured, setBlendConfigured] = useState<boolean | null>(null);
  const [aquariusRegistryMissing, setAquariusRegistryMissing] = useState(false);
  const [aquariusPoolStats, setAquariusPoolStats] = useState<AquariusPoolStats | null>(null);
  const [soroswapPoolStats, setSoroswapPoolStats] = useState<SoroswapPoolStats | null>(null);
  // Current Blend supply balance for the selected token
  const [blendBalance, setBlendBalance] = useState<string>("0");
  const [loadingBlendBalance, setLoadingBlendBalance] = useState(false);
  const [marginTokenBalance, setMarginTokenBalance] = useState<string>("0");
  const [loadingMarginTokenBalance, setLoadingMarginTokenBalance] = useState(false);
  // Keyed by symbol (generic over whichever two tokens the selected pool
  // actually is — previously two fixed XLM/USDC variables that silently
  // reused the XLM balance for any pool whose second token wasn't USDC).
  const [marginDexBalances, setMarginDexBalances] = useState<Record<string, string>>({});
  const [loadingMarginBalances, setLoadingMarginBalances] = useState(false);

  const refreshDexMarginBalances = useCallback(
    async (retryCount = 1, retryDelayMs = 1200) => {
      if ((!isAquariusPool && !isSoroswapPool) || !marginAccountAddress) return;

      setLoadingMarginBalances(true);
      try {
        for (let attempt = 0; attempt < retryCount; attempt++) {
          const [balA, balB] = isSoroswapPool
            ? await Promise.all([
                SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, tokenA as SoroswapSwapSymbol),
                SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, tokenB as SoroswapSwapSymbol),
              ])
            : await Promise.all([
                AquariusService.getMarginAccountTokenBalance(marginAccountAddress, tokenA as AquariusSwapSymbol),
                AquariusService.getMarginAccountTokenBalance(marginAccountAddress, tokenB as AquariusSwapSymbol),
              ]);

          setMarginDexBalances({ [tokenA]: balA, [tokenB]: balB });

          if (attempt < retryCount - 1) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      } finally {
        setLoadingMarginBalances(false);
      }
    },
    [isAquariusPool, isSoroswapPool, marginAccountAddress, tokenA, tokenB]
  );

  // Check protocol configuration (once on mount)
  useEffect(() => {
    if (!isAquariusPool && !isSoroswapPool) {
      BlendService.isBlendPoolConfigured()
        .then(setBlendConfigured)
        .catch(() => setBlendConfigured(false));
      return;
    }

    if (isAquariusPool) {
      // Always usable via hardcoded fallback — check Registry separately for info only
      AquariusService.isAquariusConfigured()
        .then((configured) => setAquariusRegistryMissing(!configured))
        .catch(() => setAquariusRegistryMissing(true));
      // Fetch pool stats for ratio calculation — must be THIS row's own pool
      // address, not always the XLM/USDC default.
      AquariusService.getAquariusPoolStats(
        matchedAquariusPoolConfig?.poolAddress ?? CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL
      )
        .then(setAquariusPoolStats)
        .catch(() => setAquariusPoolStats(null));
      setSoroswapPoolStats(null);
      return;
    }

    if (isSoroswapPool) {
      setAquariusRegistryMissing(false);
      SoroswapService.getPoolStats(matchedSoroswapPoolConfig?.pairAddress)
        .then(setSoroswapPoolStats)
        .catch(() => setSoroswapPoolStats(null));
      setAquariusPoolStats(null);
    }
  }, [isAquariusPool, isSoroswapPool, matchedAquariusPoolConfig, matchedSoroswapPoolConfig]);

  // Auto-calculate tokenB when user types tokenA (and vice versa).
  // reserveA / reserveB match pool.tokens[0] / tokens[1] (see aquarius-utils).
  const poolSpotPriceAinB = (rA: number, rB: number): number =>
    rA > 0 && rB > 0 ? rB / rA : 0;

  const handleAmountAChange = (val: string) => {
    setAmountA(val);
    const parsed = parseFloat(val);
    const reserveA = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveXLM ?? "0")
      : parseFloat(aquariusPoolStats?.reserveA ?? "0");
    const reserveB = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveUSDC ?? "0")
      : parseFloat(aquariusPoolStats?.reserveB ?? "0");

    if (!isNaN(parsed) && parsed > 0 && reserveA > 0 && reserveB > 0) {
      const ratio = poolSpotPriceAinB(reserveA, reserveB);
      if (ratio > 0) setAmountB((parsed * ratio).toFixed(2));
    } else if (val === '') {
      setAmountB('');
    }
  };

  const handleAmountBChange = (val: string) => {
    setAmountB(val);
    const parsed = parseFloat(val);
    const reserveA = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveXLM ?? "0")
      : parseFloat(aquariusPoolStats?.reserveA ?? "0");
    const reserveB = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveUSDC ?? "0")
      : parseFloat(aquariusPoolStats?.reserveB ?? "0");

    if (!isNaN(parsed) && parsed > 0 && reserveA > 0 && reserveB > 0) {
      const inverseRatio = reserveA / reserveB;
      if (inverseRatio > 0) setAmountA((parsed * inverseRatio).toFixed(2));
    } else if (val === '') {
      setAmountA('');
    }
  };

  // Load margin account address whenever wallet changes
  useEffect(() => {
    if (!userAddress) {
      setMarginAccountAddress(null);
      return;
    }
    const stored = MarginAccountService.getStoredMarginAccount(userAddress);
    setMarginAccountAddress(stored?.address ?? null);
  }, [userAddress]);

  // Refresh borrowed balances when margin account or token changes
  useEffect(() => {
    if (!marginAccountAddress) return;
    refreshBorrowedBalances(marginAccountAddress);
  }, [marginAccountAddress, selectedToken]);

  // Fetch actual margin account token balances for multi-asset pool display
  useEffect(() => {
    if ((!isAquariusPool && !isSoroswapPool) || !marginAccountAddress) {
      setMarginDexBalances({});
      return;
    }
    refreshDexMarginBalances();
  }, [isAquariusPool, isSoroswapPool, marginAccountAddress, txHash, refreshDexMarginBalances]);

  // Fetch current Blend supply balance for selected token
  useEffect(() => {
    if (!marginAccountAddress) {
      setBlendBalance("0");
      return;
    }
    setLoadingBlendBalance(true);
    BlendService.getUserBlendBalance(marginAccountAddress, selectedToken)
      .then((info) => setBlendBalance(info.underlyingBalance))
      .catch(() => setBlendBalance("0"))
      .finally(() => setLoadingBlendBalance(false));
  }, [marginAccountAddress, selectedToken]);

  useEffect(() => {
    if (!marginAccountAddress) {
      setMarginTokenBalance("0");
      return;
    }

    setLoadingMarginTokenBalance(true);
    BlendService.getMarginAccountTokenBalance(marginAccountAddress, selectedToken)
      .then((balance) => setMarginTokenBalance(balance))
      .catch(() => setMarginTokenBalance("0"))
      .finally(() => setLoadingMarginTokenBalance(false));
  }, [marginAccountAddress, selectedToken]);


  const handleMaxClick = () => {
    setValue(availableToDeployStr);
  };

  const handleTokenSelect = (token: TokenSymbol) => {
    setSelectedToken(token);
    setValue("");
    setAmountA("");
    setAmountB("");
    setTxStatus("idle");
    setTxError("");
  };

  const qc = useQueryClient();

  const addLiquidityMutation = useMutation({
    mutationFn: async ({ amtA, amtB }: { amtA: number; amtB: number }) => {
      const result = isSoroswapPool
        ? await SoroswapService.addLiquidity(
            userAddress!, marginAccountAddress!, amtA, amtB,
            tokenA as SoroswapSwapSymbol, tokenB as SoroswapSwapSymbol,
          )
        : await AquariusService.addLiquidity(userAddress!, marginAccountAddress!, tokenA, tokenB, amtA, amtB);
      if (!result.success) {
        throw new Error(result.error ?? "Add liquidity failed");
      }
      return { ...result, amtA, amtB };
    },
    onMutate: ({ amtA, amtB }) => {
      setTxStatus("loading");
      setTxError("");
      setTxHash("");
      showTxStep(`Adding ${amtA.toFixed(2)} ${tokenA} + ${amtB.toFixed(2)} ${tokenBLabel} liquidity to ${isSoroswapPool ? "Soroswap" : "Aquarius"}`);
    },
    onSuccess: ({ hash, amtA, amtB }) => {
      setTxStatus("success");
      setTxHash(hash ?? "");
      appendFarmHistory({
        protocol: isSoroswapPool ? "soroswap" : "aquarius",
        poolKey: buildFarmPoolKey(tokenA, tokenB),
        marginAccountAddress: marginAccountAddress!,
        action: "add",
        amountDisplay: `${amtA.toFixed(2)} ${tokenA} + ${amtB.toFixed(2)} ${tokenBLabel}`,
        txHash: hash ?? "",
      });
      showTxSuccess("Liquidity added!");
      setMarginDexBalances((prev) => ({
        ...prev,
        [tokenA]: Math.max(0, parseFloat(prev[tokenA] || "0") - amtA).toFixed(2),
        [tokenB]: Math.max(0, parseFloat(prev[tokenB] || "0") - amtB).toFixed(2),
      }));
      setAmountA("");
      setAmountB("");
      refreshDexMarginBalances(3, 1500);
      if (isSoroswapPool) {
        SoroswapService.getPoolStats(matchedSoroswapPoolConfig?.pairAddress).then(setSoroswapPoolStats).catch(() => {});
      } else {
        AquariusService.getAquariusPoolStats(
          matchedAquariusPoolConfig?.poolAddress ?? CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL
        )
          .then(setAquariusPoolStats)
          .catch(() => {});
      }
      qc.invalidateQueries({ queryKey: ['farm'] });
    },
    onError: (error) => {
      setTxStatus("error");
      const message = normalizeContractError(error instanceof Error ? error.message : undefined, "Add liquidity failed");
      setTxError(message);
      showTxError(message);
    },
  });

  const handleAddLiquidity = () => {
    if (!userAddress || !marginAccountAddress) return;
    const amtA = parseFloat(amountA);
    const amtB = parseFloat(amountB);
    if (isNaN(amtA) || isNaN(amtB) || amtA <= 0 || amtB <= 0) return;
    addLiquidityMutation.mutate({ amtA, amtB });
  };

  const depositToBlendMutation = useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      const result = await BlendService.depositToBlendPool(
        userAddress!,
        marginAccountAddress!,
        selectedToken,
        amount,
      );
      if (!result.success) {
        throw new Error(result.error ?? "Deposit failed");
      }
      return { ...result, amount };
    },
    onMutate: ({ amount }) => {
      setTxStatus("loading");
      setTxError("");
      setTxHash("");
      showTxStep(`Depositing ${amount.toFixed(2)} ${selectedToken === "USDC" ? "BLUSDC" : selectedToken} to Blend`);
    },
    onSuccess: ({ hash, amount }) => {
      setTxStatus("success");
      setTxHash(hash ?? "");
      appendFarmHistory({
        protocol: "blend",
        poolKey: buildFarmPoolKey(selectedToken),
        marginAccountAddress: marginAccountAddress!,
        action: "add",
        amountDisplay: `${amount.toFixed(2)} ${selectedToken === "USDC" ? "BLUSDC" : selectedToken}`,
        txHash: hash ?? "",
      });
      showTxSuccess("Deposit successful!");
      setValue("");
      qc.invalidateQueries({ queryKey: ['farm'] });
      refreshBorrowedBalances(marginAccountAddress!, true);
      setTimeout(() => {
        BlendService.getUserBlendBalance(marginAccountAddress!, selectedToken)
          .then((info) => setBlendBalance(info.underlyingBalance))
          .catch(() => {});
      }, 3000);
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Deposit failed");
      setTxError(errorMsg);
      showTxError(errorMsg);
    },
  });

  const handleDeposit = () => {
    if (!userAddress || !marginAccountAddress) return;
    const amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) return;
    depositToBlendMutation.mutate({ amount });
  };

  const poolAsset = BLEND_POOL_ASSETS.find((a) => a.symbol === selectedToken);
  const iconPath = poolAsset?.iconPath ?? iconPaths[selectedToken] ?? "/icons/stellar.svg";

  const isInputValid = parseFloat(value) > 0 && !isNaN(parseFloat(value));
  const blendDeployed = parseFloat(blendBalance);
  const marginRawNum = parseFloat(marginTokenBalance || "0");
  const borrowedForToken = parseFloat(
    borrowedBalances[selectedToken]?.amount ?? "0",
  );
  const availableToDeployNum = marginRawNum;
  const availableToDeployStr = availableToDeployNum.toFixed(2);
  const depositAmountNum = parseFloat(value) || 0;
  const depositAttribution = attributeFarmDeposit(
    marginRawNum,
    blendDeployed,
    borrowedForToken,
    depositAmountNum,
  );
  const isOverBalance = parseFloat(value) > availableToDeployNum;
  const isSubmitDisabled =
    !userAddress ||
    !marginAccountAddress ||
    blendConfigured === false ||
    !isInputValid ||
    isOverBalance ||
    txStatus === "loading";

  if (isAquariusPool || isSoroswapPool) {
    const dexName = isSoroswapPool ? "Soroswap" : "Aquarius";
    const reserveA = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveXLM ?? "0")
      : parseFloat(aquariusPoolStats?.reserveA ?? "0");
    const reserveB = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveUSDC ?? "0")
      : parseFloat(aquariusPoolStats?.reserveB ?? "0");

    const availableA = marginDexBalances[tokenA] ?? "0";
    const availableB = marginDexBalances[tokenB] ?? "0";
    const isInputValid = parseFloat(amountA) > 0 && parseFloat(amountB) > 0;
    const isOverA = parseFloat(amountA) > parseFloat(availableA);
    const isOverB = parseFloat(amountB) > parseFloat(availableB);
    const isSubmitDisabled =
      !userAddress ||
      !marginAccountAddress ||
      !isInputValid ||
      isOverA ||
      isOverB ||
      txStatus === "loading";

    const buttonText = () => {
      if (!userAddress) return "Connect Wallet";
      if (!marginAccountAddress) return "Margin Account Required";
      if (txStatus === "loading") return "Adding Liquidity...";
      if (!isInputValid) return "Enter Amounts";
      if (isOverA || isOverB) return "Insufficient Balance";
      return `Add ${tokenA}/${tokenBLabel} (${dexName})`;
    };

    return (
      <div className="w-full h-fit flex flex-col gap-[16px]">
        <div className={`w-full h-fit p-[20px] rounded-[16px] ${
          isDark ? "bg-[#111111]" : "bg-white"
        }`}>
          {(reserveA > 0 && reserveB > 0) && (
            <div className={`text-[11px] font-medium mb-[4px] ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
              {(() => {
                const priceAinB = poolSpotPriceAinB(reserveA, reserveB);
                const priceBinA = reserveA > 0 && reserveB > 0 ? reserveA / reserveB : 0;
                const fmtA = priceAinB < 0.01 ? priceAinB.toFixed(4) : priceAinB.toFixed(2);
                const fmtB = priceBinA < 0.01 ? priceBinA.toFixed(4) : priceBinA.toFixed(2);
                return `1 ${tokenA} ≈ ${fmtA} ${tokenBLabel} · 1 ${tokenBLabel} ≈ ${fmtB} ${tokenA}`;
              })()}
            </div>
          )}
          <div className="w-full flex flex-col gap-[12px]">
            {[tokenA, tokenB].map((token, idx) => {
              const tokenLabel = idx === 0 ? token : tokenBLabel;
              return (
              <div
                key={token}
                className={`w-full h-fit flex flex-col gap-[8px] p-[12px] rounded-[12px] ${
                  isDark ? "bg-[#1A1A1A]" : "bg-[#F7F7F7]"
                }`}
              >
                <div className="w-full flex items-center gap-[12px]">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={idx === 0 ? amountA : amountB}
                    onChange={(e) => {
                      const sanitized = validateAmountChange(e.target.value);
                      if (sanitized === null) return;
                      if (idx === 0) handleAmountAChange(sanitized);
                      else handleAmountBChange(sanitized);
                      setSelectedPctA(0);
                      setSelectedPctB(0);
                    }}
                    min="0"
                    className={`w-full bg-transparent outline-none border-none text-[18px] font-semibold placeholder:opacity-20 ${
                      isDark ? "text-white placeholder:text-white" : "text-black placeholder:text-black"
                    } [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                  />
                  <div className="flex flex-col items-end gap-[4px] shrink-0">
                    <div className="flex items-center gap-[6px]">
                      <Image
                        src={iconPaths[token] ?? "/icons/stellar.svg"}
                        alt={token}
                        width={18}
                        height={18}
                      />
                      <span className={`text-[13px] font-semibold ${
                        isDark ? "text-white" : "text-[#111111]"
                      }`}>
                        {tokenLabel}
                      </span>
                    </div>
                    <span className={`text-[11px] font-medium whitespace-nowrap ${
                      isDark ? "text-[#919191]" : "text-[#5C5B5B]"
                    }`}>
                      {loadingMarginBalances
                        ? "Loading..."
                        : `Bal: ${parseFloat(idx === 0 ? availableA : availableB).toFixed(2)}`}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {DEPOSIT_PERCENTAGES.map((pct) => {
                    const isSelected = (idx === 0 ? selectedPctA : selectedPctB) === pct;
                    return (
                      <motion.button
                        key={pct}
                        type="button"
                        disabled={txStatus === "loading" || loadingMarginBalances}
                        onClick={() => {
                          const bal = parseFloat(idx === 0 ? availableA : availableB) || 0;
                          const amt = ((bal * pct) / 100).toFixed(2);
                          if (idx === 0) {
                            handleAmountAChange(amt);
                            setSelectedPctA(pct);
                            setSelectedPctB(0);
                          } else {
                            handleAmountBChange(amt);
                            setSelectedPctB(pct);
                            setSelectedPctA(0);
                          }
                        }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.93 }}
                        transition={{ duration: 0.1 }}
                        className={`px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                          isSelected
                            ? "bg-[#703AE6] text-white border-transparent"
                            : isDark
                              ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                              : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                        } ${(txStatus === "loading" || loadingMarginBalances) ? "opacity-40 cursor-not-allowed" : ""}`}
                        style={{
                          boxShadow: isSelected ? `0 0 0 1px ${PERCENTAGE_COLORS[pct]}` : "none",
                        }}
                      >
                        {pct}%
                      </motion.button>
                    );
                  })}
                </div>
              </div>
              );
            })}
          </div>
        </div>

        {isAquariusPool && aquariusRegistryMissing && (
          <div className={`w-full h-fit p-[12px] rounded-[12px] text-[12px] ${
            isDark ? "bg-[#1A1A1A] text-[#FFA07A]" : "bg-[#FFF8F0] text-[#C05000]"
          }`}>
            Registry not configured — using default Aquarius addresses. LP position tracking requires
            the admin to run <code>set_aquarius_router_address</code> and{" "}
            <code>set_aquarius_pool_index</code> on the Registry.
          </div>
        )}

        {isSoroswapPool && (
          <div className={`w-full h-fit p-[12px] rounded-[12px] text-[12px] ${
            isDark ? "bg-[#1A1A1A] text-[#8AB4FF]" : "bg-[#F1F7FF] text-[#1E4FA8]"
          }`}>
            LP positions are tracked on-chain from your margin account Soroswap LP token balance.
          </div>
        )}

        <Button
          text={buttonText()}
          size="large"
          type="solid"
          disabled={isSubmitDisabled}
          onClick={handleAddLiquidity}
        />
      </div>
    );
  }

  // Live oracle price for the selected deposit token; powers the
  // Morpho-style projected-earnings summary below the input.
  const tokenPriceUsd = useTokenPrice(selectedToken);

  // Pool's supply APY from on-chain Blend reserve config × utilization.
  // `poolStats[selectedToken]` returns null while loading or on error.
  const reserveStats = poolStats[selectedToken];
  const supplyApyPct = reserveStats
    ? parseFloat(reserveStats.supplyAPY)
    : null;

  // Token selector as inline token pills
  const token = selectedToken;
  // Display-only — selectedToken itself stays the raw "XLM"/"USDC" used by
  // every BlendService call above.
  const tokenLabel = token === "USDC" ? "BLUSDC" : token;
  const tokenBalance = availableToDeployNum;

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!marginAccountAddress) return "Margin Account Required";
    if (blendConfigured === false) return "Blend Pool Not Configured";
    if (txStatus === "loading") return "Processing...";
    if (parseFloat(value) <= 0 || !value) return "Enter Amount";
    if (parseFloat(value) > availableToDeployNum) return `Insufficient ${token} Balance`;
    return "Add Liquidity";
  };

  return (
    <div className="w-full h-fit flex flex-col gap-3">
      {/* Input card */}
      <div className={`w-full rounded-xl border flex flex-col ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`}>
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={value}
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
            }}
            disabled={txStatus === "loading"}
            className={`flex-1 min-w-0 bg-transparent outline-none text-[20px] font-semibold placeholder:opacity-20 ${isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"}`}
          />
          {/* Token dropdown pill */}
          <div className="relative shrink-0" ref={tokenDropdownRef}>
            <button
              type="button"
              onClick={() => setTokenDropdownOpen(!tokenDropdownOpen)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer transition-all ${isDark ? "bg-[#1A1A1A] border border-[#2A2A2A] hover:bg-[#222]" : "bg-[#F7F7F7] border border-[#E8E8E8] hover:bg-[#F0F0F0]"}`}
            >
              <Image src={iconPath} alt={tokenLabel} width={20} height={20} className="rounded-full w-5 h-5 flex-none" />
              <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{tokenLabel}</span>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-3.5 h-3.5 transition-transform duration-200 ${isDark ? "text-[#AAA]" : "text-[#555]"} ${tokenDropdownOpen ? "rotate-180" : ""}`}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            <AnimatePresence>
              {tokenDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}
                  className={`absolute right-0 top-full mt-1 z-50 rounded-xl border shadow-lg overflow-hidden min-w-[120px] ${isDark ? "bg-[#222222] border-[#333333]" : "bg-white border-[#E8E8E8]"}`}
                >
                  {SUPPORTED_TOKENS.map((t) => {
                    const tLabel = t === "USDC" ? "BLUSDC" : t;
                    return (
                    <button key={t} type="button"
                      onClick={() => { handleTokenSelect(t); setTokenDropdownOpen(false); }}
                      className={`flex items-center gap-2 w-full px-4 py-2.5 text-[13px] font-medium transition-colors ${selectedToken === t ? "text-[#703AE6]" : isDark ? "text-white hover:bg-[#333]" : "text-[#111] hover:bg-[#F5F5F5]"}`}
                    >
                      <Image src={iconPaths[t] ?? "/coins/xlmbg.png"} alt={tLabel} width={16} height={16} className="rounded-full" />
                      {tLabel}
                    </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        {/* USD equivalent of the entered amount (matches the earn supply/withdraw UX) */}
        <div className="px-3 -mt-1 pb-1">
          <span className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
            ≈ {formatUsdValue((parseFloat(value) || 0) * (tokenPriceUsd || 0))}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 pb-3">
          <div className="flex items-center gap-1">
            {DEPOSIT_PERCENTAGES.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={txStatus === "loading"}
                onClick={() => { setValue(((tokenBalance * pct) / 100).toFixed(2)); }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                transition={{ duration: 0.1 }}
                className={`px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                  isDark
                    ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                    : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                } ${txStatus === "loading" ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
          <span
            className={`text-[11px] font-medium underline cursor-pointer shrink-0 ${isDark ? "text-[#555555]" : "text-[#AAAAAA]"}`}
            onClick={handleMaxClick}
          >
            Balance: {loadingMarginTokenBalance ? "..." : tokenBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {token}
          </span>
        </div>
      </div>

      {/* Margin account warning */}
      {userAddress && !marginAccountAddress && (
        <div className={`w-full rounded-xl p-3 border text-[12px] font-medium ${isDark ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-500" : "bg-yellow-50 border-yellow-200 text-yellow-700"}`}>
          A margin account is required to supply to Blend. Please create one in the Margin section.
        </div>
      )}

      <AnimatePresence>
        {parseFloat(value) > 0 && (
          <DepositSummary
            tokenSymbol={tokenLabel}
            depositAmount={depositAmountNum}
            tokenPriceUsd={tokenPriceUsd}
            supplyApyPct={supplyApyPct}
            fromBorrowAmount={depositAttribution.fromBorrow}
            fromOwnCollateralAmount={depositAttribution.fromOwn}
          />
        )}
      </AnimatePresence>

      <Button
        disabled={isSubmitDisabled}
        type="solid"
        size="large"
        text={getButtonText()}
        onClick={handleDeposit}
      />
    </div>
  );
});
