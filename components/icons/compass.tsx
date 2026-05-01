import React from 'react';

interface CompassIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
}

export const CompassIcon: React.FC<CompassIconProps> = ({
  className = '',
  fill = '#111111',
  width = 15,
  height = 15,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 15 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0 7.29167C0 5.3578 0.768227 3.50313 2.13568 2.13568C3.50313 0.768227 5.3578 0 7.29167 0C9.22554 0 11.0802 0.768227 12.4477 2.13568C13.8151 3.50313 14.5833 5.3578 14.5833 7.29167C14.5833 9.22554 13.8151 11.0802 12.4477 12.4477C11.0802 13.8151 9.22554 14.5833 7.29167 14.5833C5.3578 14.5833 3.50313 13.8151 2.13568 12.4477C0.768227 11.0802 0 9.22554 0 7.29167ZM6.33333 5.04917C5.55538 5.68898 5.03554 6.58894 4.87 7.5825L4.3225 10.8733C4.19667 11.6325 5.08 12.1425 5.67417 11.6533L8.25 9.53417C9.02795 8.89435 9.5478 7.99439 9.71333 7.00083L10.26 3.71C10.3867 2.95083 9.50333 2.44083 8.90917 2.93L6.33333 5.04917Z"
        fill={fill}
      />
    </svg>
  );
};

