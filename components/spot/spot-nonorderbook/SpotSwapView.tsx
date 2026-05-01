"use client";

import { useTheme } from "@/contexts/theme-context";
import { useState } from "react";
import { SwapCard } from "./SwapCard";
import { MOCK_DEXES } from "./mock-data";

interface SpotSwapViewProps {
  baseSymbol?: string;
  onSwitchToOrderbook?: () => void;
}

export const SpotSwapView = ({
  baseSymbol,
  onSwitchToOrderbook,
}: SpotSwapViewProps) => {
  const { isDark } = useTheme();
  const [selectedDex, setSelectedDex] = useState("soroswap");

  return (
    <div
      className={`w-full flex flex-col items-center px-3 sm:px-4 pt-8 pb-10 sm:pt-12 sm:pb-14 ${
        isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"
      }`}
    >
      {/* Background glow effect */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute top-[15%] left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-[0.04]"
          style={{
            background:
              "radial-gradient(circle, #703AE6 0%, transparent 70%)",
          }}
        />
        <div
          className="absolute top-[20%] left-[40%] w-[400px] h-[400px] rounded-full opacity-[0.03]"
          style={{
            background:
              "radial-gradient(circle, #FC5457 0%, transparent 70%)",
          }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-[480px]">
        <SwapCard
          baseSymbol={baseSymbol}
          selectedDex={selectedDex}
          dexes={MOCK_DEXES}
          onDexChange={setSelectedDex}
          onSwitchToOrderbook={onSwitchToOrderbook}
        />
      </div>
    </div>
  );
};
