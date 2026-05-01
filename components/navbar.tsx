"use client";

import { useRouter, usePathname } from "next/navigation";
import { Button } from "./ui/button";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useRef, useEffect } from "react";
import { tradeItems } from "@/lib/constants";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useWallet } from "@/hooks/use-wallet";
import { useAppModeStore } from "@/store/app-mode-store";
import { useViewportScale } from "@/lib/hooks/useViewportScale";

interface Navbar {
  items: {
    title: string;
    link: string;
    group: string;
  }[];
}

/** Margin lives at `/` and remains available at `/margin` for existing links. */
function isNavItemActive(
  pathname: string,
  item: { title: string; link: string }
): boolean {
  if (item.title === "Trade") {
    return (
      pathname === item.link ||
      pathname.startsWith(`${item.link}/`) ||
      tradeItems.some((tradeItem) => pathname === tradeItem.link)
    );
  }
  if (item.title === "Margin") {
    return pathname === "/" || pathname === "/margin";
  }
  return (
    pathname === item.link ||
    (item.link !== "/" && pathname.startsWith(`${item.link}/`))
  );
}

export const Navbar = (props: Navbar) => {
  const pathname = usePathname();
  const router = useRouter();
  const { isDark, toggleTheme } = useTheme();
  const zoom = useViewportScale(1440);
  useUserStore();
  const { address, connectWallet, disconnectWallet, isLoading } = useWallet();
  const appMode = useAppModeStore((s) => s.mode);
  const setAppMode = useAppModeStore((s) => s.set);

  // In lite mode, hide Trade, Farm, and Portfolio from navigation
  const LITE_HIDDEN_TITLES = ["Trade", "Farm", "Portfolio"];
  const filteredItems =
    appMode === "lite"
      ? props.items.filter((item) => !LITE_HIDDEN_TITLES.includes(item.title))
      : props.items;

  // Redirect to Margin (/) when user lands on a lite-hidden route in lite mode
  useEffect(() => {
    if (appMode !== "lite") return;
    const hiddenRoutes = props.items
      .filter((i) => LITE_HIDDEN_TITLES.includes(i.title))
      .map((i) => i.link);
    if (
      hiddenRoutes.some(
        (link) => pathname === link || pathname.startsWith(link + "/")
      )
    ) {
      router.replace("/");
    }
  }, [appMode, pathname, props.items, router]);

  const groupedItems = {
    primary: filteredItems.filter((item) => item.group === "primary"),
    bordered: filteredItems.filter((item) => item.group === "bordered"),
    secondary: filteredItems.filter((item) => item.group === "secondary"),
  };

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isWalletDropdownOpen, setIsWalletDropdownOpen] = useState(false);
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const walletMenuRef = useRef<HTMLDivElement>(null);
  const walletMenuMobileRef = useRef<HTMLDivElement>(null);
  const walletCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
      if (walletCloseTimeoutRef.current)
        clearTimeout(walletCloseTimeoutRef.current);
    };
  }, []);

  // Close wallet menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inDesktop = walletMenuRef.current?.contains(target);
      const inMobile = walletMenuMobileRef.current?.contains(target);
      if (!inDesktop && !inMobile) setIsWalletDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleNavItemClickWithLink = (item: {
    title: string;
    link: string;
  }) => {
    if (item.title === "Trade") return;
    router.push(item.link);
  };

  const handleMouseEnter = (item: { title: string; link: string }) => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    if (item.title === "Trade") setIsDropdownOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef.current = setTimeout(() => {
      setIsDropdownOpen(false);
    }, 150);
  };

  const handleDropdownMouseEnter = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const handleDropdownMouseLeave = () => {
    setIsDropdownOpen(false);
  };

  const handleWalletClick = () => {
    setIsWalletDropdownOpen(!isWalletDropdownOpen);
  };
  const handleDisconnect = () => {
    disconnectWallet();
    setIsWalletDropdownOpen(false);
  };

  const handleNavKeyDown =
    (item: { title: string; link: string }) => (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleNavItemClickWithLink(item);
      }
      if (event.key === "Escape") setIsDropdownOpen(false);
    };

  return (
    <div
      className={`sticky top-0 z-[1000] ${
        isDark
          ? "bg-[#111111] border-b border-[rgba(255,255,255,0.06)]"
          : "bg-white border-b border-[#EBEBEB]"
      }`}
      style={{ zoom }}
    >
      <motion.div
        className="h-[56px] xl:h-[72px] px-4 sm:px-8 xl:px-[48px] w-full flex items-center overflow-visible"
        initial={{ y: -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        {/* Logo section */}
        <div className="flex-1 flex items-center gap-3 min-w-0">
          <motion.a
            href="/"
            className="cursor-pointer shrink-0"
            aria-label="Vanna home page"
            initial={{
              scale: 0,
              rotate: -180,
              opacity: 0,
            }}
            animate={{
              scale: 1,
              rotate: 0,
              opacity: 1,
            }}
            transition={{
              type: "spring",
              stiffness: 260,
              damping: 20,
              duration: 0.8,
            }}
            whileHover={{
              scale: 1.05,
              rotate: [0, -5, 5, -5, 0],
              transition: {
                rotate: {
                  duration: 0.5,
                  ease: "easeInOut",
                },
                scale: {
                  type: "spring",
                  stiffness: 400,
                  damping: 17,
                },
              },
            }}
            whileTap={{ scale: 0.95 }}
          >
            {/* Desktop: full logo */}
            <Image
              alt="Vanna"
              width={307}
              height={96}
              className="hidden sm:block h-[36px] w-auto xl:h-[46px]"
              src={isDark ? "/logos/vanna-white.png" : "/logos/vanna.png"}
            />
            {/* Mobile: icon only */}
            <Image
              alt="Vanna"
              width={96}
              height={96}
              className="sm:hidden h-[28px] w-[28px]"
              src="/logos/vanna-icon.png"
            />
          </motion.a>
          {/* Pro / Lite mode toggle — sits next to the logo */}
          <div
            className={`hidden sm:inline-flex relative items-center w-[84px] h-[26px] rounded-[8px] p-[2px] cursor-pointer select-none shrink-0 ${
              isDark
                ? "bg-[#1E1E1E] border border-[#2C2C2C]"
                : "bg-[#F4F4F4] border border-[#E5E7EB]"
            }`}
            onClick={() =>
              setAppMode({ mode: appMode === "pro" ? "lite" : "pro" })
            }
            role="switch"
            aria-checked={appMode === "lite"}
            aria-label="Toggle between Pro and Lite mode"
          >
            <motion.div
              className="absolute top-[2px] h-[22px] rounded-[6px] bg-gradient"
              animate={{
                left: appMode === "pro" ? "2px" : "calc(50%)",
                width: "calc(50% - 2px)",
              }}
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
            />
            <div className="relative z-10 flex w-full">
              <button
                type="button"
                className={`flex-1 text-center text-[10.5px] font-semibold leading-[22px] transition-colors rounded-[6px] ${
                  appMode === "pro"
                    ? "text-white"
                    : isDark
                    ? "text-[#595959]"
                    : "text-[#A9A9A9]"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setAppMode({ mode: "pro" });
                }}
              >
                Pro
              </button>
              <button
                type="button"
                className={`flex-1 text-center text-[10.5px] font-semibold leading-[22px] transition-colors rounded-[6px] ${
                  appMode === "lite"
                    ? "text-white"
                    : isDark
                    ? "text-[#595959]"
                    : "text-[#A9A9A9]"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setAppMode({ mode: "lite" });
                }}
              >
                Lite
              </button>
            </div>
          </div>
          {/* Mobile: current page name */}
          <span
            className={`sm:hidden text-[15px] font-bold ${
              isDark ? "text-white" : "text-[#111111]"
            }`}
          >
            {(() => {
              if (pathname === "/" || pathname === "/margin") return "Margin";
              if (pathname.startsWith("/trade/spot")) return "Spot";
              if (pathname.startsWith("/trade")) return "Trade";
              if (pathname.startsWith("/farm")) return "Farm";
              if (pathname.startsWith("/earn")) return "Earn";
              if (pathname.startsWith("/portfolio")) return "Portfolio";
              return "";
            })()}
          </span>
        </div>

        {/* Navigation items — desktop only */}
        <div className="hidden xl:flex gap-2 items-center">
          {groupedItems.primary.map((item, idx) => {
            const isActive = isNavItemActive(pathname, item);
            return (
              <motion.div
                key={item.link}
                onClick={() => {
                  handleNavItemClickWithLink(item);
                }}
                onKeyDown={handleNavKeyDown(item)}
                role="button"
                tabIndex={0}
                className={`rounded-[8px] py-[9px] px-[16px] text-[14px] font-semibold group flex gap-1.5 items-center hover:text-[#FF007A] cursor-pointer transition-colors ${
                  isActive
                    ? "bg-[#FFE6F2] text-[#FF007A]"
                    : isDark
                    ? "text-white"
                    : ""
                }`}
                aria-label={`Navigate to ${item.title}`}
                aria-current={isActive ? "page" : undefined}
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.3,
                  delay: idx * 0.1,
                  ease: "easeOut",
                }}
                whileHover={{
                  scale: 0.95,
                  transition: { type: "spring", stiffness: 300, damping: 15 },
                }}
                whileTap={{ scale: 0.95 }}
              >
                {item.title}
              </motion.div>
            );
          })}
          <div
            className={`rounded-[8px] border-[1px] ${
              isDark ? "border-[#2A2A2A]" : "border-[#E5E7EB]"
            } p-1 flex gap-1 overflow-visible`}
          >
            {groupedItems.bordered.map((item, idx) => {
              const isActive = isNavItemActive(pathname, item);

              if (item.title === "Trade") {
                return (
                  <div key={item.link} className="relative">
                    <motion.div
                      onHoverStart={() => handleMouseEnter(item)}
                      onHoverEnd={handleMouseLeave}
                      onClick={() => handleNavItemClickWithLink(item)}
                      onKeyDown={handleNavKeyDown(item)}
                      role="button"
                      tabIndex={0}
                      className={`rounded-[8px] py-[9px] px-[16px] text-[14px] font-semibold group flex gap-1.5 items-center hover:text-[#FF007A] cursor-pointer transition-colors ${
                        isActive
                          ? "bg-[#FFE6F2] text-[#FF007A]"
                          : isDark
                          ? "text-white"
                          : ""
                      }`}
                      aria-haspopup="menu"
                      aria-expanded={isDropdownOpen}
                      aria-controls="trade-menu"
                      aria-label="Navigate to Trade"
                      aria-current={isActive ? "page" : undefined}
                      initial={{ opacity: 0, y: -20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.3,
                        delay: idx * 0.1,
                        ease: "easeOut",
                      }}
                      whileTap={{ scale: 0.95 }}
                    >
                      {item.title}
                      <motion.div
                        className="w-3 h-3 flex justify-center items-center"
                        animate={{ rotate: isDropdownOpen ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <svg width="10" height="6" viewBox="0 0 18 10" fill="none">
                          <path
                            d="M17 1L9 9L0.999999 1"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={
                              isActive
                                ? "stroke-[#FF007A]"
                                : isDark
                                ? "stroke-white group-hover:stroke-[#FF007A]"
                                : "stroke-black group-hover:stroke-[#FF007A]"
                            }
                          />
                        </svg>
                      </motion.div>
                    </motion.div>

                    {/* Floating card dropdown */}
                    <AnimatePresence>
                      {isDropdownOpen && (
                        <motion.div
                          id="trade-menu"
                          role="menu"
                          aria-label="Trade menu"
                          initial={{ opacity: 0, y: 6, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 6, scale: 0.97 }}
                          transition={{ duration: 0.18, ease: "easeOut" }}
                          onMouseEnter={handleDropdownMouseEnter}
                          onMouseLeave={handleDropdownMouseLeave}
                          className={`absolute top-[calc(100%+10px)] left-1/2 -translate-x-1/2 z-50 w-[200px] rounded-[14px] overflow-hidden ${
                            isDark
                              ? "bg-[#161616] border border-[#2A2A2A]"
                              : "bg-white border border-[#E8E8E8]"
                          }`}
                          style={{
                            boxShadow: isDark
                              ? "0 12px 40px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.04)"
                              : "0 12px 40px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04)",
                          }}
                        >
                          <div className="p-[6px]">
                            {tradeItems.map((tradeItem) => {
                              const isTradeActive =
                                pathname === tradeItem.link;
                              return (
                                <motion.div
                                  key={tradeItem.link}
                                  role="menuitem"
                                  tabIndex={0}
                                  onClick={() =>
                                    handleNavItemClickWithLink(tradeItem)
                                  }
                                  onKeyDown={handleNavKeyDown(tradeItem)}
                                  className={`flex items-center gap-3 px-3 py-[10px] rounded-[10px] cursor-pointer transition-colors ${
                                    isTradeActive
                                      ? isDark
                                        ? "bg-[#1E1E1E] text-[#FF007A]"
                                        : "bg-[#FFF0F6] text-[#FF007A]"
                                      : isDark
                                      ? "text-[#C0C0C0] hover:bg-[#1E1E1E] hover:text-white"
                                      : "text-[#3A3A3A] hover:bg-[#F5F5F5] hover:text-[#111]"
                                  }`}
                                  whileHover={{ x: 2 }}
                                  whileTap={{ scale: 0.98 }}
                                  transition={{ duration: 0.12 }}
                                >
                                  {/* Icon */}
                                  <div
                                    className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                                      isDark ? "bg-[#242424]" : "bg-[#F0F0F0]"
                                    }`}
                                  >
                                    {tradeItem.title === "Spot" ? (
                                      <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                      >
                                        <circle
                                          cx="12"
                                          cy="12"
                                          r="4"
                                          stroke={
                                            isTradeActive
                                              ? "#FF007A"
                                              : isDark
                                              ? "#A0A0A0"
                                              : "#666"
                                          }
                                          strokeWidth="2"
                                        />
                                        <path
                                          d="M12 2v3M12 19v3M2 12h3M19 12h3"
                                          stroke={
                                            isTradeActive
                                              ? "#FF007A"
                                              : isDark
                                              ? "#A0A0A0"
                                              : "#666"
                                          }
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                        />
                                      </svg>
                                    ) : (
                                      <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                      >
                                        <path
                                          d="M3 17l4-8 4 4 4-6 4 10"
                                          stroke={
                                            isTradeActive
                                              ? "#FF007A"
                                              : isDark
                                              ? "#A0A0A0"
                                              : "#666"
                                          }
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        />
                                      </svg>
                                    )}
                                  </div>
                                  <div>
                                    <p className="text-[13px] font-semibold leading-tight">
                                      {tradeItem.title}
                                    </p>
                                    <p
                                      className={`text-[11px] mt-0.5 whitespace-nowrap ${
                                        isDark ? "text-[#666]" : "text-[#999]"
                                      }`}
                                    >
                                      {tradeItem.title === "Spot"
                                        ? "Leveraged Spot"
                                        : "Leverage over Leverage"}
                                    </p>
                                  </div>
                                </motion.div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              }

              return (
                <motion.div
                  key={item.link}
                  onClick={() => handleNavItemClickWithLink(item)}
                  onKeyDown={handleNavKeyDown(item)}
                  role="button"
                  tabIndex={0}
                  className={`rounded-[8px] py-[9px] px-[16px] text-[14px] font-semibold group flex gap-1.5 items-center hover:text-[#FF007A] cursor-pointer transition-colors ${
                    isActive
                      ? "bg-[#FFE6F2] text-[#FF007A]"
                      : isDark
                      ? "text-white"
                      : ""
                  }`}
                  aria-label={`Navigate to ${item.title}`}
                  aria-current={isActive ? "page" : undefined}
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.3,
                    delay: idx * 0.1,
                    ease: "easeOut",
                  }}
                  whileTap={{ scale: 0.95 }}
                >
                  {item.title == "Margin" && (
                    <div className="w-4 h-4 flex flex-col justify-center items-center">
                      <svg
                        width="8"
                        height="13"
                        viewBox="0 0 8 13"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          opacity="0.3"
                          d="M7.33332 4L3.99999 0.666672L0.666656 4"
                          className={`transition-colors ${
                            isActive
                              ? "stroke-[#FF007A]"
                              : isDark
                              ? "stroke-white group-hover:stroke-[#FF007A]"
                              : "stroke-black group-hover:stroke-[#FF007A]"
                          }`}
                          strokeWidth="1.33333"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          opacity="0.6"
                          d="M7.33332 8L3.99999 4.66667L0.666656 8"
                          className={`transition-colors ${
                            isActive
                              ? "stroke-[#FF007A]"
                              : isDark
                              ? "stroke-white group-hover:stroke-[#FF007A]"
                              : "stroke-black group-hover:stroke-[#FF007A]"
                          }`}
                          strokeWidth="1.33333"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M7.33332 12L3.99999 8.66667L0.666656 12"
                          className={`transition-colors ${
                            isActive
                              ? "stroke-[#FF007A]"
                              : isDark
                              ? "stroke-white group-hover:stroke-[#FF007A]"
                              : "stroke-black group-hover:stroke-[#FF007A]"
                          }`}
                          strokeWidth="1.33333"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  )}
                  {item.title}
                </motion.div>
              );
            })}
          </div>
          {groupedItems.secondary.map((item, idx) => {
            const isActive = isNavItemActive(pathname, item);
            return (
              <motion.div
                key={item.link}
                onClick={() => {
                  handleNavItemClickWithLink(item);
                }}
                onKeyDown={handleNavKeyDown(item)}
                role="button"
                tabIndex={0}
                className={`rounded-[8px] py-[9px] px-[16px] text-[14px] font-semibold group flex gap-1.5 items-center hover:text-[#FF007A] cursor-pointer transition-colors ${
                  isActive
                    ? "bg-[#FFE6F2] text-[#FF007A]"
                    : isDark
                    ? "text-white"
                    : ""
                }`}
                aria-label={`Navigate to ${item.title}`}
                aria-current={isActive ? "page" : undefined}
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.3,
                  delay: idx * 0.1,
                  ease: "easeOut",
                }}
                whileHover={{
                  scale: 0.95,
                  transition: { type: "spring", stiffness: 300, damping: 15 },
                }}
                whileTap={{ scale: 0.95 }}
              >
                {item.title}
              </motion.div>
            );
          })}
        </div>

        <div className="flex-1 flex items-center justify-end">
          {/* Right section — xl+: deposit + wallet menu */}
          <motion.div
            className="hidden xl:flex items-center gap-3"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.3, ease: "easeOut" }}
          >
            {/* Wallet / Login */}
            {!address ? (
              <div className="hidden xl:block">
                <Button
                  size="small"
                  type="navbar"
                  disabled={isLoading}
                  onClick={connectWallet}
                  text={isLoading ? "Connecting..." : "Connect Wallet"}
                  ariaLabel="Connect your Freighter wallet"
                />
              </div>
            ) : (
              <div className="hidden xl:block relative" ref={walletMenuRef}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleWalletClick}
                  className={`flex items-center gap-2.5 py-[10px] pl-3 pr-4 rounded-xl font-semibold text-[13px] cursor-pointer transition-colors ${
                    isDark
                      ? "bg-[#1C1C1C] border border-[#2A2A2A] text-white hover:border-[#3A3A3A]"
                      : "bg-[#F7F7F7] border border-[#DFDFDF] text-[#1F1F1F] hover:border-[#BFBFBF]"
                  }`}
                >
                  <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 overflow-hidden">
                    <Image
                      src="/coins/xlmbg.png"
                      width={24}
                      height={24}
                      alt="Stellar"
                    />
                  </div>
                  <span className="font-mono text-[14px]">
                    {address.slice(0, 6) + "..." + address.slice(-4)}
                  </span>
                  <motion.svg
                    animate={{ rotate: isWalletDropdownOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className={isDark ? "text-[#595959]" : "text-[#949494]"}
                  >
                    <path
                      d="M3 4.5L6 7.5L9 4.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </motion.svg>
                </motion.button>
                <AnimatePresence>
                  {isWalletDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className={`absolute right-0 top-full mt-[10px] w-[280px] rounded-[14px] overflow-hidden z-50 ${
                        isDark
                          ? "bg-[#161616] border border-[#2A2A2A]"
                          : "bg-white border border-[#E8E8E8]"
                      }`}
                      style={{
                        boxShadow: isDark
                          ? "0 12px 40px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.04)"
                          : "0 12px 40px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04)",
                      }}
                    >
                      {/* User info header */}
                      <div
                        className={`px-4 py-3 border-b ${
                          isDark ? "border-[#222222]" : "border-[#F0F0F0]"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background:
                                "linear-gradient(135deg, #FC5457 10%, #703AE6 80%)",
                            }}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <rect
                                x="2"
                                y="6"
                                width="20"
                                height="14"
                                rx="3"
                                stroke="white"
                                strokeWidth="2"
                              />
                              <circle
                                cx="7"
                                cy="16"
                                r="1.5"
                                fill="white"
                              />
                            </svg>
                          </div>
                          <div>
                            <p
                              className={`text-[13px] font-semibold ${
                                isDark ? "text-white" : "text-[#111]"
                              }`}
                            >
                              Freighter Wallet
                            </p>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(address);
                              }}
                              className={`flex items-center gap-1 text-[11px] font-mono mt-0.5 cursor-pointer ${
                                isDark
                                  ? "text-[#666] hover:text-[#9F7BEE]"
                                  : "text-[#999] hover:text-[#703AE6]"
                              }`}
                            >
                              {address.slice(0, 6) +
                                "..." +
                                address.slice(-4)}
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <rect
                                  x="9"
                                  y="9"
                                  width="13"
                                  height="13"
                                  rx="2"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                />
                                <path
                                  d="M5 15V5C5 3.89 5.89 3 7 3H17"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="p-[6px]">
                        {/* Network */}
                        <div
                          className={`flex items-center gap-3 px-3 py-[10px] rounded-[10px] ${
                            isDark ? "text-[#C0C0C0]" : "text-[#3A3A3A]"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                              isDark ? "bg-[#242424]" : "bg-[#F0F0F0]"
                            }`}
                          >
                            <Image
                              src="/coins/xlmbg.png"
                              width={16}
                              height={16}
                              alt="Network"
                            />
                          </div>
                          <div className="flex-1">
                            <p className="text-[13px] font-semibold leading-tight">
                              Stellar Testnet
                            </p>
                            <p
                              className={`text-[11px] mt-0.5 ${
                                isDark ? "text-[#666]" : "text-[#999]"
                              }`}
                            >
                              Network
                            </p>
                          </div>
                          <span className="text-[11px] font-semibold text-emerald-500">
                            Active
                          </span>
                        </div>
                        {/* Dark Mode */}
                        <button
                          onClick={toggleTheme}
                          className={`w-full flex items-center gap-3 px-3 py-[10px] rounded-[10px] cursor-pointer transition-colors ${
                            isDark
                              ? "text-[#C0C0C0] hover:bg-[#1E1E1E]"
                              : "text-[#3A3A3A] hover:bg-[#F5F5F5]"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                              isDark ? "bg-[#242424]" : "bg-[#F0F0F0]"
                            }`}
                          >
                            {isDark ? (
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <circle
                                  cx="12"
                                  cy="12"
                                  r="4"
                                  stroke="#A0A0A0"
                                  strokeWidth="1.5"
                                />
                                <path
                                  d="M12 2V4M12 20V22M4.22 4.22L5.64 5.64M18.36 18.36L19.78 19.78M2 12H4M20 12H22M4.22 19.78L5.64 18.36M18.36 5.64L19.78 4.22"
                                  stroke="#A0A0A0"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                />
                              </svg>
                            ) : (
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <path
                                  d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                                  stroke="#666"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 text-left">
                            <p className="text-[13px] font-semibold leading-tight">
                              Dark Mode
                            </p>
                            <p
                              className={`text-[11px] mt-0.5 ${
                                isDark ? "text-[#666]" : "text-[#999]"
                              }`}
                            >
                              {isDark ? "On" : "Off"}
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={isDark}
                            className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 ${
                              isDark ? "bg-[#703AE6]" : "bg-[#D1D5DB]"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                                isDark ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </button>
                      </div>
                      {/* Disconnect */}
                      <div
                        className={`border-t mx-1.5 pt-1.5 pb-1.5 ${
                          isDark ? "border-[#222]" : "border-[#F0F0F0]"
                        }`}
                      >
                        <button
                          onClick={handleDisconnect}
                          className={`w-full flex items-center gap-3 px-3 py-[10px] rounded-[10px] cursor-pointer transition-colors ${
                            isDark
                              ? "text-[#FC5457] hover:bg-[#FC5457]/10"
                              : "text-[#FC5457] hover:bg-[#FC5457]/5"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                              isDark
                                ? "bg-[#FC5457]/10"
                                : "bg-[#FC5457]/5"
                            }`}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <path
                                d="M9 21H5C3.89 21 3 20.1 3 19V5C3 3.89 3.89 3 5 3H9"
                                stroke="#FC5457"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                              <path
                                d="M16 17L21 12L16 7"
                                stroke="#FC5457"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M21 12H9"
                                stroke="#FC5457"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          </div>
                          <p className="text-[13px] font-semibold">
                            Disconnect
                          </p>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>

          {/* Right section — below xl: login/wallet + hamburger */}
          <motion.div
            className="flex xl:hidden gap-[8px] items-center flex-shrink-0"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.3, ease: "easeOut" }}
          >
            {!address ? (
              <Button
                size="small"
                type="gradient"
                disabled={isLoading}
                onClick={connectWallet}
                text={isLoading ? "..." : "Connect"}
                ariaLabel="Connect your Freighter wallet"
              />
            ) : (
              <div className="relative" ref={walletMenuMobileRef}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleWalletClick}
                  className={`flex items-center gap-1.5 py-1.5 pl-2 pr-2.5 rounded-lg text-[12px] font-semibold cursor-pointer ${
                    isDark
                      ? "bg-[#1C1C1C] border border-[#2A2A2A] text-white"
                      : "bg-[#F7F7F7] border border-[#DFDFDF] text-[#1F1F1F]"
                  }`}
                >
                  <Image
                    src="/coins/xlmbg.png"
                    width={16}
                    height={16}
                    alt="Stellar"
                    className="rounded-full"
                  />
                  <span className="font-mono">
                    {address.slice(0, 4) + "..." + address.slice(-3)}
                  </span>
                </motion.button>
                <AnimatePresence>
                  {isWalletDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className={`absolute right-0 top-full mt-[10px] w-[280px] rounded-[14px] overflow-hidden z-50 ${
                        isDark
                          ? "bg-[#161616] border border-[#2A2A2A]"
                          : "bg-white border border-[#E8E8E8]"
                      }`}
                      style={{
                        boxShadow: isDark
                          ? "0 12px 40px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.04)"
                          : "0 12px 40px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04)",
                      }}
                    >
                      <div
                        className={`px-4 py-3 border-b ${
                          isDark ? "border-[#222222]" : "border-[#F0F0F0]"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background:
                                "linear-gradient(135deg, #FC5457 10%, #703AE6 80%)",
                            }}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <rect
                                x="2"
                                y="6"
                                width="20"
                                height="14"
                                rx="3"
                                stroke="white"
                                strokeWidth="2"
                              />
                              <circle
                                cx="7"
                                cy="16"
                                r="1.5"
                                fill="white"
                              />
                            </svg>
                          </div>
                          <div>
                            <p
                              className={`text-[13px] font-semibold ${
                                isDark ? "text-white" : "text-[#111]"
                              }`}
                            >
                              Freighter Wallet
                            </p>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(address);
                              }}
                              className={`flex items-center gap-1 text-[11px] font-mono mt-0.5 cursor-pointer ${
                                isDark
                                  ? "text-[#666] hover:text-[#9F7BEE]"
                                  : "text-[#999] hover:text-[#703AE6]"
                              }`}
                            >
                              {address.slice(0, 6) +
                                "..." +
                                address.slice(-4)}
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <rect
                                  x="9"
                                  y="9"
                                  width="13"
                                  height="13"
                                  rx="2"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                />
                                <path
                                  d="M5 15V5C5 3.89 5.89 3 7 3H17"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="p-[6px]">
                        <div
                          className={`flex items-center gap-3 px-3 py-[10px] rounded-[10px] ${
                            isDark ? "text-[#C0C0C0]" : "text-[#3A3A3A]"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                              isDark ? "bg-[#242424]" : "bg-[#F0F0F0]"
                            }`}
                          >
                            <Image
                              src="/coins/xlmbg.png"
                              width={16}
                              height={16}
                              alt="Network"
                            />
                          </div>
                          <div className="flex-1">
                            <p className="text-[13px] font-semibold leading-tight">
                              Stellar Testnet
                            </p>
                            <p
                              className={`text-[11px] mt-0.5 ${
                                isDark ? "text-[#666]" : "text-[#999]"
                              }`}
                            >
                              Network
                            </p>
                          </div>
                          <span className="text-[11px] font-semibold text-emerald-500">
                            Active
                          </span>
                        </div>
                        <button
                          onClick={toggleTheme}
                          className={`w-full flex items-center gap-3 px-3 py-[10px] rounded-[10px] cursor-pointer transition-colors ${
                            isDark
                              ? "text-[#C0C0C0] hover:bg-[#1E1E1E]"
                              : "text-[#3A3A3A] hover:bg-[#F5F5F5]"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                              isDark ? "bg-[#242424]" : "bg-[#F0F0F0]"
                            }`}
                          >
                            {isDark ? (
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <circle
                                  cx="12"
                                  cy="12"
                                  r="4"
                                  stroke="#A0A0A0"
                                  strokeWidth="1.5"
                                />
                                <path
                                  d="M12 2V4M12 20V22M4.22 4.22L5.64 5.64M18.36 18.36L19.78 19.78M2 12H4M20 12H22M4.22 19.78L5.64 18.36M18.36 5.64L19.78 4.22"
                                  stroke="#A0A0A0"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                />
                              </svg>
                            ) : (
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <path
                                  d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                                  stroke="#666"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 text-left">
                            <p className="text-[13px] font-semibold leading-tight">
                              Dark Mode
                            </p>
                            <p
                              className={`text-[11px] mt-0.5 ${
                                isDark ? "text-[#666]" : "text-[#999]"
                              }`}
                            >
                              {isDark ? "On" : "Off"}
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={isDark}
                            className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 ${
                              isDark ? "bg-[#703AE6]" : "bg-[#D1D5DB]"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                                isDark ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </button>
                      </div>
                      <div
                        className={`border-t mx-1.5 pt-1.5 pb-1.5 ${
                          isDark ? "border-[#222]" : "border-[#F0F0F0]"
                        }`}
                      >
                        <button
                          onClick={handleDisconnect}
                          className={`w-full flex items-center gap-3 px-3 py-[10px] rounded-[10px] cursor-pointer transition-colors ${
                            isDark
                              ? "text-[#FC5457] hover:bg-[#FC5457]/10"
                              : "text-[#FC5457] hover:bg-[#FC5457]/5"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
                              isDark
                                ? "bg-[#FC5457]/10"
                                : "bg-[#FC5457]/5"
                            }`}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <path
                                d="M9 21H5C3.89 21 3 20.1 3 19V5C3 3.89 3.89 3 5 3H9"
                                stroke="#FC5457"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                              <path
                                d="M16 17L21 12L16 7"
                                stroke="#FC5457"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M21 12H9"
                                stroke="#FC5457"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          </div>
                          <p className="text-[13px] font-semibold">
                            Disconnect
                          </p>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
            {/* Hamburger menu button */}
            <motion.button
              type="button"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="flex flex-col justify-center items-center rounded-[8px] py-1.5 px-2 h-8.5 border cursor-pointer"
              aria-label="Toggle mobile menu"
              aria-expanded={isMobileMenuOpen}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <div className="w-4.5 h-4.5 flex flex-col justify-center items-center gap-1">
                <motion.span
                  className={`w-full h-[2px] rounded-full ${
                    isDark ? "bg-white" : "bg-black"
                  }`}
                  animate={{
                    rotate: isMobileMenuOpen ? 45 : 0,
                    y: isMobileMenuOpen ? 6 : 0,
                  }}
                  transition={{ duration: 0.2 }}
                />
                <motion.span
                  className={`w-full h-[2px] rounded-full ${
                    isDark ? "bg-white" : "bg-black"
                  }`}
                  animate={{ opacity: isMobileMenuOpen ? 0 : 1 }}
                  transition={{ duration: 0.2 }}
                />
                <motion.span
                  className={`w-full h-[2px] rounded-full ${
                    isDark ? "bg-white" : "bg-black"
                  }`}
                  animate={{
                    rotate: isMobileMenuOpen ? -45 : 0,
                    y: isMobileMenuOpen ? -6 : 0,
                  }}
                  transition={{ duration: 0.2 }}
                />
              </div>
            </motion.button>
          </motion.div>
        </div>
      </motion.div>

      {/* Mobile menu panel — overlays page content */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            {/* Backdrop — tap to close */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="xl:hidden fixed inset-0 top-full bg-black/50 backdrop-blur-sm"
              onClick={() => setIsMobileMenuOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className={`xl:hidden absolute left-3 right-3 top-[calc(100%+6px)] rounded-2xl border shadow-2xl ${
                isDark
                  ? "bg-[#1A1A1A] border-[#2A2A2A]"
                  : "bg-white border-[#E8E8E8]"
              }`}
            >
              <nav className="flex flex-col p-2 gap-0.5">
                {/* All nav items */}
                {[...groupedItems.primary, ...groupedItems.bordered].map(
                  (item, idx) => {
                    const isActive = isNavItemActive(pathname, item);
                    return (
                      <div key={item.link}>
                        <motion.div
                          onClick={() => {
                            if (item.title === "Trade") {
                              setIsDropdownOpen(!isDropdownOpen);
                            } else {
                              handleNavItemClickWithLink(item);
                              setIsMobileMenuOpen(false);
                            }
                          }}
                          className={`px-3 py-2.5 rounded-xl text-[13px] font-semibold cursor-pointer transition-all flex items-center justify-between ${
                            isActive
                              ? "bg-[#703AE6]/10 text-[#703AE6]"
                              : isDark
                              ? "text-[#E0E0E0] hover:bg-[#222222] active:bg-[#222222]"
                              : "text-[#333333] hover:bg-[#F5F5F5] active:bg-[#F0F0F0]"
                          }`}
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.15, delay: idx * 0.03 }}
                        >
                          <span className="flex items-center gap-2.5">
                            {item.title}
                          </span>
                          {item.title === "Trade" && (
                            <motion.svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              animate={{ rotate: isDropdownOpen ? 180 : 0 }}
                              transition={{ duration: 0.2 }}
                            >
                              <path
                                d="M3.5 5.25L7 8.75L10.5 5.25"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </motion.svg>
                          )}
                        </motion.div>

                        {/* Trade sub-items */}
                        <AnimatePresence>
                          {item.title === "Trade" && isDropdownOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div
                                className={`flex flex-col ml-3 mt-0.5 mb-0.5 pl-3 gap-0.5 border-l-2 ${
                                  isDark
                                    ? "border-[#333333]"
                                    : "border-[#E8E8E8]"
                                }`}
                              >
                                {tradeItems.map((tradeItem, subIdx) => {
                                  const isSubActive =
                                    pathname === tradeItem.link;
                                  return (
                                    <motion.div
                                      key={tradeItem.link}
                                      onClick={() => {
                                        handleNavItemClickWithLink(tradeItem);
                                        setIsMobileMenuOpen(false);
                                        setIsDropdownOpen(false);
                                      }}
                                      className={`px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer transition-colors ${
                                        isSubActive
                                          ? "text-[#703AE6] bg-[#703AE6]/10"
                                          : isDark
                                          ? "text-[#999999] hover:text-white hover:bg-[#222222]"
                                          : "text-[#777777] hover:text-[#111111] hover:bg-[#F5F5F5]"
                                      }`}
                                      initial={{ opacity: 0, x: -8 }}
                                      animate={{ opacity: 1, x: 0 }}
                                      transition={{
                                        duration: 0.12,
                                        delay: subIdx * 0.03,
                                      }}
                                    >
                                      {tradeItem.title}
                                    </motion.div>
                                  );
                                })}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  }
                )}

              </nav>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};
