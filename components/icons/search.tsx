import React from 'react';

interface SearchIconProps {
  className?: string;
  stroke?: string;
  width?: number;
  height?: number;
}

export const SearchIcon: React.FC<SearchIconProps> = ({
  className = '',
  stroke = '#A7A7A7',
  width = 18,
  height = 18,
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M18.7502 18.7502L14.4072 14.4072M14.4072 14.4072C15.1501 13.6643 15.7394 12.7824 16.1414 11.8118C16.5435 10.8411 16.7504 9.80081 16.7504 8.75021C16.7504 7.6996 16.5435 6.65929 16.1414 5.68866C15.7394 4.71803 15.1501 3.83609 14.4072 3.09321C13.6643 2.35032 12.7824 1.76103 11.8118 1.35898C10.8411 0.956931 9.80081 0.75 8.75021 0.75C7.6996 0.75 6.65929 0.956931 5.68866 1.35898C4.71803 1.76103 3.83609 2.35032 3.09321 3.09321C1.59288 4.59354 0.75 6.62842 0.75 8.75021C0.75 10.872 1.59288 12.9069 3.09321 14.4072C4.59354 15.9075 6.62842 16.7504 8.75021 16.7504C10.872 16.7504 12.9069 15.9075 14.4072 14.4072Z"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

