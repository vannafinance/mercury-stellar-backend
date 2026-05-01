import React from 'react';

interface ZoomOutIconProps {
  className?: string;
  stroke?: string;
  width?: number;
  height?: number;
}

export const ZoomOutIcon: React.FC<ZoomOutIconProps> = ({
  className = '',
  stroke = 'currentColor',
  width = 16,
  height = 16,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8" cy="8" r="6" stroke={stroke} strokeWidth="2" />
      <path d="M5 8H11" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
};

