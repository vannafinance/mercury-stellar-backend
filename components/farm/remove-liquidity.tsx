"use client";

/**
 * Farm "Remove Liquidity" panel — mirror of add-liquidity for withdrawals.
 * Handles single-asset withdraws from a Blend pool and dual-asset removals from
 * an Aquarius/Soroswap LP pool, with %-of-balance pills and a per-protocol
 * balance source.
 *
 * Two precision guards: the 100% pill pins to the exact balance string (so
 * toFixed drift doesn't trip "Insufficient/Exceeds balance"), and a full
 * Blend withdrawal re-fetches the latest accrued underlying balance immediately
 * before submitting so it targets the true amount including interest.
 */
import Image from "next/image";
import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useFarmStore } from "@/store/farm-store";
import { Button } from "../ui/button";
import { BlendService, BLEND_POOL_ASSETS } from "@/lib/blend-utils";
import { AquariusService, AQUARIUS_POOLS, AquariusSwapSymbol } from "@/lib/aquarius-utils";
import { SoroswapService, SOROSWAP_POOLS, SoroswapSwapSymbol } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { MarginAccountService } from "@/lib/margin-utils";
import { iconPaths } from "@/lib/constants";
import { PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { appendFarmHistory, buildFarmPoolKey } from "@/lib/farm-history";
import { normalizeContractError } from "@/lib/errors/normalize";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

const SUPPORTED_TOKENS = ["XLM", "USDC"] as const;
type TokenSymbol = (typeof SUPPORTED_TOKENS)[number];

const PERCENTAGE_OPTIONS = [25, 50, 75, 100] as const;

/**
 * Memoized remove-liquidity panel. Resolves the selected pool's protocol +
 * tokens from the farm store, loads the relevant balance (Blend underlying or
 * LP token), and dispatches the matching withdraw/remove mutation.
 */
export const RemoveLiquidity = memo(function RemoveLiquidity() {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const selectedRow = useFarmStore((state) => state.selectedRow);
  const tabType = useFarmStore((state) => state.tabType);

  // `selectedRow` lives in a client-side store populated only when navigating
  // here by clicking a row on the Farm list page — a hard reload starts with
  // it empty, which silently misclassified every Aquarius/Soroswap pool as
  // single-asset Blend. Mirrors the URL-derived detection
  // `app/farm/[id]/page.tsx` already uses for its header/tabs (see the
  // matching comment in add-liquidity.tsx). Only used as a fallback when the
  // store is empty, so existing store-driven behavior is unchanged when it
  // IS populated.
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
  // removeLiquidity() call below MUST keep using the raw tokenB, not this.
  const tokenBLabel = tokenB === "USDC" ? (isAquariusPool ? "AqUSDC" : "SoUSDC") : tokenB;

  // Resolve which actual on-chain pool this row is (order-insensitive on
  // tokens) — LP-balance reads and the removeLiquidity call MUST use this
  // pool's own address/tracking symbol, not a hardcoded XLM/USDC default.
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

  useEffect(() => {
    if (!tokenDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (tokenDropdownRef.current && !tokenDropdownRef.current.contains(e.target as Node)) setTokenDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tokenDropdownOpen]);
  const [selectedPercentage, setSelectedPercentage] = useState<number>(0);
  const [blendBalance, setBlendBalance] = useState<string>("0");
  const [loadingBalance, setLoadingBalance] = useState<boolean>(false);
  const [lpBalance, setLpBalance] = useState<string>("0");
  const [loadingLpBalance, setLoadingLpBalance] = useState<boolean>(false);
  const [txStatus, setTxStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState<string>("");
  const [txError, setTxError] = useState<string>("");
  const [marginAccountAddress, setMarginAccountAddress] = useState<string | null>(null);
  const [blendConfigured, setBlendConfigured] = useState<boolean | null>(null);
  // Aquarius is always usable via hardcoded fallback — no Registry gate needed

  // Check if Blend pool is configured in Registry (once on mount)
  useEffect(() => {
    if (!isAquariusPool && !isSoroswapPool) {
      BlendService.isBlendPoolConfigured()
        .then(setBlendConfigured)
        .catch(() => setBlendConfigured(false));
    }
  }, [isAquariusPool, isSoroswapPool]);

  // Load margin account
  useEffect(() => {
    if (!userAddress) {
      setMarginAccountAddress(null);
      return;
    }
    const stored = MarginAccountService.getStoredMarginAccount(userAddress);
    setMarginAccountAddress(stored?.address ?? null);
  }, [userAddress]);

  // Fetch Blend balance when margin account or token changes
  useEffect(() => {
    if (!marginAccountAddress) {
      setBlendBalance("0");
      return;
    }
    setLoadingBalance(true);
    BlendService.getUserBlendBalance(marginAccountAddress, selectedToken)
      .then((info) => setBlendBalance(info.underlyingBalance))
      .catch(() => setBlendBalance("0"))
      .finally(() => setLoadingBalance(false));
  }, [marginAccountAddress, selectedToken]);

  useEffect(() => {
    if ((!isAquariusPool && !isSoroswapPool) || !marginAccountAddress) {
      setLpBalance("0");
      return;
    }
    setLoadingLpBalance(true);
    const fetchLpBalance = isSoroswapPool
      ? SoroswapService.getLpBalance(
          marginAccountAddress,
          matchedSoroswapPoolConfig?.trackingSymbol,
          matchedSoroswapPoolConfig?.pairAddress,
        )
      : AquariusService.getUserLpBalance(
          marginAccountAddress,
          matchedAquariusPoolConfig?.poolAddress ?? CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL,
          tokenA,
          tokenB
        );

    fetchLpBalance
      .then(setLpBalance)
      .finally(() => setLoadingLpBalance(false));
  }, [isAquariusPool, isSoroswapPool, marginAccountAddress, tokenA, tokenB, matchedSoroswapPoolConfig, matchedAquariusPoolConfig]);

  const handleTokenSelect = (token: TokenSymbol) => {
    setSelectedToken(token);
    setValue("");
    setSelectedPercentage(0);
    setTxStatus("idle");
    setTxError("");
  };

  const handlePercentageSelect = (pct: number) => {
    setSelectedPercentage(pct);
    // Aquarius / Soroswap rows are LP-token positions; their balance lives in
    // `lpBalance`, not `blendBalance`. Using blendBalance here would overshoot
    // the LP cap and trigger "Insufficient LP balance" even on a clean 100%.
    const sourceBalanceStr = (isAquariusPool || isSoroswapPool) ? lpBalance : blendBalance;
    const balance = parseFloat(sourceBalanceStr);
    if (!isNaN(balance) && balance > 0) {
      // For 100% pin to the exact balance string so any trailing-precision
      // drift (e.g. 8.85 vs 8.8499999) doesn't push the input over the cap.
      const next = pct === 100 ? sourceBalanceStr : ((balance * pct) / 100).toFixed(2);
      setValue(next);
    }
  };

  const qc = useQueryClient();

  const withdrawFromBlendMutation = useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      const result = await BlendService.withdrawFromBlendPool(
        userAddress!,
        marginAccountAddress!,
        selectedToken,
        amount,
      );
      if (!result.success) {
        throw new Error(result.error ?? "Withdrawal failed");
      }
      return { ...result, amount };
    },
    onMutate: () => {
      setTxStatus("loading");
      setTxError("");
      setTxHash("");
    },
    onSuccess: ({ hash, amount }) => {
      setTxStatus("success");
      setTxHash(hash ?? "");
      appendFarmHistory({
        protocol: "blend",
        poolKey: buildFarmPoolKey(selectedToken),
        marginAccountAddress: marginAccountAddress!,
        action: "remove",
        amountDisplay: `${amount.toFixed(2)} ${selectedToken}`,
        txHash: hash ?? "",
      });
      toast.success(`Withdrawal successful! Tx: ${hash ? hash.slice(0, 16) + '…' : ''}`);
      setValue("");
      setSelectedPercentage(0);
      qc.invalidateQueries({ queryKey: ['farm'] });
      setTimeout(() => {
        BlendService.getUserBlendBalance(marginAccountAddress!, selectedToken).then((info) =>
          setBlendBalance(info.underlyingBalance),
        ).catch(() => {});
      }, 3000);
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Withdrawal failed");
      setTxError(errorMsg);
      toast.error(errorMsg);
    },
  });

  const removeMultiDexMutation = useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      const result = isSoroswapPool
        ? await SoroswapService.removeLiquidity(
            userAddress!, marginAccountAddress!, amount,
            tokenA as SoroswapSwapSymbol, tokenB as SoroswapSwapSymbol,
          )
        : await AquariusService.removeLiquidity(userAddress!, marginAccountAddress!, tokenA, tokenB, amount);
      if (!result.success) {
        throw new Error(result.error ?? "Remove liquidity failed");
      }
      return { ...result, amount };
    },
    onMutate: () => {
      setTxStatus("loading");
      setTxError("");
      setTxHash("");
    },
    onSuccess: ({ hash, amount }) => {
      setTxStatus("success");
      setTxHash(hash ?? "");
      appendFarmHistory({
        protocol: isSoroswapPool ? "soroswap" : "aquarius",
        poolKey: buildFarmPoolKey(tokenA, tokenB),
        marginAccountAddress: marginAccountAddress!,
        action: "remove",
        amountDisplay: `${amount.toFixed(2)} LP`,
        txHash: hash ?? "",
      });
      toast.success(`Liquidity removed! Tx: ${hash ? hash.slice(0, 16) + '…' : ''}`);
      setValue("");
      setSelectedPercentage(0);
      qc.invalidateQueries({ queryKey: ['farm'] });
      try {
        if (marginAccountAddress) refreshBorrowedBalances(marginAccountAddress);
      } catch (err) {
        console.warn("Post-remove balance refresh failed; ledger tick will reconcile.", err);
      }
      const refreshLpBalance = isSoroswapPool
        ? SoroswapService.getLpBalance(
            marginAccountAddress!,
            matchedSoroswapPoolConfig?.trackingSymbol,
            matchedSoroswapPoolConfig?.pairAddress,
          )
        : AquariusService.getUserLpBalance(
            marginAccountAddress!,
            matchedAquariusPoolConfig?.poolAddress ?? CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL,
            tokenA,
            tokenB,
          );
      refreshLpBalance.then(setLpBalance).catch(() => {});
    },
    onError: (error) => {
      setTxStatus("error");
      const errorMsg = normalizeContractError(error instanceof Error ? error.message : undefined, "Remove liquidity failed");
      setTxError(errorMsg);
      toast.error(errorMsg);
    },
  });

  const handleWithdraw = async () => {
    if (!userAddress || !marginAccountAddress) return;
    let amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) return;

    const displayedAvailable = parseFloat(blendBalance) || 0;
    const isFullWithdrawalIntent =
      selectedPercentage === 100 || Math.abs(amount - displayedAvailable) < 0.0000001;

    // For 100% remove, fetch the latest underlying balance right before tx
    // so the call targets the full accrued amount (including interest updates).
    if (isFullWithdrawalIntent) {
      try {
        const latest = await BlendService.getUserBlendBalance(marginAccountAddress, selectedToken);
        const latestUnderlying = parseFloat(latest.underlyingBalance);
        if (!isNaN(latestUnderlying) && latestUnderlying > 0) {
          amount = latestUnderlying;
          setValue(latestUnderlying.toFixed(7));
        }
      } catch (err) {
        console.warn("[RemoveLiquidity] Failed to refresh latest Blend balance before full withdraw:", err);
      }
    }

    withdrawFromBlendMutation.mutate({ amount });
  };

  const poolAsset = BLEND_POOL_ASSETS.find((a) => a.symbol === selectedToken);
  const iconPath = poolAsset?.iconPath ?? iconPaths[selectedToken] ?? "/icons/stellar.svg";

  const isInputValid = parseFloat(value) > 0 && !isNaN(parseFloat(value));
  const isOverBalance = parseFloat(value) > parseFloat(blendBalance);
  const isSubmitDisabled =
    !userAddress ||
    !marginAccountAddress ||
    blendConfigured === false ||
    !isInputValid ||
    isOverBalance ||
    txStatus === "loading";

  const buttonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!marginAccountAddress) return "Margin Account Required";
    if (blendConfigured === false) return "Blend Pool Not Configured";
    if (txStatus === "loading") return "Withdrawing...";
    if (!isInputValid) return "Enter Amount";
    if (isOverBalance) return "Insufficient Balance";
    return `Withdraw ${selectedToken}`;
  };

  if (isAquariusPool || isSoroswapPool) {
    const dexName = isSoroswapPool ? "Soroswap" : "Aquarius";
    const lpAmount = parseFloat(value);
    const lpAvailable = parseFloat(lpBalance);
    const isInputValid = lpAmount > 0 && !isNaN(lpAmount);
    // Allow a tiny epsilon (1e-7 = one stroop) so float reformatting like
    // toFixed(2) round-up doesn't tag a legitimate full-balance withdrawal
    // as "exceeds LP balance".
    const isOverBalance = lpAmount > lpAvailable + 1e-7;
    const isSubmitDisabled =
      !userAddress ||
      !marginAccountAddress ||
      !isInputValid ||
      isOverBalance ||
      txStatus === "loading";

    const handleMultiDexWithdraw = () => {
      if (!userAddress || !marginAccountAddress) return;
      const amount = parseFloat(value);
      if (isNaN(amount) || amount <= 0) return;
      removeMultiDexMutation.mutate({ amount });
    };

    const buttonText = () => {
      if (!userAddress) return "Connect Wallet";
      if (!marginAccountAddress) return "Margin Account Required";
      if (txStatus === "loading") return "Removing Liquidity...";
      if (!isInputValid) return "Enter Amount";
      if (isOverBalance) return "Insufficient LP Balance";
      return `Remove ${tokenA}/${tokenBLabel} (${dexName})`;
    };

    return (
      <div className="w-full h-fit flex flex-col gap-[16px]">
        <div className={`w-full h-fit rounded-[12px] p-[14px] flex justify-between items-center ${
          isDark ? "bg-[#1A1A1A]" : "bg-[#F7F7F7]"
        }`}>
          <span className={`text-[12px] font-medium ${
            isDark ? "text-[#919191]" : "text-[#76737B]"
          }`}>
            Your {dexName} LP Balance
          </span>
          <div className="flex items-center gap-[6px]">
            <Image src={iconPaths[tokenA] ?? "/icons/stellar.svg"} alt={tokenA} width={16} height={16} />
            <Image src={iconPaths[tokenB] ?? "/icons/stellar.svg"} alt={tokenBLabel} width={16} height={16} />
            <span className={`text-[13px] font-semibold ${
              isDark ? "text-white" : "text-[#111111]"
            }`}>
              {loadingLpBalance
                ? "Loading..."
                : `${parseFloat(lpBalance).toFixed(2)} LP`}
            </span>
          </div>
        </div>

        <div className={`w-full h-fit flex rounded-[16px] gap-[8px] p-[20px] ${
          isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"
        }`}>
          <div className="w-full h-fit flex flex-col gap-[16px]">
            <div className="flex flex-col gap-[6px]">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                className={`w-full h-fit text-[20px] font-semibold placeholder:opacity-20 outline-none border-none bg-transparent ${
                  isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
                }`}
                value={value}
                onChange={(e) => {
                  const sanitized = validateAmountChange(e.target.value);
                  if (sanitized === null) return;
                  setValue(sanitized);
                  setSelectedPercentage(0);
                }}
              />
              <div className={`text-[11px] font-medium ${
                isDark ? "text-[#919191]" : "text-[#76737B]"
              }`}>
                {isOverBalance ? (
                  <span className="text-red-500">Exceeds LP balance</span>
                ) : (
                  "$0.00"
                )}
              </div>
            </div>
            <div className="flex gap-[8px]">
              {PERCENTAGE_OPTIONS.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => {
                    setSelectedPercentage(pct);
                    const balance = parseFloat(lpBalance);
                    if (!isNaN(balance) && balance > 0) {
                      // 100% pins to the exact balance string so trailing
                      // precision (e.g. lpBalance "8.8499999" rounded to
                      // "8.85" via toFixed(2)) doesn't push us above the
                      // cap and trip "Exceeds LP balance".
                      const next = pct === 100
                        ? lpBalance
                        : ((balance * pct) / 100).toFixed(2);
                      setValue(next);
                    }
                  }}
                  className={`px-[10px] py-[6px] rounded-[8px] text-[12px] font-semibold ${
                    selectedPercentage === pct
                      ? "bg-[#703AE6] text-white"
                      : isDark
                      ? "bg-[#1A1A1A] text-[#C7C7C7]"
                      : "bg-[#F2F2F2] text-[#555555]"
                  }`}
                  style={{
                    boxShadow: selectedPercentage === pct ? `0 0 0 1px ${PERCENTAGE_COLORS[pct]}` : "none",
                  }}
                >
                  {pct}%
                </button>
              ))}
            </div>
          </div>
        </div>


        <Button
          text={buttonText()}
          size="large"
          type="solid"
          disabled={isSubmitDisabled}
          onClick={handleMultiDexWithdraw}
        />
      </div>
    );
  }

  const token = selectedToken;
  // Display-only — selectedToken itself stays the raw "XLM"/"USDC" used by
  // every BlendService call above.
  const tokenLabel = token === "USDC" ? "BLUSDC" : token;
  const totalLiquidity = parseFloat(blendBalance);

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (txStatus === "loading") return "Processing...";
    if (parseFloat(value) <= 0 || !value) return "Enter Amount";
    if (parseFloat(value) > parseFloat(blendBalance)) return "Insufficient Balance";
    return "Remove Liquidity";
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
            className={`flex-1 min-w-0 bg-transparent outline-none text-[20px] font-semibold placeholder:opacity-20 ${isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"}`}
            value={value}
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
              setSelectedPercentage(0);
            }}
            disabled={txStatus === "loading"}
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
        <div className="flex items-center justify-between px-3 pb-3">
          <div className="flex items-center gap-1">
            {PERCENTAGE_OPTIONS.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={txStatus === "loading"}
                onClick={() => handlePercentageSelect(pct)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                transition={{ duration: 0.1 }}
                className={`px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                  selectedPercentage === pct
                    ? `${PERCENTAGE_COLORS[pct] || "bg-[#703AE6]"} text-white border-transparent`
                    : isDark
                      ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                      : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                } ${txStatus === "loading" ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
          <span className={`text-[11px] font-medium shrink-0 ${isDark ? "text-[#555555]" : "text-[#AAAAAA]"}`}>
            Available: {loadingBalance ? "..." : totalLiquidity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {tokenLabel}
          </span>
        </div>
      </div>

      {/* Margin account warning */}
      {userAddress && !marginAccountAddress && (
        <div className={`w-full rounded-xl p-3 border text-[12px] font-medium ${isDark ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-500" : "bg-yellow-50 border-yellow-200 text-yellow-700"}`}>
          A margin account is required to withdraw from Blend. Please create one in the Margin section.
        </div>
      )}

      <Button
        disabled={isSubmitDisabled}
        type="solid"
        size="large"
        text={getButtonText()}
        onClick={handleWithdraw}
      />
    </div>
  );
});
