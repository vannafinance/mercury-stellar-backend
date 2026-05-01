"use client";

import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

interface Button {
  text: string;
  size: "small" | "medium" | "large";
  type: "solid" | "gradient" | "ghost" | "navbar";
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled: boolean;
  icon?: Element;
  ariaLabel?: string;
  width?: string; // Custom width class (e.g., "w-full", "w-[200px]", etc.)
}

export const Button = (props: Button) => {
  const { isDark } = useTheme();
  
  // Ghost button styling based on theme
  const ghostButtonStyle = props.disabled 
    ? "disabled:text-[#A7A7A7]" 
    : isDark
    ? "text-white hover:bg-[#333333] hover:text-white active:bg-[#333333] active:text-white focus:text-white"
    : "text-black hover:bg-[#F1EBFD] hover:text-[#703AE6] active:bg-[#F1EBFD] active:text-[#703AE6] focus:text-[#703AE6]";
  
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.ariaLabel || props.text}
      className={`${props.width || "w-full"} h-fit ${
        props.size == "medium"
          ? "py-[12px] px-[10px] text-[14px] sm:py-[16px] sm:px-[12px] sm:text-[16px] rounded-[12px]"
          : props.size == "large"
          ? "rounded-xl text-[13px] py-2.5 px-3 sm:text-[13px] sm:py-2.5 sm:px-4"
          : props.type === "navbar"
          ? "text-[12px] py-2 px-3.5"
          : "text-[12px] p-[8px]"
      } disabled:cursor-not-allowed transition cursor-pointer rounded-[8px] font-semibold ${
        props.type == "solid"
          ? "bg-[#703AE6] disabled:bg-[#A7A7A7] hover:bg-[#6635D1] active:bg-[#6635D1] text-white"
          : props.type == "gradient" || props.type == "navbar"
          ? props.disabled
            ? "bg-[#A7A7A7] text-white"
            : "bg-gradient text-white hover:bg-gradient active:bg-gradient"
          : ghostButtonStyle
      }`}
    >
      {props.text}
    </motion.button>
  );
};
