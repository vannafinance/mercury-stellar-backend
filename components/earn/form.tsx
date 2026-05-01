import { useState } from "react";
import { AnimatedTabs } from "../ui/animated-tabs";
import { SupplyLiquidityTab } from "./supply-liquidity-tab-new";
import { WithdrawLiquidity } from "./withdraw-liqudity";
import { useTheme } from "@/contexts/theme-context";
import { motion, AnimatePresence } from "framer-motion";

const tabs = [
  { label: "Supply Liquidity", id: "supply-liquidity" },
  { label: "Withdraw Liquidity", id: "withdraw-liquidity" },
];

export const Form = () => {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<string>("supply-liquidity");
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {/* Desktop: normal inline form */}
      <section
        className={`hidden xl:flex w-full h-fit rounded-2xl border py-4 px-4 sm:px-5 flex-col gap-4 ${
          isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
        }`}
        aria-label="Liquidity Management"
      >
        <nav className="w-full" aria-label="Liquidity Actions">
          <AnimatedTabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            type="border"
            containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
            tabClassName="!flex-1 !px-2 text-[11px] sm:text-[13px]"
          />
        </nav>
        {activeTab === "supply-liquidity" && <SupplyLiquidityTab />}
        {activeTab === "withdraw-liquidity" && <WithdrawLiquidity />}
      </section>

      {/* Mobile/Tablet: bottom sheet */}
      <div className="xl:hidden">
        {/* Backdrop */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              className="fixed inset-0 bg-black/40 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setIsOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Bottom sheet */}
        <motion.div
          className={`fixed left-0 right-0 bottom-0 z-50 rounded-t-2xl border-t shadow-lg ${
            isDark ? "bg-[#1A1A1A] border-[#333333]" : "bg-white border-[#E5E7EB]"
          }`}
          animate={{ y: isOpen ? 0 : "calc(100% - 72px)" }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          style={{ maxHeight: "85vh" }}
        >
          {/* Sticky tab bar — always visible at bottom */}
          <div className="flex flex-col items-center pt-2 pb-1 px-4">
            {/* Drag handle — only this toggles open/close */}
            <div
              className={`w-10 h-1 rounded-full mb-2 cursor-pointer ${isDark ? "bg-[#444444]" : "bg-[#D0D0D0]"}`}
              onClick={() => setIsOpen(!isOpen)}
            />
            <nav className="w-full" aria-label="Liquidity Actions" onClick={(e) => e.stopPropagation()}>
              <AnimatedTabs
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={(tab) => {
                  setActiveTab(tab);
                  setIsOpen(true);
                }}
                type="border"
                containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"}`}
                tabClassName="!flex-1 !px-2 text-[11px] sm:text-[13px]"
              />
            </nav>
          </div>

          {/* Form content — scrollable */}
          <div className="overflow-y-auto px-4 pb-6 pt-3 flex flex-col gap-4" style={{ maxHeight: "calc(85vh - 56px)" }}>
            {activeTab === "supply-liquidity" && <SupplyLiquidityTab />}
            {activeTab === "withdraw-liquidity" && <WithdrawLiquidity />}
          </div>
        </motion.div>
      </div>
    </>
  );
};
