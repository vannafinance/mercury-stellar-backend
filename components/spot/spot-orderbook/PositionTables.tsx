import React, { useState } from "react";
import OpenOrdersTable from "./OpenOrdersTable";
import OrderHistoryTable from "./OrderHistoryTable";
import TradeHistoryTable from "./TradeHistoryTable";
import ActivePositionsTable from "./ActivePositionTable";
import { useUserStore } from "@/store/user";
import { useSpotTradeStore } from "@/store/spot-trade-store";
import { useTheme } from "@/contexts/theme-context";

type TabType =
  | "openOrders"
  | "orderHistory"
  | "tradeHistory"
  | "activePositions";

const PositionTables: React.FC = () => {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const [activeTab, setActiveTab] = useState<TabType>("activePositions");
  const activePositions = useSpotTradeStore((state) => state.activePositions);
  const openOrders = useSpotTradeStore((state) => state.openOrders);

  const activePositionsCount = activePositions.length;
  const openOrdersCount = openOrders.length;

  const tabs = [
    {
      id: "activePositions" as TabType,
      label: "Active Positions",
      count: activePositionsCount,
    },
    {
      id: "openOrders" as TabType,
      label: "Open Orders",
      count: openOrdersCount,
    },
    { id: "orderHistory" as TabType, label: "Order History", count: null },
    { id: "tradeHistory" as TabType, label: "Trade History", count: null },
  ];

  return (
    <div
      className={`w-full h-[388px] rounded-lg overflow-hidden flex flex-col gap-2 ${
        isDark
          ? !userAddress ? "bg-[#111111]" : "bg-[#222222]"
          : !userAddress ? "bg-white" : "bg-[#F7F7F7]"
      }`}
    >
      {/* Tabs Header */}
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`cursor-pointer text-[12px] font-semibold  transition-colors p-2 flex ${
              activeTab === tab.id
                ? "text-[#703AE6] bg-[#F1EBFD] rounded-lg"
                : isDark
                  ? "text-[#FFFFFF] hover:text-gray-300 hover:bg-[#333333]"
                  : "text-[#111111] hover:text-gray-900 hover:bg-gray-50"
            }`}
          >
            <div className="py-[3px]">
              {tab.label}
              {tab.count !== null && `(${tab.count})`}
            </div>
          </button>
        ))}
      </div>

      {/* Content Area */}
      {!userAddress ? (
        <div className={`flex-1 flex items-center justify-center rounded-lg border ${isDark ? "bg-[#111111] border-[#333333]" : "bg-gray-50 border-[#E2E2E2]"}`}>
          <button className="px-4 py-2 bg-[#F1EBFD] text-[#703AE6] font-semibold rounded-lg ">
            Connect your Wallet
          </button>
        </div>
      ) : (
        <>
          {activeTab === "openOrders" && <OpenOrdersTable />}
          {activeTab === "orderHistory" && <OrderHistoryTable />}
          {activeTab === "tradeHistory" && <TradeHistoryTable />}
          {activeTab === "activePositions" && <ActivePositionsTable />}
        </>
      )}
    </div>
  );
};

export default PositionTables;
