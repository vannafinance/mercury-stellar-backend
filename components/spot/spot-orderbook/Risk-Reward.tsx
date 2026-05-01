"use client";

import { RiskRewardRatio } from "@/lib/types";
import { useTheme } from "@/contexts/theme-context";

const RATIOS: RiskRewardRatio[] = ["NA", "1:1", "1:2", "1:3", "2:1", "3:1"];

interface RiskRewardSelectorProps {
  value: RiskRewardRatio;
  customValue: string | null;
  onChange: (value: RiskRewardRatio) => void;
  onCustomChange: (value: string) => void;
  className?: string;
  label?: string;
}

export const RiskRewardSelector = ({
  value,
  customValue,
  onChange,
  onCustomChange,
  className = "",
  label = "RR Ratio",
}: RiskRewardSelectorProps) => {
  const { isDark } = useTheme();
  const isCustom = value === "CUSTOM";

  return (
    <div className={`flex items-center   h-auto ${className}`}>
      {/* Left label */}
      <span className={`text-[10px] leading-[15px] font-medium mr-1 ${isDark ? "text-[#FFFFFF]" : "text-[#000000]"}`}>
        {label}
      </span>

      {/* Pills */}
      <div className="flex flex-1 items-center justify-between gap-0.5 ">
        {RATIOS.map((ratio) => (
          <button
            key={ratio}
            type="button"
            onClick={() => onChange(ratio)}
            className={`
               cursor-pointer rounded-sm text-[10px] leading-3 px-2 py-1  transition
              ${
                value === ratio
                  ? "bg-[#FF007A] text-white border-[#FF007A] font-semibold"
                  : ratio === "1:3"
                  ? "bg-[#FFE6F2]  border-[#FFD1E3]"
                  : " text-[#919191] font-medium "
              }
            `}
          >
            {ratio}
          </button>
        ))}

        {/* <div className=" px-2 py-1">
          <span className="text-[10px] leading-[15px] font-medium text-[#111111]">
            OR
          </span>
        </div> */}

        {/* Custom Input Field */}
        <input
          type="text"
          placeholder="4:1"
          inputMode="numeric"
          className={`
            w-12 h-9 rounded-md border
            text-sm px-2 placeholder:text-[#C6C6C6]
            focus:outline-none focus:ring-1 focus:ring-[#703AE6]
            ${isDark ? "border-[#333333] bg-[#111111] text-[#FFFFFF]" : "border-[#E2E2E2] bg-white"}
          `}
          value={isCustom ? customValue ?? "" : ""}
          onFocus={() => onChange("CUSTOM")}
          onChange={(e) => onCustomChange(e.target.value)}
        />
      </div>
    </div>
  );
};
