"use client";

import { useEffect, useState } from "react";

interface HeaderProps {
  title: string;
}

export default function Header({ title }: HeaderProps) {
  const [currentTime, setCurrentTime] = useState<string>("");
  const alertCount = 3;

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-16 px-6 bg-base-dark/80 backdrop-blur-md border-b border-vgray-100">
      <h1 className="text-lg font-bold text-vgray-800 pl-10 lg:pl-0">
        {title}
      </h1>

      <div className="flex items-center gap-5">
        <div className="hidden sm:flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-electric-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-electric-500" />
          </span>
          <span className="text-xs font-semibold text-electric-500">Live</span>
        </div>

        <div className="hidden sm:block w-px h-5 bg-vgray-100" />

        <button
          className="relative p-1.5 rounded-r2 text-vgray-400 hover:text-vgray-600 hover:bg-vgray-50 transition-colors"
          aria-label={`${alertCount} alerts`}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M10 2.5C7.238 2.5 5 4.738 5 7.5V11L3 14H17L15 11V7.5C15 4.738 12.762 2.5 10 2.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path
              d="M8 14V15C8 16.105 8.895 17 10 17C11.105 17 12 16.105 12 15V14"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          {alertCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-imperial-500 text-white text-[10px] font-bold font-mono">
              {alertCount}
            </span>
          )}
        </button>

        <div className="hidden sm:block w-px h-5 bg-vgray-100" />

        <span className="hidden sm:block text-xs font-mono font-medium text-vgray-500 tabular-nums">
          {currentTime || "--:--:--"}
        </span>
      </div>
    </header>
  );
}
