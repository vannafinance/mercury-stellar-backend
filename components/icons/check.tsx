import React from "react";

interface CheckIconProps {
  className?: string;
  fill?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const CheckIcon = ({
  className = "",
  fill = "white",
  width = 13,
  height = 10,
  onClick,
}: CheckIconProps) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 13 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M4.88938 10L13 1.6568L11.3894 0L4.88938 6.68639L1.61062 3.31361L0 4.97041L4.88938 10Z"
        fill={fill}
      />
    </svg>
  );
};

