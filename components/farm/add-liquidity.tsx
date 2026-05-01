"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useFarmStore } from "@/store/farm-store";
import { Button } from "../ui/button";
import { BlendService, BLEND_POOL_ASSETS } from "@/lib/blend-utils";
import { AquariusService, AquariusPoolStats } from "@/lib/aquarius-utils";
import { SoroswapService, SoroswapPoolStats } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { MarginAccountService } from "@/lib/margin-utils";
import { iconPaths } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { InfoCard } from "../margin/info-card";
import { MARGIN_ACCOUNT_INFO_ITEMS } from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { useBlendPoolStats } from "@/hooks/use-farm";
import { useBlendStore } from "@/store/blend-store";
import { appendFarmHistory, buildFarmPoolKey } from "@/lib/farm-history";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

const SUPPORTED_TOKENS = ["XLM", "USDC"] as const;
type TokenSymbol = (typeof SUPPORTED_TOKENS)[number];

export const AddLiquidity = memo(function AddLiquidity() {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const selectedRow = useFarmStore((state) => state.selectedRow);
  const tabType = useFarmStore((state) => state.tabType);
  const isAquariusPool =
    tabType === "multi" &&
    ((selectedRow?.cell?.[1] as any)?.title?.toLowerCase?.() === "aquarius" ||
      (selectedRow?.cell?.[0] as any)?.tags?.includes?.("Aquarius"));

  const isSoroswapPool =
    tabType === "multi" &&
    ((selectedRow?.cell?.[1] as any)?.title?.toLowerCase?.() === "soroswap" ||
      (selectedRow?.cell?.[0] as any)?.tags?.includes?.("Soroswap"));

  const poolTokens =
    (selectedRow?.cell?.[0] as any)?.titles?.map((t: string) => t.toUpperCase()) ?? ["XLM", "USDC"];
  const tokenA = poolTokens[0] ?? "XLM";
  const tokenB = poolTokens[1] ?? "USDC";

  // Determine initial token from store (for single asset / lending rows)
  const getInitialToken = useCallback((): TokenSymbol => {
    if (tabType === "single" && selectedRow) {
      const firstCell = selectedRow.cell?.[0] as any;
      const title = (firstCell?.title as string | undefined)?.toUpperCase();
      if (title && SUPPORTED_TOKENS.includes(title as TokenSymbol)) {
        return title as TokenSymbol;
      }
    }
    return "XLM";
  }, [tabType, selectedRow]);

  const triggerBlendRefresh = useBlendStore((s) => s.triggerRefresh);

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
  const [marginXlmBalance, setMarginXlmBalance] = useState<string>("0");
  const [marginUsdcBalance, setMarginUsdcBalance] = useState<string>("0");
  const [loadingMarginBalances, setLoadingMarginBalances] = useState(false);

  const refreshDexMarginBalances = useCallback(
    async (retryCount = 1, retryDelayMs = 1200) => {
      if ((!isAquariusPool && !isSoroswapPool) || !marginAccountAddress) return;

      setLoadingMarginBalances(true);
      try {
        for (let attempt = 0; attempt < retryCount; attempt++) {
          const [xlm, usdc] = isSoroswapPool
            ? await Promise.all([
                SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, "XLM"),
                SoroswapService.getMarginAccountTokenBalance(marginAccountAddress, "USDC"),
              ])
            : await Promise.all([
                AquariusService.getMarginAccountTokenBalance(marginAccountAddress, "XLM"),
                AquariusService.getMarginAccountTokenBalance(marginAccountAddress, "USDC"),
              ]);

          setMarginXlmBalance(xlm);
          setMarginUsdcBalance(usdc);

          if (attempt < retryCount - 1) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      } finally {
        setLoadingMarginBalances(false);
      }
    },
    [isAquariusPool, isSoroswapPool, marginAccountAddress]
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
      // Fetch pool stats for ratio calculation
      AquariusService.getAquariusPoolStats(CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL)
        .then(setAquariusPoolStats)
        .catch(() => setAquariusPoolStats(null));
      setSoroswapPoolStats(null);
      return;
    }

    if (isSoroswapPool) {
      setAquariusRegistryMissing(false);
      SoroswapService.getPoolStats()
        .then(setSoroswapPoolStats)
        .catch(() => setSoroswapPoolStats(null));
      setAquariusPoolStats(null);
    }
  }, [isAquariusPool, isSoroswapPool]);

  // Auto-calculate tokenB when user types tokenA (and vice versa)
  const handleAmountAChange = (val: string) => {
    setAmountA(val);
    const parsed = parseFloat(val);
    // For Aquarius get_reserves() token order is [USDC, XLM] (sorted by address),
    // while this panel token order is [XLM, USDC]. Map reserves by symbol first.
    const xlmReserve = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveXLM ?? "0")
      : parseFloat(aquariusPoolStats?.reserveB ?? "0");
    const usdcReserve = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveUSDC ?? "0")
      : parseFloat(aquariusPoolStats?.reserveA ?? "0");
    const reserveA = tokenA === "XLM" ? xlmReserve : usdcReserve;
    const reserveB = tokenB === "USDC" ? usdcReserve : xlmReserve;

    if (!isNaN(parsed) && parsed > 0 && reserveA > 0 && reserveB > 0) {
      const rA = reserveA;
      const rB = reserveB;
      if (rA > 0) setAmountB((parsed * rB / rA).toFixed(2));
    } else if (val === '') {
      setAmountB('');
    }
  };

  const handleAmountBChange = (val: string) => {
    setAmountB(val);
    const parsed = parseFloat(val);
    const xlmReserve = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveXLM ?? "0")
      : parseFloat(aquariusPoolStats?.reserveB ?? "0");
    const usdcReserve = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveUSDC ?? "0")
      : parseFloat(aquariusPoolStats?.reserveA ?? "0");
    const reserveA = tokenA === "XLM" ? xlmReserve : usdcReserve;
    const reserveB = tokenB === "USDC" ? usdcReserve : xlmReserve;

    if (!isNaN(parsed) && parsed > 0 && reserveA > 0 && reserveB > 0) {
      const rA = reserveA;
      const rB = reserveB;
      if (rB > 0) setAmountA((parsed * rA / rB).toFixed(2));
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
      setMarginXlmBalance("0");
      setMarginUsdcBalance("0");
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

  const handleAddLiquidity = async () => {
    if (!userAddress || !marginAccountAddress) return;

    const amtA = parseFloat(amountA);
    const amtB = parseFloat(amountB);
    if (isNaN(amtA) || isNaN(amtB) || amtA <= 0 || amtB <= 0) return;

    setTxStatus("loading");
    setTxError("");
    setTxHash("");

    const result = isSoroswapPool
      ? await SoroswapService.addLiquidity(
          userAddress,
          marginAccountAddress,
          amtA,
          amtB
        )
      : await AquariusService.addLiquidity(
          userAddress,
          marginAccountAddress,
          tokenA,
          tokenB,
          amtA,
          amtB
        );

    if (result.success) {
      setTxStatus("success");
      setTxHash(result.hash ?? "");
      appendFarmHistory({
        protocol: isSoroswapPool ? "soroswap" : "aquarius",
        poolKey: buildFarmPoolKey(tokenA, tokenB),
        marginAccountAddress,
        action: "add",
        amountDisplay: `${amtA.toFixed(2)} ${tokenA} + ${amtB.toFixed(2)} ${tokenB}`,
        txHash: result.hash ?? "",
      });
      toast.success(`Liquidity added! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
      const nextXlm = Math.max(0, parseFloat(marginXlmBalance || "0") - amtA);
      const nextUsdc = Math.max(0, parseFloat(marginUsdcBalance || "0") - amtB);
      setMarginXlmBalance(nextXlm.toFixed(2));
      setMarginUsdcBalance(nextUsdc.toFixed(2));
      setAmountA("");
      setAmountB("");
      // Refresh canonical balances and pool stats; retries absorb RPC indexing delay.
      refreshDexMarginBalances(3, 1500);
      if (isSoroswapPool) {
        SoroswapService.getPoolStats().then(setSoroswapPoolStats).catch(() => {});
      } else {
        AquariusService.getAquariusPoolStats(CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL)
          .then(setAquariusPoolStats)
          .catch(() => {});
      }

      // Keep store-level data in sync for other pages that derive margin info.
      refreshBorrowedBalances(marginAccountAddress);
      triggerBlendRefresh();
    } else {
      setTxStatus("error");
      const message = result.error ?? "Add liquidity failed";
      setTxError(message);
      toast.error(message);
    }
  };

  const handleDeposit = async () => {
    if (!userAddress || !marginAccountAddress) return;
    const amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) return;

    setTxStatus("loading");
    setTxError("");
    setTxHash("");

    // Deposit from margin account → Blend pool via AccountManager.execute
    const result = await BlendService.depositToBlendPool(
      userAddress,
      marginAccountAddress,
      selectedToken,
      amount
    );

    if (result.success) {
      setTxStatus("success");
      setTxHash(result.hash ?? "");
      appendFarmHistory({
        protocol: "blend",
        poolKey: buildFarmPoolKey(selectedToken),
        marginAccountAddress,
        action: "add",
        amountDisplay: `${amount.toFixed(2)} ${selectedToken}`,
        txHash: result.hash ?? "",
      });
      toast.success(`Deposit successful! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
      setValue("");
      refreshBorrowedBalances(marginAccountAddress);
      // Refresh Blend positions (positions table + events) after a short delay
      // to allow the RPC node to reflect the confirmed transaction state
      setTimeout(() => {
        triggerBlendRefresh();
        BlendService.getUserBlendBalance(marginAccountAddress, selectedToken)
          .then((info) => setBlendBalance(info.underlyingBalance))
          .catch(() => {});
      }, 3000);
    } else {
      setTxStatus("error");
      const errorMsg = result.error ?? "Deposit failed";
      setTxError(errorMsg);
      toast.error(errorMsg);
    }
  };

  const poolAsset = BLEND_POOL_ASSETS.find((a) => a.symbol === selectedToken);
  const iconPath = poolAsset?.iconPath ?? iconPaths[selectedToken] ?? "/icons/stellar.svg";

  const isInputValid = parseFloat(value) > 0 && !isNaN(parseFloat(value));
  const blendDeployed = parseFloat(blendBalance);
  const availableToDeployNum = parseFloat(marginTokenBalance || "0");
  const availableToDeployStr = availableToDeployNum.toFixed(2);
  const isOverBalance = parseFloat(value) > availableToDeployNum;
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
    if (txStatus === "loading") return "Depositing...";
    if (!isInputValid) return "Enter Amount";
    if (isOverBalance) return "Insufficient Available Balance";
    return `Deposit ${selectedToken}`;
  };

  if (isAquariusPool || isSoroswapPool) {
    const dexName = isSoroswapPool ? "Soroswap" : "Aquarius";
    const xlmReserve = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveXLM ?? "0")
      : parseFloat(aquariusPoolStats?.reserveB ?? "0");
    const usdcReserve = isSoroswapPool
      ? parseFloat(soroswapPoolStats?.reserveUSDC ?? "0")
      : parseFloat(aquariusPoolStats?.reserveA ?? "0");
    const reserveA = tokenA === "XLM" ? xlmReserve : usdcReserve;
    const reserveB = tokenB === "USDC" ? usdcReserve : xlmReserve;

    const availableA = tokenA === "XLM" ? marginXlmBalance : marginUsdcBalance;
    const availableB = tokenB === "USDC" ? marginUsdcBalance : marginXlmBalance;
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
      return `Add ${tokenA}/${tokenB} (${dexName})`;
    };

    return (
      <div className="w-full h-fit flex flex-col gap-[16px]">
        <div className={`w-full h-fit p-[20px] rounded-[16px] ${
          isDark ? "bg-[#111111]" : "bg-white"
        }`}>
          {(reserveA > 0 && reserveB > 0) && (
            <div className={`text-[11px] font-medium mb-[4px] ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
              1 {tokenB} ≈ {(reserveA / reserveB).toFixed(2)} {tokenA}
              &nbsp;·&nbsp;
              1 {tokenA} ≈ {(reserveB / reserveA).toFixed(2)} {tokenB}
            </div>
          )}
          <div className="w-full flex flex-col gap-[12px]">
            {[tokenA, tokenB].map((token, idx) => (
              <div
                key={token}
                className={`w-full h-fit flex items-center gap-[12px] p-[12px] rounded-[12px] ${
                  isDark ? "bg-[#1A1A1A]" : "bg-[#F7F7F7]"
                }`}
              >
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
                      {token}
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
            ))}
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

  // Margin account info for InfoCard
  const marginAccountInfo = {
    totalBorrowedValue: useMarginAccountInfoStore.getState().totalBorrowedValue,
    totalCollateralValue: useMarginAccountInfoStore.getState().totalCollateralValue,
    totalValue: useMarginAccountInfoStore.getState().totalValue,
    avgHealthFactor: useMarginAccountInfoStore.getState().avgHealthFactor,
    timeToLiquidation: useMarginAccountInfoStore.getState().timeToLiquidation,
    borrowRate: useMarginAccountInfoStore.getState().borrowRate,
    liquidationPremium: useMarginAccountInfoStore.getState().liquidationPremium,
    liquidationFee: useMarginAccountInfoStore.getState().liquidationFee,
    debtLimit: useMarginAccountInfoStore.getState().debtLimit,
    minDebt: useMarginAccountInfoStore.getState().minDebt,
    maxDebt: useMarginAccountInfoStore.getState().maxDebt,
  };

  // Token selector as inline token pills
  const token = selectedToken;
  const tokenBalance = availableToDeployNum;

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
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
              <Image src={iconPath} alt={token} width={20} height={20} className="rounded-full w-5 h-5 flex-none" />
              <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{token}</span>
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
                  {SUPPORTED_TOKENS.map((t) => (
                    <button key={t} type="button"
                      onClick={() => { handleTokenSelect(t); setTokenDropdownOpen(false); }}
                      className={`flex items-center gap-2 w-full px-4 py-2.5 text-[13px] font-medium transition-colors ${selectedToken === t ? "text-[#703AE6]" : isDark ? "text-white hover:bg-[#333]" : "text-[#111] hover:bg-[#F5F5F5]"}`}
                    >
                      <Image src={iconPaths[t] ?? "/coins/xlmbg.png"} alt={t} width={16} height={16} className="rounded-full" />
                      {t}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
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
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
            <InfoCard data={marginAccountInfo} items={[...MARGIN_ACCOUNT_INFO_ITEMS]} />
          </motion.div>
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
