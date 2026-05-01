"use client";

import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";

export const LitePositionCard = () => {
  const { isDark } = useTheme();
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);

  const hasPosition = totalCollateralValue > 0 || totalBorrowedValue > 0;
  if (!hasPosition) return null;

  const netValue = totalCollateralValue - totalBorrowedValue;
  const healthFactor =
    avgHealthFactor > 0
      ? avgHealthFactor
      : totalBorrowedValue > 0
      ? totalCollateralValue / totalBorrowedValue
      : Number.POSITIVE_INFINITY;

  const healthLabel =
    healthFactor === Number.POSITIVE_INFINITY
      ? "Safe"
      : healthFactor >= 1.5
      ? "Safe"
      : healthFactor >= 1.2
      ? "Caution"
      : "At Risk";

  const cardBg = isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]";
  const headingText = isDark ? "text-white" : "text-[#111111]";
  const labelText = isDark ? "text-[#919191]" : "text-[#76737B]";
  const valueText = isDark ? "text-white" : "text-[#111111]";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={`w-full border rounded-xl p-4 sm:p-5 ${cardBg}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className={`text-[14px] font-semibold ${headingText}`}>Position Summary</h3>
        <span className="text-[11px] px-2 py-1 rounded-full bg-gradient text-white font-semibold">
          {healthLabel}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border border-white/10 p-3">
          <div className={`text-[11px] ${labelText}`}>Collateral</div>
          <div className={`text-[16px] font-semibold ${valueText}`}>
            ${totalCollateralValue.toFixed(2)}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 p-3">
          <div className={`text-[11px] ${labelText}`}>Borrowed</div>
          <div className={`text-[16px] font-semibold ${valueText}`}>
            ${totalBorrowedValue.toFixed(2)}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 p-3">
          <div className={`text-[11px] ${labelText}`}>Net Value</div>
          <div className={`text-[16px] font-semibold ${valueText}`}>
            ${netValue.toFixed(2)}
          </div>
        </div>
      </div>

      <p className={`mt-3 text-[12px] ${labelText}`}>
        Advanced partial-exit actions are disabled in this backend snapshot.
      </p>
    </motion.div>
  );
};
