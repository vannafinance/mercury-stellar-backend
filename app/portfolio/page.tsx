"use client";

import { PortfolioSection } from "@/components/portfolio/portfolio-section";
import { useTheme } from "@/contexts/theme-context";

export default function PortfolioPage() {
  const { isDark } = useTheme();

  return (
    <div className="px-4 sm:px-10 lg:px-30 pt-4 sm:pt-6 pb-8 lg:pb-0 w-full h-fit">
      <div className="flex flex-col gap-4 sm:gap-5 w-full h-fit">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 sm:hidden rounded-full bg-[#703AE6]" />
          <h1 className={`text-[22px] sm:text-[24px] font-bold ${isDark ? "text-white" : "text-black"}`}>
            Portfolio
          </h1>
        </div>

        <PortfolioSection />
      </div>
    </div>
  );
}
