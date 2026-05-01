import { TradingPairInfoStats } from "@/lib/types";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";
import { Dropdown } from "./dropdown";

interface TradingPairInfoProps {
  isOpen: boolean;
  onOpenPairSelector: () => void;
  pair: string;
  market: "spot" | "perps";
  icon: string;
  stats: TradingPairInfoStats[];
}

const TradingPairInfo = ({
  onOpenPairSelector,
  isOpen,
  pair,
  market,
  icon,
  stats,
}: TradingPairInfoProps) => {
  const { isDark } = useTheme();

  return (
    <div className={`border rounded-lg p-4 flex flex-col xl:flex-row flex-1 gap-3 xl:gap-5 ${isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E2E2E2]"}`}>
      <div className="flex gap-5">
        <button
          type="button"
          onClick={onOpenPairSelector}
          className="flex gap-3 px-4 cursor-pointer outline-none"
        >
          <Image src={icon} alt={pair} height={24} width={24} />
          <div>
            <div className={`${isDark ? "text-[#FFFFFF]" : "text-[#111111]"} text-[16px] leading-6 font-semibold`}>
              {pair.toUpperCase()}
            </div>
            <div className={`text-[12px] leading-[18px] font-medium text-left ${isDark ? "text-[#919191]" : "text-[#57585C]"}`}>
              {market}
            </div>
          </div>
          <Image
            src="/icons/down-arrow.svg"
            alt="arrow"
            height={16}
            width={16}
            className={`transition-transform duration-200 ease-in-out ${
              isOpen ? "rotate-180" : "rotate-0"
            }`}
          />
        </button>
        <div className="flex flex-col text-[#01BC8D] ">
          <div className="text-[16px] leading-6 font-semibold">3,377.88</div>
          <div className="flex gap-px">
            <div className="text-[12px] leading-[18px] font-medium">+52.47 </div>
            <div className="text-[12px] leading-[18px] font-medium">(+1.58%)</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 xl:contents">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col gap-1 ">
            <div className="flex items-center gap-1 whitespace-nowrap">
              <span className="text-[#A7A7A7] font-medium text-[12px] leading-[18px]">
                {stat.label}
              </span>
              {stat.dropdown && (
                <Dropdown
                  items={stat.dropdown.items}
                  selectedOption={stat.dropdown.selectedOption}
                  setSelectedOption={stat.dropdown.onSelect}
                  classname={`gap-0.5 font-medium text-[12px] leading-[18px] rounded px-1 ${isDark ? "text-[#FFFFFF] bg-[#222222] border border-[#333333]" : "text-[#111111] bg-white border border-[#E2E2E2]"}`}
                  dropdownClassname="text-[10px] leading-[12px] font-medium"
                />
              )}
            </div>
            <div className={`font-medium text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TradingPairInfo;
