import { useState, useEffect, useRef } from "react";
import { AnimatedTabs } from "../ui/animated-tabs";
import { useTheme } from "@/contexts/theme-context";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

interface SupplyApyProps {
  supplyApy: {
    percentage: number;
    greaterThan: boolean;
  };
  setSupplyApyFilter: React.Dispatch<
    React.SetStateAction<{
      percentage: number;
      greaterThan: boolean;
    }>
  >;
  anythingLabel?: string;  // Custom label when percentage is 0
  supplyApyLabel?: string;
}

export const SupplyApy = (props: SupplyApyProps) => {
  const { isDark } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("less-than");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`cursor-pointer w-fit h-fit flex rounded-lg border py-1.5 px-3 items-center gap-2 text-[13px] font-semibold transition-colors ${
          isDark
            ? "bg-[#2A2A2A] border-[#333333] text-[#A7A7A7] hover:text-white"
            : "bg-[#F0F0F0] border-[#E2E2E2] text-[#888888] hover:text-[#555555]"
        }`}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <span>
          {props.supplyApyLabel || "Supply APY is"}
        </span>
        <span className="w-fit h-fit rounded-md px-1.5 py-0.5 bg-[#703AE6]/10 text-[#703AE6] text-[11px] font-semibold">
          {props.supplyApy.percentage > 0 ? (
            props.supplyApy.greaterThan
              ? `>${props.supplyApy.percentage}`
              : `<${props.supplyApy.percentage}`
          ) : (
            props.anythingLabel || "Anything"
          )}
        </span>
      </button>
      {isOpen && (
        <section
          className={`w-[280px] h-fit top-[42px] right-0 absolute rounded-xl p-3 flex flex-col gap-3 z-[9999] border ${
            isDark
              ? "bg-[#1A1A1A] border-[#2A2A2A] shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
              : "bg-white border-[#E8E8E8] shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
          }`}
          aria-label="Supply APY Filter"
        >
          <button
            type="button"
            onClick={() =>
              props.setSupplyApyFilter((prev) => ({
                ...prev,
                percentage: 0,
              }))
            }
            className={`text-end w-full text-[13px] font-semibold underline cursor-pointer hover:text-[#703AE6] transition-colors ${
              isDark ? "text-[#A7A7A7]" : "text-[#888888]"
            }`}
          >
            Reset
          </button>
          <nav className="w-full" aria-label="Filter Type Selection">
            <AnimatedTabs
              tabs={[
                { label: "Greater than", id: "greater-than" },
                { label: "Less than", id: "less-than" },
              ]}
              type="ghost-compact"
              activeTab={activeTab}
              containerClassName={`w-full border ${isDark ? "border-[#2A2A2A]" : "border-[#E2E2E2]"}`}
              tabClassName="flex-1"
              onTabChange={(tab) => {
                setActiveTab(tab);
                if (tab === "greater-than") {
                  props.setSupplyApyFilter((prev) => ({
                    ...prev,
                    greaterThan: true,
                  }));
                } else {
                  props.setSupplyApyFilter((prev) => ({
                    ...prev,
                    greaterThan: false,
                  }));
                }
              }}
            />
          </nav>
          <div className={`flex justify-between items-center w-full h-[36px] rounded-lg border px-3 transition-colors focus-within:border-[#703AE6] ${
            isDark
              ? "bg-[#111111] border-[#2A2A2A]"
              : "bg-[#F7F7F7] border-[#E2E2E2]"
          }`}>
            <label htmlFor="apy-percentage" className="sr-only">
              APY Percentage
            </label>
            <input
              id="apy-percentage"
              type="text"
              inputMode="decimal"
              placeholder="Enter Amount"
              value={props.supplyApy.percentage.toString()}
              onChange={(e) => {
                const sanitized = validateAmountChange(e.target.value);
                if (sanitized === null) return;
                props.setSupplyApyFilter((prev) => ({
                  ...prev,
                  percentage: sanitized === "" ? 0 : Number(sanitized),
                }));
              }}
              className={`outline-none placeholder:text-[#C6C6C6] w-full h-fit text-[13px] font-medium ${
                isDark
                  ? "bg-[#111111] text-white"
                  : "bg-[#F7F7F7] text-[#111111]"
              }`}
              aria-label="APY Percentage Value"
            />
          </div>
        </section>
      )}
    </div>
  );
};
