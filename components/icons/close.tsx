import React from 'react';

interface CloseIconProps {
  className?: string;
  stroke?: string;
  width?: number;
  height?: number;
}

export const CloseIcon: React.FC<CloseIconProps> = ({
  className = '',
  stroke = '#111111',
  width = 8,
  height = 8,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 8 8"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M7.25 0.75L0.75 7.25M0.75 0.75L7.25 7.25"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

