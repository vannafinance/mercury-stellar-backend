import React from 'react';

interface ChevronLeftIconProps {
  className?: string;
  stroke?: string;
  strokeWidth?: number;
  width?: number;
  height?: number;
}

export const ChevronLeftIcon: React.FC<ChevronLeftIconProps> = ({
  className = '',
  stroke = 'currentColor',
  strokeWidth = 2,
  width = 9,
  height = 16,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 9 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M8 1L1 8L8 15"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

