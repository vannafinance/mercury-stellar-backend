"use client";

import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";
import { useMarginHistory } from "@/hooks/use-margin";
import { COIN_ICONS } from "@/lib/constants/margin";
import { formatTokenAmount } from "@/lib/utils/format-amount";

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Canonicalise a Mercury event's asset symbol to the app's display symbol. */
const canonical = (t: string): string => {
  const u = (t || "").toUpperCase();
  if (u === "BLEND_USDC" || u === "USDC") return "BLUSDC";
  if (u === "AQUARIUS_USDC") return "AQUSDC";
  if (u === "SOROSWAP_USDC") return "SOUSDC";
  return u;
};

const iconFor = (asset: string): string =>
  COIN_ICONS[canonical(asset) as keyof typeof COIN_ICONS] || "/icons/eth-icon.png";

const badgeFor = (type: string): { cls: string; label: string } => {
  switch (type) {
    case "borrow": return { cls: "bg-red-100 text-red-600", label: "Borrow" };
    case "repay": return { cls: "bg-green-100 text-green-600", label: "Repay" };
    case "transfer-in": return { cls: "bg-violet-100 text-violet-700", label: "Transfer In" };
    case "transfer-out": return { cls: "bg-amber-100 text-amber-700", label: "Transfer Out" };
    default: return { cls: "bg-blue-100 text-blue-600", label: "Deposit" };
  }
};

/**
 * Portfolio transaction history — the account's on-chain activity
 * (deposit/withdraw/borrow/repay/transfer) sourced from Mercury via
 * {@link useMarginHistory}, each row linking to the tx on stellar.expert. Real
 * data (no mock); loading + empty states handled.
 */
export const HistoryModal = ({ isOpen, onClose }: HistoryModalProps) => (
  <AnimatePresence>{isOpen && <HistoryModalContent onClose={onClose} />}</AnimatePresence>
);

/**
 * Mounted ONLY while the modal is open, so the Mercury history query fires on
 * OPEN — not on every portfolio-page render. React Query's 30s staleTime makes a
 * reopen within the window instant (no refetch), and `useMarginHistory` is not
 * ledger-tick polled by design — so there's no background polling here.
 */
const HistoryModalContent = ({ onClose }: { onClose: () => void }) => {
  const { isDark } = useTheme();
  const { history, isLoading } = useMarginHistory();

  return (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566] p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className={`w-full max-w-[520px] max-h-[80vh] flex flex-col rounded-2xl border ${
              isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
            }`}
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? "border-[#2A2A2A]" : "border-[#EEEEEE]"}`}>
              <h2 className={`text-[18px] font-bold ${isDark ? "text-white" : "text-[#111111]"}`}>History</h2>
              <button
                type="button"
                onClick={onClose}
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-colors ${
                  isDark ? "hover:bg-[#2A2A2A] text-white" : "hover:bg-[#F0F0F0] text-[#111111]"
                }`}
                aria-label="Close history"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2 thin-scrollbar">
              {isLoading ? (
                [0, 1, 2, 3].map((i) => (
                  <div key={i} className={`h-14 rounded-xl animate-pulse ${isDark ? "bg-[#2A2A2A]" : "bg-[#ECECEC]"}`} />
                ))
              ) : history.length === 0 ? (
                <div className={`text-center py-12 text-[14px] font-medium ${isDark ? "text-[#777777]" : "text-[#A0A0A0]"}`}>
                  No transaction history yet.
                </div>
              ) : (
                history.map((item, idx) => {
                  const b = badgeFor(item.type);
                  const date = item.timestamp
                    ? new Date(item.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
                    : "—";
                  const short = item.hash ? `${item.hash.slice(0, 8)}…${item.hash.slice(-4)}` : "—";
                  return (
                    <div
                      key={`${item.hash}-${idx}`}
                      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${
                        isDark ? "bg-[#222222] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#EEEEEE]"
                      }`}
                    >
                      {item.asset && (
                        <Image src={iconFor(item.asset)} alt={item.asset} width={28} height={28} className="rounded-full shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
                          <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                            {formatTokenAmount(parseFloat(String(item.amount ?? "0")) || 0)} {canonical(item.asset || "")}
                          </span>
                        </div>
                        <div className={`text-[11px] font-medium mt-0.5 ${isDark ? "text-[#777777]" : "text-[#A0A0A0]"}`}>{date}</div>
                      </div>
                      {item.hash ? (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${item.hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[12px] font-medium text-[#703AE6] hover:underline shrink-0"
                        >
                          {short}
                        </a>
                      ) : (
                        <span className={`text-[12px] shrink-0 ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>—</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        </motion.div>
  );
};
