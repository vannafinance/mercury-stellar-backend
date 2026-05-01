import React from 'react';

interface InfoIconProps {
  className?: string;
  stroke?: string;
  width?: number;
  height?: number;
}

export const InfoIcon: React.FC<InfoIconProps> = ({
  className = '',
  stroke = '#5C5B5B',
  width = 14,
  height = 14,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="7" cy="7" r="6.5" stroke={stroke} />
      <path d="M7 4V7M7 10H7.01" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
};

