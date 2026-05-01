"use client";
import React from "react";

interface Tab {
  id: string;
  label: string;
}

interface OrderTypeTabsProp {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
}

const OrderTypeTabs: React.FC<OrderTypeTabsProp> = ({
  tabs,
  activeTab,
  onTabChange,
}) => {
  return (
    <div className="flex w-full border-b border-b-[#E2E2E2]">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex-1 py-3 px-6 text-[14px] leading-5 transition-all duration-200 ${
              isActive
                ? "text-[#703AE6] border-b-2 border-[#703AE6] font-semibold"
                : "text-[#A7A7A7] border-b-2 border-transparent hover:text-gray-600 font-medium"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

export default OrderTypeTabs;
