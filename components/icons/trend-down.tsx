import React from 'react';

interface TrendDownIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const TrendDownIcon: React.FC<TrendDownIconProps> = ({
  className = '',
  fill = '#FC5457',
  width = 8,
  height = 8,
  onClick,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 8 8"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M4 8L0.535898 2H7.4641L4 8Z"
        fill={fill}
      />
    </svg>
  );
};

