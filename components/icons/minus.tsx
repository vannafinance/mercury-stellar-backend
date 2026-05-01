import React from 'react';

interface MinusIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const MinusIcon: React.FC<MinusIconProps> = ({
  className = '',
  fill = '#703AE6',
  width = 14,
  height = 3,
  onClick,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 14 3"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M13.3785 2.17793L7.77825 2.17793L5.60036 2.17793L7.72942e-05 2.17793L7.67884e-05 4.52819e-05L5.60036 4.5029e-05L7.77825 4.51976e-05L13.3785 4.55347e-05V2.17793Z"
        fill={fill}
      />
    </svg>
  );
};

