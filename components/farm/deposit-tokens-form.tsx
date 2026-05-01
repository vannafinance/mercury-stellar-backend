import Image from "next/image"
import ToggleButton from "../ui/toggle"
import { iconPaths } from "@/lib/constants"
import { Button } from "../ui/button"
import { useUserStore } from "@/store/user"
import { useState, useCallback } from "react"

// Shared form content component
const FormContent = ({ inputCard, singleAmount, setSingleAmount, multiAmounts, handleMultiChange, assets, isSingleAsset, singlePct, setSinglePct, multiPcts, setMultiPcts, userAddress }: any) => (
    <>
        <AnimatePresence mode="wait">
            {isSingleAsset ? (
                <motion.div key="single" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
                    {inputCard(singleAmount, setSingleAmount, assets[0], singlePct, setSinglePct)}
                </motion.div>
            ) : (
                <motion.div key="multi" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="flex flex-col gap-2">
                    {inputCard(multiAmounts[0], (v: string) => handleMultiChange(0, v), assets[0], multiPcts[0], (p: number) => setMultiPcts((prev: number[]) => { const u = [...prev]; u[0] = p; return u; }))}
                    {inputCard(multiAmounts[1], (v: string) => handleMultiChange(1, v), assets[1], multiPcts[1], (p: number) => setMultiPcts((prev: number[]) => { const u = [...prev]; u[1] = p; return u; }))}
                </motion.div>
            )}
        </AnimatePresence>
        <Button
            text={userAddress ? "Deposit" : "Connect Wallet"}
            size="large"
            type="solid"
            disabled={!userAddress}
        />
    </>
);
import { useTheme } from "@/contexts/theme-context"
import { AnimatePresence, motion } from "framer-motion"
import { PERCENTAGE_COLORS } from "@/lib/constants/margin"

const PERCENTAGES = [10, 25, 50, 100];

export const DepositTokensForm = ({ assets }: { assets: string[] }) => {
    const { isDark } = useTheme();
    const userAddress = useUserStore((state) => state.address)
    const [isSingleAsset, setIsSingleAsset] = useState(true)
    const [singleAmount, setSingleAmount] = useState("")
    const [multiAmounts, setMultiAmounts] = useState(["", ""])
    const [singlePct, setSinglePct] = useState(0)
    const [multiPcts, setMultiPcts] = useState([0, 0])

    const handleMultiChange = useCallback((index: number, value: string) => {
        setMultiAmounts(prev => {
            const updated = [...prev];
            updated[index] = value;
            return updated;
        });
        setMultiPcts(prev => { const u = [...prev]; u[index] = 0; return u; });
    }, []);

    const inputCard = (
        amount: string,
        onChange: (v: string) => void,
        asset: string,
        selectedPct: number,
        onPctChange: (p: number) => void
    ) => (
        <div className={`w-full rounded-xl border flex flex-col overflow-hidden ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`}>
            <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
                <input
                    value={amount}
                    onChange={(e) => { onChange(e.target.value); onPctChange(0); }}
                    type="text"
                    placeholder="0"
                    inputMode="decimal"
                    className={`flex-1 min-w-0 bg-transparent outline-none text-[20px] font-semibold placeholder:opacity-20 ${isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"}`}
                />
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full shrink-0 ${isDark ? "bg-[#1A1A1A] border border-[#2A2A2A]" : "bg-[#F7F7F7] border border-[#E8E8E8]"}`}>
                    {iconPaths[asset] && <Image src={iconPaths[asset]} alt={asset} width={20} height={20} className="rounded-full w-5 h-5 flex-none" />}
                    <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{asset}</span>
                </div>
            </div>
            <div className="flex items-center justify-between px-3 pb-3">
                <div className="flex items-center gap-1">
                    {PERCENTAGES.map((pct) => (
                        <motion.button
                            key={pct}
                            type="button"
                            onClick={() => { onPctChange(pct); onChange(String(pct)); }}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.93 }}
                            transition={{ duration: 0.1 }}
                            className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                                selectedPct === pct
                                    ? `${PERCENTAGE_COLORS[pct]} text-white border-transparent`
                                    : isDark
                                        ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                                        : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                            }`}
                        >
                            {pct}%
                        </motion.button>
                    ))}
                </div>
                <span className={`text-[12px] font-medium ${isDark ? "text-[#555555]" : "text-[#AAAAAA]"}`}>
                    Balance: 0 {asset}
                </span>
            </div>
        </div>
    );

    const [isOpen, setIsOpen] = useState(false);

    const toggleRow = (
        <div className={`flex items-center gap-2 text-[12px] font-medium ${isDark ? "text-[#AAAAAA]" : "text-[#444444]"}`}>
            Single Asset
            <ToggleButton onToggle={() => setIsSingleAsset(!isSingleAsset)} size="small" />
            Multi Assets
        </div>
    );

    const desktopHeader = (
        <div className="hidden xl:flex items-center justify-between">
            <p className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>Deposit Tokens</p>
            {toggleRow}
        </div>
    );

    const mobileHeader = (
        <div className="flex xl:hidden flex-col items-center gap-2">
            <p className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>Deposit Tokens</p>
            {isOpen && toggleRow}
        </div>
    );

    const formProps = { inputCard, singleAmount, setSingleAmount, multiAmounts, handleMultiChange, assets, isSingleAsset, singlePct, setSinglePct, multiPcts, setMultiPcts, userAddress };

    return (
        <>
            {/* Desktop: normal inline form */}
            <div className={`hidden xl:flex w-full rounded-2xl border p-4 flex-col gap-4 ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
                {desktopHeader}
                <FormContent {...formProps} />
            </div>

            {/* Mobile/Tablet: bottom sheet */}
            <div className="xl:hidden">
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

                <motion.div
                    className={`fixed left-0 right-0 bottom-0 z-50 rounded-t-2xl border-t shadow-lg ${
                        isDark ? "bg-[#1A1A1A] border-[#333333]" : "bg-white border-[#E5E7EB]"
                    }`}
                    animate={{ y: isOpen ? 0 : "calc(100% - 72px)" }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    style={{ maxHeight: "85vh" }}
                >
                    <div className="flex flex-col items-center pt-2 pb-1 px-4">
                        <div
                            className={`w-10 h-1 rounded-full mb-2 cursor-pointer ${isDark ? "bg-[#444444]" : "bg-[#D0D0D0]"}`}
                            onClick={() => setIsOpen(!isOpen)}
                        />
                        <div className="w-full" onClick={(e) => { e.stopPropagation(); if (!isOpen) setIsOpen(true); }}>
                            {mobileHeader}
                        </div>
                    </div>

                    <div className="overflow-y-auto px-4 pb-6 pt-3 flex flex-col gap-4" style={{ maxHeight: "calc(85vh - 72px)" }}>
                        <FormContent {...formProps} />
                    </div>
                </motion.div>
            </div>
        </>
    );
}
