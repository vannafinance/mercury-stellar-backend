import { AnimatedTabs } from "../ui/animated-tabs"
import { useState, memo } from "react"
import { AddLiquidity } from "./add-liquidity"
import { RemoveLiquidity } from "./remove-liquidity"
import { useTheme } from "@/contexts/theme-context"
import { motion, AnimatePresence } from "framer-motion"

const tabs = [
  { id: "add-liquidity", label: "Add Liquidity" },
  { id: "remove-liquidity", label: "Remove Liquidity" }
]

export const Form = memo(function Form() {
  const [activeTab, setActiveTab] = useState<string>("add-liquidity")
  const [isOpen, setIsOpen] = useState(false)
  const { isDark } = useTheme()

  return (
    <>
      {/* Desktop: normal inline form */}
      <div className={`hidden xl:flex w-full rounded-2xl border py-4 px-4 sm:px-5 h-fit flex-col gap-4 ${
        isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"
      }`}>
        <AnimatedTabs
          type="border"
          containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
          tabClassName="!flex-1 !px-2 text-[12px]"
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
        <AnimatePresence mode="wait">
          {activeTab === "add-liquidity" && (
            <motion.div key="add" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.3 }}>
              <AddLiquidity />
            </motion.div>
          )}
          {activeTab === "remove-liquidity" && (
            <motion.div key="remove" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.3 }}>
              <RemoveLiquidity />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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
          {/* Tab bar — always visible */}
          <div className="flex flex-col items-center pt-2 pb-1 px-4">
            <div
              className={`w-10 h-1 rounded-full mb-2 cursor-pointer ${isDark ? "bg-[#444444]" : "bg-[#D0D0D0]"}`}
              onClick={() => setIsOpen(!isOpen)}
            />
            <nav className="w-full" aria-label="Liquidity Actions" onClick={(e) => e.stopPropagation()}>
              <AnimatedTabs
                type="border"
                containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"}`}
                tabClassName="!flex-1 !px-2 text-[11px] sm:text-[13px]"
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={(tab) => {
                  setActiveTab(tab)
                  setIsOpen(true)
                }}
              />
            </nav>
          </div>

          {/* Form content */}
          <div className="overflow-y-auto px-4 pb-6 pt-3 flex flex-col gap-4" style={{ maxHeight: "calc(85vh - 72px)" }}>
            <AnimatePresence mode="wait">
              {activeTab === "add-liquidity" && (
                <motion.div key="add" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                  <AddLiquidity />
                </motion.div>
              )}
              {activeTab === "remove-liquidity" && (
                <motion.div key="remove" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                  <RemoveLiquidity />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </>
  )
})
