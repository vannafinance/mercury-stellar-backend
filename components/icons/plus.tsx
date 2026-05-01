import React from 'react';

interface PlusIconProps {
  className?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: string | number;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const PlusIcon: React.FC<PlusIconProps> = ({
  className = '',
  fill,
  stroke,
  strokeWidth = 1.33333,
  width = 14,
  height = 14,
  onClick,
}) => {
  // If stroke is provided, use stroke-based icon
  if (stroke) {
    return (
      <svg
        width={width}
        height={height}
        viewBox="0 0 11 11"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        onClick={onClick}
      >
        <path
          d="M5.33332 0.666748V10.0001M0.666656 5.33341H9.99999"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Otherwise use fill-based icon
  const fillColor = fill || '#703AE6';
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M13 8H8V13C8 13.2652 7.89464 13.5196 7.70711 13.7071C7.51957 13.8946 7.26522 14 7 14C6.73478 14 6.48043 13.8946 6.29289 13.7071C6.10536 13.5196 6 13.2652 6 13V8H1C0.734784 8 0.48043 7.89464 0.292893 7.70711C0.105357 7.51957 0 7.26522 0 7C0 6.73478 0.105357 6.48043 0.292893 6.29289C0.48043 6.10536 0.734784 6 1 6H6V1C6 0.734784 6.10536 0.480429 6.29289 0.292893C6.48043 0.105357 6.73478 0 7 0C7.26522 0 7.51957 0.105357 7.70711 0.292893C7.89464 0.480429 8 0.734784 8 1V6H13C13.2652 6 13.5196 6.10536 13.7071 6.29289C13.8946 6.48043 14 6.73478 14 7C14 7.26522 13.8946 7.51957 13.7071 7.70711C13.5196 7.89464 13.2652 8 13 8Z"
        fill={fillColor}
      />
    </svg>
  );
};

