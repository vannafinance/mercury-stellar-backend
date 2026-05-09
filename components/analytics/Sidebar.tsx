"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  // Hidden: old Overview V1 — kept for reference, superseded by Overview V2
  // {
  //   label: "Overview",
  //   href: "/",
  //   icon: (
  //     <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
  //       <rect x="1" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
  //       <rect x="10" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
  //       <rect x="1" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
  //       <rect x="10" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
  //     </svg>
  //   ),
  // },
  {
    label: "Overview",
    href: "/analytics/overview2",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9 5V9L12 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 2.5L3 1M13 2.5L15 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Positions",
    href: "/analytics/positions",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 14L6.5 9.5L10 13L16 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 5H16V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  // Hidden: Positions+ — repeated content, superseded by Overview V2 positions table
  // {
  //   label: "Positions+",
  //   href: "/analytics/positions-advanced",
  //   icon: (
  //     <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
  //       <path d="M2 14L6.5 9.5L10 13L16 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  //       <path d="M12 5H16V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  //       <circle cx="14" cy="14" r="3.5" fill="currentColor" stroke="none" />
  //       <path d="M14 12.5V15.5M12.5 14H15.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
  //     </svg>
  //   ),
  // },
  {
    label: "Liquidations",
    href: "/analytics/liquidations",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 1L11 7H17L12 11L14 17L9 13L4 17L6 11L1 7H7L9 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Risk Explorer",
    href: "/analytics/risk-explorer",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 3H8V8H3V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M10 3H15V8H10V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M3 10H8V15H3V10Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M10 10H15V15H10V10Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M10 6.5H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M6.5 10V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Oracles",
    href: "/analytics/oracles",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
        <line x1="9" y1="2" x2="9" y2="6" stroke="currentColor" strokeWidth="1.5" />
        <line x1="9" y1="12" x2="9" y2="16" stroke="currentColor" strokeWidth="1.5" />
        <line x1="2" y1="9" x2="6" y2="9" stroke="currentColor" strokeWidth="1.5" />
        <line x1="12" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    label: "Whales",
    href: "/analytics/whales",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="9" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 15C5 13.343 6.79 12 9 12C11.21 12 13 13.343 13 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="9" cy="7" r="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    label: "Alerts",
    href: "/analytics/alerts",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 2C6.239 2 4 4.239 4 7V10L2 13H16L14 10V7C14 4.239 11.761 2 9 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M7 13V14C7 15.105 7.895 16 9 16C10.105 16 11 15.105 11 14V13" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/analytics") return pathname === "/analytics";
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-50 lg:hidden p-2 rounded-r2 bg-surface shadow-vanna border border-vgray-100 text-vgray-700"
        aria-label="Open navigation"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M3 5H17M3 10H17M3 15H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-screen w-[240px] bg-surface flex flex-col
          border-r border-vgray-100
          transition-transform duration-200 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          lg:h-auto lg:w-[232px] lg:my-4 lg:ml-4
          lg:rounded-r4 lg:border lg:border-vgray-100 lg:shadow-vanna
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Mobile close button */}
        <div className="flex justify-end px-3 pt-3 lg:hidden">
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1.5 rounded-r2 text-vgray-600 hover:text-vgray-900 hover:bg-vgray-50"
            aria-label="Close navigation"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto py-3 px-3">
          <ul className="space-y-0.5">
            {navItems.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`
                      group flex items-center gap-3 px-3 py-2.5 rounded-r2
                      text-[13px] font-semibold transition-colors duration-150
                      ${
                        active
                          ? "bg-violet-100 text-violet-600"
                          : "text-vgray-700 hover:bg-vgray-50 hover:text-vgray-900"
                      }
                    `}
                  >
                    <span
                      className={`flex-shrink-0 ${
                        active ? "text-violet-600" : "text-vgray-600 group-hover:text-vgray-800"
                      }`}
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

      </aside>
    </>
  );
}
