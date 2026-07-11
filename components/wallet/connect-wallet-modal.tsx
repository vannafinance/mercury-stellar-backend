"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

interface ConnectWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFreighter: () => void;
  onSelectPrivy: () => void;
  privyEnabled: boolean;
  isLoading?: boolean;
}

const FreighterIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="6" width="18" height="13" rx="3" stroke="#703AE6" strokeWidth="1.6" />
    <path d="M3 9.5h18" stroke="#703AE6" strokeWidth="1.6" />
    <circle cx="16.5" cy="14" r="1.5" fill="#703AE6" />
  </svg>
);

const EmailLoginIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="5.5" width="18" height="13" rx="3" stroke="#3B82F6" strokeWidth="1.6" />
    <path d="M3.5 7L12 13L20.5 7" stroke="#3B82F6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ChevronRight = ({ isDark }: { isDark: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
    <path
      d="M9 5l7 7-7 7"
      stroke={isDark ? "#595959" : "#B0B0B0"}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Wallet-selection dialog shown when the user clicks "Connect Wallet" while
 * disconnected. Freighter always appears; the Privy (email/Google) option is
 * hidden entirely when `NEXT_PUBLIC_PRIVY_APP_ID` isn't configured.
 */
export const ConnectWalletModal = ({
  isOpen,
  onClose,
  onSelectFreighter,
  onSelectPrivy,
  privyEnabled,
  isLoading,
}: ConnectWalletModalProps) => {
  const { isDark } = useTheme();

  const options = [
    {
      key: "freighter",
      name: "Freighter",
      description: "Connect using the Freighter browser extension",
      onClick: onSelectFreighter,
      iconBg: isDark ? "bg-[#2A1A3E]" : "bg-[#F1EBFD]",
      icon: <FreighterIcon />,
    },
    ...(privyEnabled
      ? [
          {
            key: "privy",
            name: "Email or Google",
            description: "Sign in with email or Google",
            onClick: onSelectPrivy,
            iconBg: isDark ? "bg-[#132A45]" : "bg-[#EAF2FE]",
            icon: <EmailLoginIcon />,
          },
        ]
      : []),
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[2001] w-[92vw] max-w-[380px] rounded-[16px] overflow-hidden ${
              isDark ? "bg-[#161616] border border-[#2A2A2A]" : "bg-white border border-[#E8E8E8]"
            }`}
            style={{
              boxShadow: isDark
                ? "0 24px 64px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.04)"
                : "0 24px 64px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.04)",
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Connect a wallet"
          >
            <div
              className={`px-5 py-4 border-b flex items-start justify-between gap-3 ${
                isDark ? "border-[#222]" : "border-[#F0F0F0]"
              }`}
            >
              <div>
                <h2 className={`text-[16px] font-semibold ${isDark ? "text-white" : "text-[#111]"}`}>
                  Connect a Wallet
                </h2>
                <p className={`text-[12px] mt-0.5 ${isDark ? "text-[#888]" : "text-[#666]"}`}>
                  Choose how you want to connect to Vanna
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className={`p-1.5 rounded-md transition-colors ${
                  isDark
                    ? "text-[#999] hover:text-white hover:bg-[#222]"
                    : "text-[#666] hover:text-[#111] hover:bg-[#F2F2F2]"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="p-2.5 flex flex-col gap-1.5">
              {options.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={opt.onClick}
                  disabled={isLoading}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-[12px] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isDark ? "hover:bg-white/5" : "hover:bg-black/5"
                  }`}
                >
                  <div className={`w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0 ${opt.iconBg}`}>
                    {opt.icon}
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111]"}`}>
                      {opt.name}
                    </p>
                    <p className={`text-[11px] mt-0.5 truncate ${isDark ? "text-[#888]" : "text-[#666]"}`}>
                      {opt.description}
                    </p>
                  </div>
                  <ChevronRight isDark={isDark} />
                </button>
              ))}
            </div>

            {privyEnabled && (
              <div
                className={`px-5 py-3 border-t text-[11px] ${
                  isDark ? "border-[#222] text-[#666]" : "border-[#F0F0F0] text-[#888]"
                }`}
              >
                New to crypto? Choose Email or Google — no seed phrase needed.
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
