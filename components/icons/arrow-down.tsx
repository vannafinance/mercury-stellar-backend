import React from "react";

interface ArrowDownIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const ArrowDownIcon = ({
  className = "",
  fill = "black",
  width = 13,
  height = 8,
  onClick,
}: ArrowDownIconProps) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 13 8"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M11.91 8.38201e-05L12.97 1.06108L7.193 6.84008C7.10043 6.93324 6.99036 7.00717 6.8691 7.05761C6.74785 7.10806 6.61783 7.13403 6.4865 7.13403C6.35517 7.13403 6.22514 7.10806 6.10389 7.05761C5.98264 7.00717 5.87257 6.93324 5.78 6.84008L0 1.06108L1.06 0.00108375L6.485 5.42508L11.91 8.38201e-05Z"
        fill={fill}
      />
    </svg>
  );
};

