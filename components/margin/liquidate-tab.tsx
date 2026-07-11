"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { MarginAccountService } from "@/lib/margin-utils";
import { getAddress } from "@/lib/wallet-adapter";
import { useTheme } from "@/contexts/theme-context";
import toast from "react-hot-toast";
import { normalizeContractError } from "@/lib/errors/normalize";

const LIQUIDATION_THRESHOLD = 1.1;
const HF_INF_SENTINEL = 999;

const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INF_SENTINEL ? "∞" : hf.toFixed(2);

interface AccountHealthInfo {
  marginAccountAddress: string;
  avgHealthFactor: number;
  totalBorrowedValue: number;
  grossCollateralValue: number;
  hasMarginAccount: boolean;
}

export const LiquidateTab = () => {
  const { isDark } = useTheme();
  const [targetAddress, setTargetAddress] = useState("");
  const [healthInfo, setHealthInfo] = useState<AccountHealthInfo | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const isValidAddress = targetAddress.trim().length >= 50;
  const isLiquidatable =
    healthInfo?.hasMarginAccount &&
    healthInfo.avgHealthFactor > 0 &&
    healthInfo.avgHealthFactor < LIQUIDATION_THRESHOLD;

  // Check health factor of target account
  const checkMutation = useMutation({
    mutationFn: async () => {
      setCheckError(null);
      setHealthInfo(null);
      const addr = targetAddress.trim();

      // Block self-liquidation before even hitting the API
      const { address: walletAddr } = await getAddress();
      if (walletAddr) {
        const ownAccount = await MarginAccountService.discoverExistingAccount(walletAddr);
        if (ownAccount && ownAccount === addr) {
          throw new Error("You cannot liquidate your own margin account.");
        }
      }

      const res = await fetch(`/api/account/${encodeURIComponent(addr)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<AccountHealthInfo>;
    },
    onSuccess: (data) => {
      if (!data.hasMarginAccount) {
        setCheckError("No margin account found at this address.");
        return;
      }
      setHealthInfo(data);
    },
    onError: (err: Error) => {
      setCheckError(err.message || "Failed to fetch account health.");
    },
  });

  // Execute liquidation
  const liquidateMutation = useMutation({
    mutationFn: async () => {
      const { address: liquidatorAddress, error } = await getAddress();
      if (error || !liquidatorAddress) throw new Error("Connect your wallet first.");

      const smartAccount = healthInfo?.marginAccountAddress ?? targetAddress.trim();

      // Safety net: block self-liquidation even if the button somehow appears
      const ownAccount = await MarginAccountService.discoverExistingAccount(liquidatorAddress);
      if (ownAccount && ownAccount === smartAccount) {
        throw new Error("You cannot liquidate your own margin account.");
      }

      const result = await MarginAccountService.liquidateMarginAccount(
        liquidatorAddress,
        smartAccount
      );
      if (!result.success) throw new Error(result.error ?? "Liquidation failed.");
      return result;
    },
    onSuccess: (result) => {
      toast.success(
        `Account liquidated! Collateral transferred to your wallet.\nTx: ${result.hash?.slice(0, 12)}…`,
        { duration: 8000 }
      );
      setHealthInfo(null);
      setTargetAddress("");
    },
    onError: (err: Error) => {
      const friendly = normalizeContractError(err.message);
      toast.error(friendly || err.message || "Liquidation failed.", { duration: 8000 });
    },
  });

  const hf = healthInfo?.avgHealthFactor ?? 0;
  const hfColor =
    hf <= 0
      ? isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"
      : hf < LIQUIDATION_THRESHOLD
      ? "text-rose-500"
      : "text-emerald-500";

  return (
    <motion.div
      className="flex flex-col gap-4"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      {/* Info banner */}
      <div
        className={`rounded-xl px-4 py-3 text-[13px] leading-relaxed ${
          isDark
            ? "bg-[#1a1a1a] border border-[#333] text-[#A0A0A0]"
            : "bg-[#F3F0FF] border border-[#D8CCFF] text-[#5B3E9E]"
        }`}
      >
        Liquidate any margin account whose Health Factor has fallen below{" "}
        <span className="font-bold">1.1</span>. You pay the outstanding debt
        from your wallet and receive all of the account&apos;s collateral as profit.
      </div>

      {/* Address input */}
      <div className="flex flex-col gap-1.5">
        <label
          className={`text-[12px] font-semibold ${
            isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"
          }`}
        >
          Margin Account Address
        </label>
        <input
          type="text"
          placeholder="C... (margin account contract address)"
          value={targetAddress}
          onChange={(e) => {
            setTargetAddress(e.target.value);
            setHealthInfo(null);
            setCheckError(null);
          }}
          className={`w-full rounded-xl px-4 py-3 text-[13px] outline-none border font-mono ${
            isDark
              ? "bg-[#1a1a1a] border-[#333] text-white placeholder:text-[#555]"
              : "bg-white border-[#E5E7EB] text-[#111] placeholder:text-[#A0A0A0]"
          }`}
        />
      </div>

      {/* Check HF button */}
      <Button
        text={checkMutation.isPending ? "Checking…" : "Check Health Factor"}
        size="medium"
        type="ghost"
        disabled={!isValidAddress || checkMutation.isPending}
        onClick={() => checkMutation.mutate()}
        width="w-full"
      />

      {/* Error from check */}
      <AnimatePresence>
        {checkError && (
          <motion.p
            className="text-[13px] text-rose-500"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {checkError}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Health factor result card */}
      <AnimatePresence>
        {healthInfo && (
          <motion.div
            className={`rounded-xl border px-4 py-4 flex flex-col gap-3 ${
              isDark
                ? "bg-[#1a1a1a] border-[#333]"
                : "bg-[#F7F7F7] border-[#E5E7EB]"
            }`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className="flex justify-between items-center">
              <span
                className={`text-[12px] font-medium ${
                  isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"
                }`}
              >
                Health Factor
              </span>
              <span className={`text-[22px] font-bold ${hfColor}`}>
                {formatHF(hf)}
              </span>
            </div>

            <div className="flex justify-between items-center">
              <span
                className={`text-[12px] font-medium ${
                  isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"
                }`}
              >
                Gross Collateral
              </span>
              <span
                className={`text-[14px] font-semibold ${
                  isDark ? "text-white" : "text-[#111]"
                }`}
              >
                ${healthInfo.grossCollateralValue?.toFixed(2) ?? "0.00"}
              </span>
            </div>

            <div className="flex justify-between items-center">
              <span
                className={`text-[12px] font-medium ${
                  isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"
                }`}
              >
                Total Debt
              </span>
              <span
                className={`text-[14px] font-semibold ${
                  isDark ? "text-white" : "text-[#111]"
                }`}
              >
                ${healthInfo.totalBorrowedValue?.toFixed(2) ?? "0.00"}
              </span>
            </div>

            {/* Status badge */}
            <div
              className={`rounded-lg px-3 py-2 text-center text-[12px] font-semibold ${
                isLiquidatable
                  ? "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
                  : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
              }`}
            >
              {isLiquidatable
                ? "LIQUIDATABLE — Health Factor below 1.1"
                : "Healthy — Cannot be liquidated"}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Liquidate button — only shown when account is liquidatable */}
      <AnimatePresence>
        {isLiquidatable && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <Button
              text={liquidateMutation.isPending ? "Liquidating…" : "Liquidate Account"}
              size="large"
              type="gradient"
              disabled={liquidateMutation.isPending}
              onClick={() => liquidateMutation.mutate()}
              width="w-full"
            />
            <p
              className={`mt-2 text-center text-[11px] ${
                isDark ? "text-[#666]" : "text-[#9CA3AF]"
              }`}
            >
              Your wallet will pay the debt. You receive the collateral.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
