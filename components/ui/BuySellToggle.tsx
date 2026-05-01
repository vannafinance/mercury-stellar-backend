"use client";

import React from "react";

export type OrderType = "buy" | "sell";

interface BuySellToggleProps {
  value: OrderType;
  onChange: (value: OrderType) => void;
  className?: string;
}

export default function BuySellToggle({
  value,
  onChange,
  className = "",
}: BuySellToggleProps) {
  return (
    <div
      className={`flex gap-4 rounded-xl border border-[#E2E2E2] p-1.5 bg-white ${className}`}
    >
      {/* BUY */}
      <button
        type="button"
        onClick={() => onChange("buy")}
        className={`cursor-pointer flex-1 rounded-lg p-0.5 text-[12px] font-semibold transition-colors ${
          value === "buy"
            ? "bg-linear-to-r from-[#FC5457] to-[#703AE6]"
            : "bg-transparent"
        }`}
      >
        <div className="rounded-lg bg-white p-3 text-black">Buy</div>
      </button>

      {/* SELL */}
      <button
        type="button"
        onClick={() => onChange("sell")}
        className={`cursor-pointer flex-1 rounded-lg p-0.5 text-[12px] font-semibold transition-colors ${
          value === "sell"
            ? "bg-linear-to-r from-[#FC5457] to-[#703AE6]"
            : "bg-transparent"
        }`}
      >
        <div className="rounded-lg bg-white p-3 text-black">Sell</div>
      </button>
    </div>
  );
}
