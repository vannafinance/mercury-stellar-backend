"use client";

import { useTheme } from "@/contexts/theme-context";
import { motion } from "framer-motion";
import Image from "next/image";
import { useState } from "react";

interface SwapDirectionButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export const SwapDirectionButton = ({ onClick, disabled }: SwapDirectionButtonProps) => {
  const { isDark } = useTheme();
  const [rotation, setRotation] = useState(0);

  const handleClick = () => {
    if (disabled) return;
    setRotation((prev) => prev + 180);
    onClick();
  };

  return (
    <div className="flex items-center justify-center h-0 relative z-10">
      <motion.button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        animate={{ rotate: rotation }}
        transition={{ type: "spring", stiffness: 300, damping: 20 }}
        whileHover={{ scale: 1.12, boxShadow: isDark
          ? "0 4px 16px rgba(112, 58, 230, 0.35)"
          : "0 4px 16px rgba(112, 58, 230, 0.2)" }}
        whileTap={{ scale: 0.92 }}
        className={`w-[42px] h-[42px] rounded-full flex items-center justify-center cursor-pointer border-4 transition-colors ${
          isDark
            ? "bg-[#1A1A2E] border-[#111111] hover:bg-[#252540]"
            : "bg-[#F8F5FF] border-[#F7F7F7] hover:bg-[#F0EAFF]"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        style={{
          boxShadow: isDark
            ? "0 2px 10px rgba(112, 58, 230, 0.25)"
            : "0 2px 10px rgba(112, 58, 230, 0.12)",
        }}
      >
        <Image
          src="/logos/vanna-icon.png"
          alt="Swap"
          width={24}
          height={24}
          className="object-contain"
        />
      </motion.button>
    </div>
  );
};
