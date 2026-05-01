import { PieChart } from "./pie-chart";
import { useTheme } from "@/contexts/theme-context";
import { InfoCircleIcon, LinkIcon, CopyIcon } from "@/components/icons";

interface StatsCardProps {
  percentage?: number;
  heading: string;
  mainInfo?: string;
  subInfo?: string;
  pie?: boolean;
  tooltip?: string;
  address?: string;
  fullAddress?: string;
  explorerUrl?: string;
}

export const StatsCard = ({
  percentage,
  heading,
  mainInfo,
  subInfo,
  pie,
  address,
  fullAddress,
  explorerUrl,
}: StatsCardProps) => {
  const { isDark } = useTheme();
  if (pie && percentage) {
    return (
      <div className={`w-full h-fit rounded-[12px] py-4 sm:py-[32px] px-3 sm:px-[20px] flex ${
        isDark ? "bg-[#222222]" : "bg-[#FFFFFF]"
      }`}>
        <div className="w-full h-fit flex gap-3 sm:gap-[16px] items-center">
          <div className="w-[60px] h-[60px] sm:w-[78.65px] sm:h-[78.65px] flex-shrink-0">
            <PieChart
              percentage={percentage}
              textSize="text-[11px] sm:text-[13px] font-medium"
            />
          </div>

          <div className="w-fit h-fit flex flex-col gap-[6px] min-w-0">
            <div className={`w-fit h-fit flex gap-[4px] items-center text-[11px] font-medium ${
              isDark ? "text-[#919191]" : "text-[#5C5B5B]"
            }`}>
              {heading}
              <div className="cursor-pointer w-[12px] h-[12px] flex items-center">
                <InfoCircleIcon />
              </div>
            </div>
            <div className="w-full h-fit flex flex-col gap-[2px]">
              {mainInfo && (
                <div className={`text-[13px] sm:text-[15px] font-semibold break-words ${
                  isDark ? "text-white" : "text-[#111111]"
                }`}>
                  {mainInfo}
                </div>
              )}
              {subInfo && (
                <div className={`text-[11px] font-medium ${
                  isDark ? "text-[#919191]" : "text-[#5C5B5B]"
                }`}>
                  {subInfo}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cols-span-1 row-span-1 w-full h-fit py-[14px]">
      <div className="w-fit h-fit flex flex-col gap-[6px]">
        <div className={`w-fit h-fit flex gap-[4px] items-center text-[11px] font-medium ${
          isDark ? "text-[#919191]" : "text-[#5C5B5B]"
        }`}>
          {heading}
          <div className="cursor-pointer w-[12px] h-[12px] flex items-center">
            <InfoCircleIcon />
          </div>
        </div>
        <div className="w-full h-fit flex flex-col gap-[2px]">
          <div className={`text-[14px] sm:text-[15px] font-semibold ${
            isDark ? "text-white" : "text-[#111111]"
          }`}>
            {mainInfo}
          </div>
          <div className={`text-[11px] font-medium ${
            isDark ? "text-[#919191]" : "text-[#5C5B5B]"
          }`}>
            {subInfo}
          </div>
          {address && (
            <div className="flex gap-[8px] items-center">
              <div className={`text-[15px] font-semibold ${
                isDark ? "text-white" : "text-[#111111]"
              }`}>
                {address.slice(0, 6)}...{address.slice(-4)}
              </div>
              <div className="w-fit h-fit flex gap-[5px]">
                {explorerUrl && fullAddress ? (
                  <a href={`${explorerUrl}/address/${fullAddress}`} target="_blank" rel="noopener noreferrer" className="cursor-pointer w-[12px] h-[12px] flex items-center">
                    <LinkIcon fill={isDark ? "#FFFFFF" : "#111111"} />
                  </a>
                ) : (
                  <div className="cursor-pointer w-[12px] h-[12px] flex items-center">
                    <LinkIcon fill={isDark ? "#FFFFFF" : "#111111"} />
                  </div>
                )}
                <div className="cursor-pointer w-[12px] h-[12px] flex items-center" onClick={() => fullAddress && navigator.clipboard.writeText(fullAddress)}>
                  <CopyIcon stroke={isDark ? "#FFFFFF" : "#111111"} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
