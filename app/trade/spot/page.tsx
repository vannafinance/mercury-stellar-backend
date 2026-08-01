"use client";

import dynamic from "next/dynamic";
import OrderBook from "@/components/spot/spot-orderbook/OrderBook";
import OrderPlacementForm from "@/components/spot/spot-orderbook/OrderPlacementForm";
import PositionTables from "@/components/spot/spot-orderbook/PositionTables";
import { Dropdown } from "@/components/ui/dropdown";
import TradingViewChart from "@/components/ui/trading-view-chart";
import { useEffect, useRef, useState } from "react";
import TradingPairInfo from "@/components/ui/TradingPairInfo";
import TradingPairSearch from "@/components/spot/spot-orderbook/TradingPairSearch";
import { useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";

const SpotSwapView = dynamic(
  () => import("@/components/spot/spot-nonorderbook").then((mod) => mod.SpotSwapView),
  { ssr: false }
);

const PROTCOL_OPTIONS = ["Aster", "Avantis"];

const spotStats = [
  { label: "24h High", value: "3,377.55" },
  { label: "24h Low", value: "3,210.10" },
  { label: "24h Change", value: "951.99k" },
  { label: "24h Volume", value: "3.21B" },
  { label: "Market Cap", value: "3.21B" },
];

type SpotMode = "swap" | "orderbook";

const Spot = () => {
  const { isDark } = useTheme();
  const base = "XLM";
  const pair = `${base}USDC`;
  const icon = `/coins/${base.toLowerCase()}.svg`;

  const router = useRouter();
  const [isTradingPairSelectorOpen, setIsTradingPairSelectorOpen] =
    useState(false);
  const tradingPairSelectorRef = useRef<HTMLDivElement>(null);
  const [protocol, setProtocol] = useState("Aster");
  const [spotMode, setSpotMode] = useState<SpotMode>("swap");

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!isTradingPairSelectorOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsTradingPairSelectorOpen(false);
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (
        tradingPairSelectorRef.current &&
        !tradingPairSelectorRef.current.contains(e.target as Node)
      ) {
        setIsTradingPairSelectorOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isTradingPairSelectorOpen]);

  return (
    <main
      className={`w-full min-h-screen ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}
    >
      {/* Swap View */}
      {spotMode === "swap" && (
        <SpotSwapView
          baseSymbol={base}
          onSwitchToOrderbook={() => setSpotMode("orderbook")}
        />
      )}

      {/* Orderbook View */}
      {spotMode === "orderbook" && (
        <div
          className={`w-full px-3 md:px-5 pt-3 md:pt-5 pb-5`}
        >
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_316px] gap-2">
            <div className="flex flex-col flex-1 gap-2">
              <div className="flex flex-col gap-2">
                {/* TradingPairInfo */}
                <div
                  ref={tradingPairSelectorRef}
                  className="flex gap-2 relative z-100"
                >
                  <div className="flex-1">
                    <TradingPairInfo
                      isOpen={isTradingPairSelectorOpen}
                      onOpenPairSelector={() =>
                        setIsTradingPairSelectorOpen((prev) => !prev)
                      }
                      pair={pair}
                      market="spot"
                      icon={icon}
                      stats={spotStats}
                    />
                  </div>

                  {/* Switch to Swap */}
                  <button
                    type="button"
                    onClick={() => setSpotMode("swap")}
                    className={`rounded-lg px-4 flex items-center gap-2 cursor-pointer transition-colors ${
                      isDark
                        ? "bg-[#222222] border border-[#333333] hover:border-[#703AE6]"
                        : "bg-[#F7F7F7] border border-[#E2E2E2] hover:border-[#703AE6]"
                    }`}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M4 6L8 2L12 6" stroke="#703AE6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 10L8 14L4 10" stroke="#703AE6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="text-[12px] font-semibold text-[#703AE6]">Swap</span>
                  </button>

                  {/* Protocol dropdown */}
                  <div
                    className={`rounded-lg p-4 flex gap-5 ${isDark ? "bg-[#222222] border border-[#333333]" : "bg-[#F7F7F7] border border-[#E2E2E2]"}`}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="text-[#A7A7A7] font-medium text-[12px] leading-[18px]">
                        Protocol
                      </div>
                      <Dropdown
                        items={PROTCOL_OPTIONS}
                        selectedOption={protocol}
                        setSelectedOption={(val) => setProtocol(val)}
                        classname={`gap-2 font-medium text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
                        dropdownClassname="text-[12px] leading-[18px] font-medium"
                      />
                    </div>
                  </div>

                  {isTradingPairSelectorOpen && (
                    <div className="absolute top-full left-0 right-0 z-999">
                      <TradingPairSearch
                        onSelectPair={(pair) => {
                          const market =
                            pair.marketType === "spot" ? "spot" : "perps";
                          router.push(
                            `/trade/${market}/${pair.base.toLowerCase()}usdc`
                          );
                          setIsTradingPairSelectorOpen(false);
                        }}
                        onClose={() => setIsTradingPairSelectorOpen(false)}
                      />
                    </div>
                  )}
                </div>

                {/* chart & orderBook */}
                <div className="flex gap-2">
                  <div className="flex-1 rounded-lg">
                    <TradingViewChart />
                  </div>
                  <div
                    className={`w-[224px] h-[541px] rounded-xl ${isDark ? "bg-[#222222] border border-[#333333]" : "bg-[#F7F7F7] border border-[#E2E2E2]"}`}
                  >
                    <OrderBook />
                  </div>
                </div>
              </div>

              {/* position table */}
              <div className="flex flex-col gap-3 rounded-lg">
                <PositionTables />
              </div>
            </div>

            {/* order Placement Form */}
            <div>
              <OrderPlacementForm />
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default Spot;
