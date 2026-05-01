"use client";

import { useTheme } from "@/contexts/theme-context";
import { Modal } from "@/components/ui/modal";
import { Token } from "./types";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

interface TokenSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  tokens: Token[];
  popularTokens: Token[];
  balances?: Record<string, string>;
}

export const TokenSearchModal = ({
  isOpen,
  onClose,
  onSelect,
  tokens,
  popularTokens,
  balances,
}: TokenSearchModalProps) => {
  const { isDark } = useTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const filteredTokens = tokens.filter(
    (t) =>
      t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.id.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleSelect = (token: Token) => {
    onSelect(token);
    onClose();
  };

  return (
    <Modal open={isOpen} onClose={onClose} bottomSheet>
      <div
        className={`w-[480px] max-w-[90vw] rounded-[20px] flex flex-col overflow-hidden ${
          isDark ? "bg-[#222222] border border-[#333333]" : "bg-white border border-[#E2E2E2]"
        }`}
        style={{ maxHeight: "min(580px, 85vh)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3
            className={`text-[16px] font-semibold leading-[24px] ${isDark ? "text-white" : "text-[#111111]"}`}
          >
            Select a Token
          </h3>
          <button
            type="button"
            onClick={onClose}
            className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${
              isDark ? "hover:bg-[#333333]" : "hover:bg-[#F4F4F4]"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5"
                stroke={isDark ? "#A7A7A7" : "#777777"}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Search input */}
        <div className="px-5 pb-3">
          <div
            className={`flex items-center gap-2.5 px-3.5 h-[44px] rounded-xl border transition-colors ${
              isDark
                ? "bg-[#1A1A1A] border-[#333333] focus-within:border-[#703AE6]"
                : "bg-[#F7F7F7] border-[#E2E2E2] focus-within:border-[#703AE6]"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle
                cx="7"
                cy="7"
                r="5"
                stroke={isDark ? "#777777" : "#A7A7A7"}
                strokeWidth="1.5"
              />
              <path
                d="M11 11L14 14"
                stroke={isDark ? "#777777" : "#A7A7A7"}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search by name or paste address"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`flex-1 bg-transparent outline-none text-[14px] font-medium leading-[21px] ${
                isDark
                  ? "text-white placeholder:text-[#555555]"
                  : "text-[#111111] placeholder:text-[#A7A7A7]"
              }`}
            />
          </div>
        </div>

        {/* Popular tokens chips */}
        {popularTokens.length > 0 && !searchQuery && (
          <div className="px-5 pb-3">
            <p
              className={`text-[11px] font-semibold leading-[15px] mb-2 ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
            >
              Popular
            </p>
            <div className="flex flex-wrap gap-2">
              {popularTokens.map((token) => (
                <motion.button
                  key={token.id}
                  type="button"
                  onClick={() => handleSelect(token)}
                  whileTap={{ scale: 0.95 }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full cursor-pointer transition-colors ${
                    isDark
                      ? "bg-[#333333] hover:bg-[#3D3D3D]"
                      : "bg-[#F4F4F4] hover:bg-[#EEEEEE]"
                  }`}
                >
                  <div className="w-5 h-5 rounded-full overflow-hidden flex items-center justify-center bg-[#444444]">
                    {token.logo ? (
                      <img src={token.logo} alt={token.symbol} className="w-5 h-5 object-cover" />
                    ) : (
                      <span className="text-[8px] font-semibold text-white">
                        {token.symbol.slice(0, 2)}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-[12px] font-semibold leading-[18px] ${isDark ? "text-white" : "text-[#111111]"}`}
                  >
                    {token.symbol}
                  </span>
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* Divider */}
        <div className={`h-px ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />

        {/* Token list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {filteredTokens.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <circle cx="14" cy="14" r="10" stroke={isDark ? "#555555" : "#CCCCCC"} strokeWidth="2" />
                <path d="M22 22L28 28" stroke={isDark ? "#555555" : "#CCCCCC"} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span
                className={`text-[14px] font-medium ${isDark ? "text-[#555555]" : "text-[#A7A7A7]"}`}
              >
                No tokens found
              </span>
            </div>
          ) : (
            filteredTokens.map((token) => (
              <motion.button
                key={token.id}
                type="button"
                onClick={() => handleSelect(token)}
                whileTap={{ scale: 0.98 }}
                className={`w-full flex items-center justify-between px-5 py-3 cursor-pointer transition-colors ${
                  isDark ? "hover:bg-[#2A2A2A]" : "hover:bg-[#F7F7F7]"
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Token logo */}
                  <div className="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center bg-[#444444] shrink-0">
                    {token.logo ? (
                      <img src={token.logo} alt={token.symbol} className="w-9 h-9 object-cover" />
                    ) : (
                      <span className="text-[12px] font-semibold text-white">
                        {token.symbol.slice(0, 2)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-start">
                    <span
                      className={`text-[14px] font-semibold leading-[21px] ${isDark ? "text-white" : "text-[#111111]"}`}
                    >
                      {token.symbol}
                    </span>
                    <span
                      className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
                    >
                      {token.name}
                    </span>
                  </div>
                </div>

                {/* Balance */}
                {balances?.[token.id] && (
                  <span
                    className={`text-[14px] font-medium leading-[21px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {balances[token.id]}
                  </span>
                )}
              </motion.button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
};
