"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef, memo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useFarmStore } from "@/store/farm-store";
import { Button } from "../ui/button";
import { BlendService, BLEND_POOL_ASSETS } from "@/lib/blend-utils";
import { AquariusService } from "@/lib/aquarius-utils";
import { SoroswapService } from "@/lib/soroswap-utils";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { MarginAccountService } from "@/lib/margin-utils";
import { iconPaths } from "@/lib/constants";
import { PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useBlendStore } from "@/store/blend-store";
import { appendFarmHistory, buildFarmPoolKey } from "@/lib/farm-history";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

const SUPPORTED_TOKENS = ["XLM", "USDC"] as const;
type TokenSymbol = (typeof SUPPORTED_TOKENS)[number];

const PERCENTAGE_OPTIONS = [25, 50, 75, 100] as const;

export const RemoveLiquidity = memo(function RemoveLiquidity() {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const triggerBlendRefresh = useBlendStore((s) => s.triggerRefresh);
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
      ? SoroswapService.getLpBalance(marginAccountAddress)
      : AquariusService.getUserLpBalance(
          marginAccountAddress,
          CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL,
          tokenA,
          tokenB
        );

    fetchLpBalance
      .then(setLpBalance)
      .finally(() => setLoadingLpBalance(false));
  }, [isAquariusPool, isSoroswapPool, marginAccountAddress, tokenA, tokenB]);

  const handleTokenSelect = (token: TokenSymbol) => {
    setSelectedToken(token);
    setValue("");
    setSelectedPercentage(0);
    setTxStatus("idle");
    setTxError("");
  };

  const handlePercentageSelect = (pct: number) => {
    setSelectedPercentage(pct);
    const balance = parseFloat(blendBalance);
    if (!isNaN(balance) && balance > 0) {
      setValue(((balance * pct) / 100).toFixed(2));
    }
  };

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

    setTxStatus("loading");
    setTxError("");
    setTxHash("");

    const result = await BlendService.withdrawFromBlendPool(
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
        action: "remove",
        amountDisplay: `${amount.toFixed(2)} ${selectedToken}`,
        txHash: result.hash ?? "",
      });
      toast.success(`Withdrawal successful! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
      setValue("");
      setSelectedPercentage(0);
      setTimeout(() => {
        triggerBlendRefresh();
        BlendService.getUserBlendBalance(marginAccountAddress, selectedToken).then((info) =>
          setBlendBalance(info.underlyingBalance)
        );
      }, 3000);
    } else {
      setTxStatus("error");
      const errorMsg = result.error ?? "Withdrawal failed";
      setTxError(errorMsg);
      toast.error(errorMsg);
    }
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
    const isOverBalance = lpAmount > lpAvailable;
    const isSubmitDisabled =
      !userAddress ||
      !marginAccountAddress ||
      !isInputValid ||
      isOverBalance ||
      txStatus === "loading";

    const handleMultiDexWithdraw = async () => {
      if (!userAddress || !marginAccountAddress) return;
      const amount = parseFloat(value);
      if (isNaN(amount) || amount <= 0) return;

      setTxStatus("loading");
      setTxError("");
      setTxHash("");

      const result = isSoroswapPool
        ? await SoroswapService.removeLiquidity(
            userAddress,
            marginAccountAddress,
            amount
          )
        : await AquariusService.removeLiquidity(
            userAddress,
            marginAccountAddress,
            tokenA,
            tokenB,
            amount
          );

      if (result.success) {
        setTxStatus("success");
        setTxHash(result.hash ?? "");
        appendFarmHistory({
          protocol: isSoroswapPool ? "soroswap" : "aquarius",
          poolKey: buildFarmPoolKey(tokenA, tokenB),
          marginAccountAddress,
          action: "remove",
          amountDisplay: `${amount.toFixed(2)} LP`,
          txHash: result.hash ?? "",
        });
        toast.success(`Liquidity removed! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
        setValue("");
        setSelectedPercentage(0);
        const refreshLpBalance = isSoroswapPool
          ? SoroswapService.getLpBalance(marginAccountAddress)
          : AquariusService.getUserLpBalance(
              marginAccountAddress,
              CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL
            );
        refreshLpBalance.then(setLpBalance);
        triggerBlendRefresh();
      } else {
        setTxStatus("error");
        const errorMsg = result.error ?? "Remove liquidity failed";
        setTxError(errorMsg);
        toast.error(errorMsg);
      }
    };

    const buttonText = () => {
      if (!userAddress) return "Connect Wallet";
      if (!marginAccountAddress) return "Margin Account Required";
      if (txStatus === "loading") return "Removing Liquidity...";
      if (!isInputValid) return "Enter Amount";
      if (isOverBalance) return "Insufficient LP Balance";
      return `Remove ${tokenA}/${tokenB} (${dexName})`;
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
            <Image src={iconPaths[tokenB] ?? "/icons/stellar.svg"} alt={tokenB} width={16} height={16} />
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
                      setValue(((balance * pct) / 100).toFixed(2));
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
            Available: {loadingBalance ? "..." : totalLiquidity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {token}
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
