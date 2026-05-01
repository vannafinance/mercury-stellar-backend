"use client";

import Image from "next/image";
import { useState } from "react";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D"];

export default function TimeframeSelector() {
  const [active, setActive] = useState("15m");

  return (
    <div className="flex flex-1 items-center gap-0  text-xs px-2 py-2.5 my-0.5">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          onClick={() => setActive(tf)}
          className={`rounded-sm px-2 py-1.5 leading-3 font-normal transition ${
            active === tf
              ? "bg-[#703AE6] text-[#F2F4F6]"
              : "text-[#6E7583] bg-[##F7F7F7]"
          }`}
        >
          {tf}
        </button>
      ))}

      {/* dropdown arrow */}

      <button>
        <Image
          className="object-cover"
          width={16}
          height={18}
          alt="icons"
          src="/icons/dropdownArrow.svg"
        />
      </button>
    </div>
  );
}
