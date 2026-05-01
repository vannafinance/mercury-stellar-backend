import React from "react";

interface EditIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const EditIcon = ({
  className = "",
  fill = "#111111",
  width = 13,
  height = 14,
  onClick,
}: EditIconProps) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 13 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M0 13.3333V10.9091H12.1212V13.3333H0ZM1.21212 9.69697V7.12121L8 0.348485C8.11111 0.237374 8.2399 0.151515 8.38636 0.0909091C8.53283 0.030303 8.68687 0 8.84848 0C9.0101 0 9.16667 0.030303 9.31818 0.0909091C9.4697 0.151515 9.60606 0.242424 9.72727 0.363636L10.5606 1.21212C10.6818 1.32323 10.7702 1.45455 10.8258 1.60606C10.8813 1.75758 10.9091 1.91414 10.9091 2.07576C10.9091 2.22727 10.8813 2.37626 10.8258 2.52273C10.7702 2.66919 10.6818 2.80303 10.5606 2.92424L3.78788 9.69697H1.21212ZM8.84848 2.90909L9.69697 2.06061L8.84848 1.21212L8 2.06061L8.84848 2.90909Z"
        fill={fill}
      />
    </svg>
  );
};

