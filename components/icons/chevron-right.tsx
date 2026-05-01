import React from "react";

interface ChevronRightIconProps {
  className?: string;
  stroke?: string;
  strokeWidth?: string | number;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const ChevronRightIcon = ({
  className = "",
  stroke = "currentColor",
  strokeWidth = 1.5,
  width = 12,
  height = 12,
  onClick,
}: ChevronRightIconProps) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M4.5 9L7.5 6L4.5 3"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

