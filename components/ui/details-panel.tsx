"use client";

import { motion } from "framer-motion";
import { ReactNode } from "react";
import { useTheme } from "@/contexts/theme-context";

export interface DetailsItem {
  title: string;
  value: ReactNode;
  linkText?: string;
  onLinkClick?: () => void;
}

interface DetailsPanelProps {
  items: DetailsItem[];
  containerClassName?: string;
}

export const DetailsPanel = ({
  items,
  containerClassName = "",
}: DetailsPanelProps) => {
  const { isDark } = useTheme();
  const textColor = isDark ? "text-white" : "text-[#1F1F1F]";

  return (
    <motion.div
      className={`px-[16px] w-full h-full flex flex-col gap-[16px] ${containerClassName}`}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      {items.map((item, index) => (
        <motion.div
          key={index}
          className="flex justify-between"
          initial={{ opacity: 0, x: -10 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3, delay: 0.35 + index * 0.05 }}
        >
          <div className="flex items-center gap-[8px]">
            <div className={`text-[16px] ${textColor} font-medium`}>
              {item.title}
            </div>
            {item.linkText && (
              <button
                type="button"
                className="text-[12px] text-[#703AE6] font-medium hover:underline cursor-pointer"
                onClick={item.onLinkClick}
              >
                {item.linkText}
              </button>
            )}
          </div>
          <div className={`text-[16px] ${textColor} font-medium`}>
            {item.value}
          </div>
        </motion.div>
      ))}
    </motion.div>
  );
};

