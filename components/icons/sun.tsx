import React from 'react';

interface SunIconProps {
  className?: string;
  stroke?: string;
  strokeWidth?: number;
  width?: number;
  height?: number;
}

export const SunIcon: React.FC<SunIconProps> = ({
  className = '',
  stroke = '#FF007A',
  strokeWidth = 1.5,
  width = 16,
  height = 16,
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
        d="M12 3v2.25m6.364 6.364l-1.591 1.591M21 12h-2.25m-6.364 6.364l-1.591 1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
      />
    </svg>
  );
};

