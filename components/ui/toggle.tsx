'use client'

import React, { useState } from "react";
import { useTheme } from "@/contexts/theme-context";

// Toggle Props
interface ToggleProps {
    onToggle: (state: boolean) => void;
    defaultChecked?: boolean;
    size?: "small" | "medium" | "large";
    disabled?: boolean;
}

// Circle size
const circleSize = {
    small: "w-4 h-4",
    medium: "w-5 h-5",
    large: "w-6 h-6",
};

// Wrapper size (Figma: 48×24 for small)
const wrapperSize = {
    small: "w-12 h-6", // 48×24px - matches Figma design
    medium: "w-14 h-7", // 56×28px
    large: "w-16 h-8", // 64×32px
};

// Translate values corrected for alignment
const translateValues = {
    small: "translate-x-6",  // Updated for 48px width
    medium: "translate-x-7", // Updated for 56px width  
    large: "translate-x-9",  // 64px width
};

// Background colors based on theme
const getBackgroundColor = (isChecked: boolean, disabled: boolean, isDark: boolean) => {
    if (disabled) {
        return isDark ? "bg-[#333333] opacity-40" : "bg-[#D5D5D5] opacity-40";
    }
    if (isChecked) {
        return "bg-[#703AE6]"; // Purple when checked (same for both themes)
    }
    return isDark 
        ? "bg-[#333333] hover:bg-[#444444]" 
        : "bg-[#D5D5D5] hover:bg-[#BFBFBF]";
};

const ToggleButton = ({
    onToggle,
    defaultChecked = false,
    size = "medium",
    disabled = false,
}: ToggleProps) => {
    const { isDark } = useTheme();
    const [isChecked, setIsChecked] = useState(defaultChecked);

    const handleToggle = () => {
        if (disabled) return;
        const newState = !isChecked;
        setIsChecked(newState);
        onToggle(newState);
    };

    return (
        <button
            onClick={handleToggle}
            disabled={disabled}
            role="switch"
            aria-checked={isChecked}
            aria-label={isChecked ? "Toggle is on" : "Toggle is off"}
            className={`
        ${wrapperSize[size]}
        relative inline-flex items-center rounded-full transition-all duration-300 ease-in-out
        ${getBackgroundColor(isChecked, disabled, isDark)}
        ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
        focus:outline-none focus:ring-2 focus:ring-[#F845FC] focus:ring-offset-2
      `}
        >
            <span
                className={`
    ${circleSize[size]}
    inline-block bg-white rounded-full shadow-md transform transition-transform duration-300 ease-in-out
    ${isChecked ? translateValues[size] : "translate-x-1"}
  `}
            />

        </button>
    );
};

export default ToggleButton;
