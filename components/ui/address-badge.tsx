"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

interface AddressBadgeProps {
  address: string;
  /** Optional small label rendered before the address (e.g. "Account:"). */
  label?: string;
  /** Stellar Expert network slug; mainnet uses `"public"`. */
  network?: "testnet" | "public";
  className?: string;
}

const truncate = (addr: string): string =>
  addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;

/** Stellar contract addresses are 56 chars starting with `C`. */
export const isStellarContractAddress = (value: unknown): value is string =>
  typeof value === "string" && /^C[A-Z0-9]{55}$/.test(value);

export const AddressBadge = ({
  address,
  label,
  network = "public",
  className = "",
}: AddressBadgeProps) => {
  const { isDark } = useTheme();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail in non-secure contexts; silently ignore.
    }
  };

  const explorerUrl = `https://stellar.expert/explorer/${network}/contract/${address}`;

  const labelClasses = isDark ? "text-[#666666]" : "text-[#888888]";
  const addressClasses = isDark ? "text-[#A0A0A0]" : "text-[#666666]";
  const iconBtnClasses = isDark
    ? "text-[#888888] hover:text-white"
    : "text-[#888888] hover:text-[#111111]";

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      {label && (
        <span className={`text-[11px] font-medium ${labelClasses}`}>{label}</span>
      )}
      <span className={`font-mono text-[11.5px] leading-none ${addressClasses}`}>
        {truncate(address)}
      </span>

      <motion.button
        type="button"
        onClick={handleCopy}
        whileTap={{ scale: 0.92 }}
        transition={{ duration: 0.1 }}
        title={copied ? "Copied" : "Copy address"}
        aria-label={copied ? "Copied to clipboard" : `Copy address ${address}`}
        className={`flex items-center justify-center transition-colors cursor-pointer ${iconBtnClasses}`}
      >
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.span
              key="check"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.15 }}
              className="text-emerald-500"
            >
              <CheckIcon />
            </motion.span>
          ) : (
            <motion.span
              key="copy"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.15 }}
            >
              <CopyIcon />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      <motion.a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        whileTap={{ scale: 0.92 }}
        transition={{ duration: 0.1 }}
        title="View on Stellar Expert"
        aria-label={`View ${address} on Stellar Expert`}
        className={`flex items-center justify-center transition-colors cursor-pointer ${iconBtnClasses}`}
      >
        <ExternalIcon />
      </motion.a>
    </div>
  );
};

const CopyIcon = () => (
  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M2 10V3a1 1 0 011-1h7"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

const CheckIcon = () => (
  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M3 7.5L6 10.5L11 4.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ExternalIcon = () => (
  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M6 3H3v8h8V8M8 2h4v4M12 2L6 8"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
