"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ChevronDown, ChevronUp } from "lucide-react";
import { navbarItems, tradeItems } from "@/lib/constants";

interface BurgerMenuProps {
  onClose: () => void;
}

const subIconFor: Record<string, string> = {
  Spot: "/coins/xlmbg.png",
  Futures: "/coins/xlmbg.png",
  Options: "/coins/xlmbg.png",
  "Defi Greeks": "/coins/xlmbg.png",
};

export default function BurgerMenu({ onClose }: BurgerMenuProps) {
  const [isTradeExpanded, setIsTradeExpanded] = useState(false);

  return (
    <div className="fixed inset-0 z-40 bg-white dark:bg-[#111111] text-[#111111] dark:text-white pt-16">
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto p-4 pt-2">
          {navbarItems.map((link) => (
            <div key={link.title}>
              {link.title === "Trade" ? (
                <div>
                  <button
                    onClick={() => setIsTradeExpanded(!isTradeExpanded)}
                    className="flex items-center justify-between w-full py-3 px-4 text-left text-lg font-medium"
                    aria-expanded={isTradeExpanded}
                  >
                    {link.title}
                    {isTradeExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>
                  {isTradeExpanded && (
                    <div className="pl-8 space-y-2">
                      {tradeItems.map((subLink) => (
                        <Link
                          key={subLink.title}
                          href={subLink.link}
                          onClick={onClose}
                          className="block py-2 text-base hover:text-gray-900 dark:hover:text-white transition-colors duration-200"
                        >
                          <span className="flex flex-row items-center">
                            <Image
                              width={24}
                              height={24}
                              src={subIconFor[subLink.title] || "/coins/xlmbg.png"}
                              alt={subLink.title + " menu icon"}
                              className="mr-2"
                            />{" "}
                            {subLink.title}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  href={link.link}
                  onClick={onClose}
                  className="block py-3 px-4 text-lg font-medium hover:bg-gray-100 dark:hover:bg-[#1E1E1E] transition-colors duration-200 rounded-lg"
                >
                  {link.title}
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
