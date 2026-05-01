import React from 'react';

interface ChevronDownIconProps {
  className?: string;
  stroke?: string;
  strokeWidth?: number;
  width?: number;
  height?: number;
}

export const ChevronDownIcon: React.FC<ChevronDownIconProps> = ({
  className = '',
  stroke = 'currentColor',
  strokeWidth = 1.5,
  width = 24,
  height = 24,
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      stroke={stroke}
      width={width}
      height={height}
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m19.5 8.25-7.5 7.5-7.5-7.5"
      />
    </svg>
  );
};

