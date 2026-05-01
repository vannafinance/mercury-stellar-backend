import React from 'react';

interface ArrowTopRightIconProps {
  className?: string;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const ArrowTopRightIcon: React.FC<ArrowTopRightIconProps> = ({
  className = '',
  stroke = '#434C53',
  strokeOpacity = 0.95,
  strokeWidth = 1.25,
  width = 10,
  height = 10,
  onClick,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 10 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M9.29169 4.95838L0.625 4.95838M9.29169 4.95838L4.95829 0.625M9.29169 4.95838L4.95829 9.29162"
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

