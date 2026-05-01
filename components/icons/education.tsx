import React from "react";

interface EducationIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const EducationIcon = ({
  className = "",
  fill = "#E63ABB",
  width = 44,
  height = 37,
  onClick,
}: EducationIconProps) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 44 37"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M22 0L0 12.3333L8 16.8144V29.1478L22 37L36 29.1478V16.8144L40 14.5739V28.7778H44V12.3333L22 0ZM35.64 12.3333L22 19.98L8.36 12.3333L22 4.68667L35.64 12.3333ZM32 26.7222L22 32.3133L12 26.7222V19.055L22 24.6667L32 19.055V26.7222Z"
        fill={fill}
      />
    </svg>
  );
};

