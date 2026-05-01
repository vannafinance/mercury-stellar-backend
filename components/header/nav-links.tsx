"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import FeatureCard from "./feature-card";
import { navbarItems, tradeItems } from "@/lib/constants";

const tradeSubMeta: Record<
  string,
  { subtitle: string; icon: string; isSoon?: boolean }
> = {
  Spot: {
    subtitle: "Margin trade to buy/sell assets at spot prices",
    icon: "/coins/xlmbg.png",
    isSoon: false,
  },
  Futures: {
    subtitle: "Leveraged perpetual contracts to trade without expiration",
    icon: "/coins/xlmbg.png",
    isSoon: false,
  },
  Options: {
    subtitle:
      "Leveraged contracts for hedging, speculation, or income with controlled risk",
    icon: "/coins/xlmbg.png",
    isSoon: true,
  },
  "Defi Greeks": {
    subtitle: "Hedging tool to manage complex strategies with Greeks insights",
    icon: "/coins/xlmbg.png",
    isSoon: false,
  },
};

const cx = (...classes: Array<string | false | undefined | null>) =>
  classes.filter(Boolean).join(" ");

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <div className="flex flex-row gap-2 items-center justify-center text-sm">
      {navbarItems.map((link) => {
        const isTradeRoute = pathname === link.link || pathname.startsWith("/trade");
        const isMarginRoute = link.title === "Margin" && (pathname === "/" || pathname === "/margin");
        const isActive =
          pathname === link.link ||
          (link.title === "Trade" && isTradeRoute) ||
          isMarginRoute;

        const activeSub =
          link.title === "Trade"
            ? tradeItems.find((s) => pathname === s.link)?.title || ""
            : "";

        if (link.title === "Trade") {
          return (
            <div key={link.title} className="relative group">
              <Link
                href={link.link}
                className={cx(
                  "py-1 px-4 inline-flex items-center whitespace-nowrap dark:bg-[#111111] text-neutral-500",
                  isActive && activeSub
                    ? "font-medium after:content-[''] after:absolute after:left-0 after:w-full after:h-[3px] after:bg-gradient-to-r after:from-[#FF007A] after:to-[#703AE6] after:-bottom-1/4 text-[#111111] dark:text-white"
                    : "after:-bottom-2/3"
                )}
              >
                <span>{link.title}</span>
                &nbsp;&nbsp;
                {isActive && activeSub ? (
                  <div className="flex flex-row items-center p-2 bg-[#F1EBFD] dark:bg-[#1E1E1E] rounded-full">
                    <span>{activeSub}&nbsp;</span>
                    <ChevronDown size={14} />
                  </div>
                ) : (
                  <ChevronDown size={14} className="text-neutral-400" />
                )}
              </Link>
              <div
                className="absolute left-2 top-10 z-50 mt-2 rounded-md shadow-xl bg-white dark:bg-[#111111] ring-1 ring-black dark:ring-[#2A2A2A] ring-opacity-5 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300"
              >
                {tradeItems.map((subItem, index) => {
                  const meta = tradeSubMeta[subItem.title] || {
                    subtitle: "",
                    icon: "/coins/xlmbg.png",
                  };
                  return (
                    <Link
                      key={index}
                      href={subItem.link}
                      className="block p-1 w-72 text-sm"
                    >
                      <FeatureCard
                        icon={meta.icon}
                        title={subItem.title}
                        subtitle={meta.subtitle}
                        isSoon={meta.isSoon}
                      />
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        }

        return (
          <div key={link.title} className="flex items-center">
            <Link
              href={link.link}
              className={cx(
                "flex py-1 px-4 whitespace-nowrap relative text-neutral-500 dark:bg-[#111111]",
                isActive &&
                  "text-[#111111] dark:text-white font-medium after:content-[''] after:absolute after:-bottom-2/3 after:left-0 after:w-full after:h-[3px] after:bg-gradient-to-r after:from-[#FF007A] after:to-[#703AE6]"
              )}
            >
              {link.title}
            </Link>
            {link.title === "Earn" && (
              <div className="h-5 w-px bg-neutral-500 opacity-60 text-lg mx-2"></div>
            )}
          </div>
        );
      })}
    </div>
  );
}
