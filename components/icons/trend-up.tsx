import React from 'react';

interface TrendUpIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const TrendUpIcon: React.FC<TrendUpIconProps> = ({
  className = '',
  fill = '#10B981',
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
        d="M4 0L7.4641 6H0.535898L4 0Z"
        fill={fill}
      />
    </svg>
  );
};

