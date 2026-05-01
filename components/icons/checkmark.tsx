import React from "react";

interface CheckmarkIconProps {
  className?: string;
  stroke?: string;
  strokeWidth?: number | string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const CheckmarkIcon = ({
  className = "",
  stroke = "currentColor",
  strokeWidth = 3,
  width = 24,
  height = 24,
  onClick,
}: CheckmarkIconProps) => {
  return (
    <svg
      className={className}
      stroke={stroke}
      strokeWidth={strokeWidth}
      fill="none"
      viewBox="0 0 24 24"
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      onClick={onClick}
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
};

