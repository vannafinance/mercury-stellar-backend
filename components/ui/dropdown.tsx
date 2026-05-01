"use client";

import { iconPaths } from "@/lib/constants";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useState, useRef, useEffect } from "react";
import { useTheme } from "@/contexts/theme-context";

interface Dropdown {
  items:string[];
  setSelectedOption: (value: string) => void;
  selectedOption: string;
  classname:string
  dropdownClassname:string
  menuClassname?: string
  arrowClassname?: string
}

export const Dropdown = (props: Dropdown) => {
  const { isDark } = useTheme();
  const [isHover, setIsHover] = useState(false);
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const handleMouseEnter = () => {
    // Clear any pending close timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setIsHover(true);
  };

  const handleMouseLeave = () => {
    // Delay closing to allow mouse to move to dropdown
    closeTimeoutRef.current = setTimeout(() => {
      setIsHover(false);
    }, 150);
  };

  const handleDropdownMouseEnter = () => {
    // Clear timeout when mouse enters dropdown
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const handleDropdownMouseLeave = () => {
    setIsHover(false);
  };

  return (
    <div
      className={`relative inline-block w-full ${isHover ? "z-[500]" : "z-[1]"}`}
    >
      <button
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        type="button"
        className={`w-fit rounded-[8px] cursor-pointer flex justify-center items-center ${
          isDark ? "text-white" : ""
        } ${props.classname}`}
        aria-label={`Selected: ${props.selectedOption}. Click to change option`}
        aria-expanded={isHover}
        aria-haspopup="listbox"
      >
        {iconPaths[props.selectedOption] && <Image
          src={iconPaths[props.selectedOption]}
          width={20}
          height={20}
          alt={props.selectedOption}
          aria-hidden="true"
        />} {" "}
        {props.selectedOption}
        <motion.svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          className={`shrink-0 ${props.arrowClassname || "size-4"}`}
          aria-hidden="true"
          animate={{ rotate: isHover ? 180 : 0 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m19.5 8.25-7.5 7.5-7.5-7.5"
          />
        </motion.svg>
      </button>
      <AnimatePresence>
        {isHover && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onMouseEnter={handleDropdownMouseEnter}
            onMouseLeave={handleDropdownMouseLeave}
            className={`min-w-[144px] absolute z-[500] p-2 shadow-lg rounded-[6px] thin-scrollbar ${
              isDark
                ? "bg-[#222222] border-[1px] border-[#333333]"
                : "bg-white border-[1px] border-[#E5E5E5]"
            } ${props.menuClassname || "top-8 -left-4"} ${props.items.length > 4 ? "max-h-48 overflow-y-auto" : ""}`}
            role="listbox"
            aria-label="Options"
          >
            {props.items.map((item, idx) => {
              return (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.85 }}
                  className={`${props.dropdownClassname} flex font-medium rounded-[6px] cursor-pointer py-2 px-8 w-full text-left ${
                    isDark
                      ? "text-white hover:bg-[#333333]"
                      : "hover:text-[#7C35F8] hover:bg-[#F2EBFE]"
                  }`}
                  key={item}
                  role="option"
                  aria-selected={props.selectedOption === item}
                  onClick={() => {
                    props.setSelectedOption(item);
                  }}
                  aria-label={`Select ${item}`}
                >
                  {iconPaths[item] && <Image
                    src={iconPaths[item]}
                    width={20}
                    height={20}
                    alt={item}
                    aria-hidden="true"
                  />}
                  {item}
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
