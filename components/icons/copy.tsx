import React from "react";

interface CopyIconProps {
  className?: string;
  stroke?: string;
  width?: number;
  height?: number;
  onClick?: () => void;
}

export const CopyIcon = ({
  className = "",
  stroke = "#111111",
  width = 10,
  height = 11,
  onClick,
}: CopyIconProps) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 10 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
    >
      <path
        d="M1.875 4.875C1.875 3.461 1.875 2.7535 2.3145 2.3145C2.7535 1.875 3.461 1.875 4.875 1.875H6.375C7.789 1.875 8.4965 1.875 8.9355 2.3145C9.375 2.7535 9.375 3.461 9.375 4.875V7.375C9.375 8.789 9.375 9.4965 8.9355 9.9355C8.4965 10.375 7.789 10.375 6.375 10.375H4.875C3.461 10.375 2.7535 10.375 2.3145 9.9355C1.875 9.4965 1.875 8.789 1.875 7.375V4.875Z"
        stroke={stroke}
        strokeWidth="0.75"
      />
      <path
        d="M1.875 8.875C1.47718 8.875 1.09564 8.71696 0.81434 8.43566C0.533035 8.15436 0.375 7.77282 0.375 7.375V4.375C0.375 2.4895 0.375 1.5465 0.961 0.961C1.547 0.3755 2.4895 0.375 4.375 0.375H6.375C6.77282 0.375 7.15436 0.533035 7.43566 0.81434C7.71696 1.09564 7.875 1.47718 7.875 1.875"
        stroke={stroke}
        strokeWidth="0.75"
      />
    </svg>
  );
};

