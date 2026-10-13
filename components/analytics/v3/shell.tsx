"use client";

/**
 * Analytics frame (ported from the Solana analytics): sidebar navigation, live status bar and the
 * shared tooltip layer. The site's own header (with its light/dark switch and wallet) stays above;
 * theme follows it through `html.dark`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clock, finite } from "@/lib/analytics/v3/format";
import { useAnalyticsData } from "./data";
import { Icon } from "./ui";
import { TooltipHost } from "./tooltip-host";

export const SECTIONS: Array<{ group: string; items: Array<{ href: string; label: string; icon: string; also?: string[]; prefix?: boolean }> }> = [
  { group: "Risk", items: [
    { href: "/analytics", label: "Overview", icon: "overview", also: ["/analytics/overview2"] },
    { href: "/analytics/positions", label: "Positions", icon: "health" },
    { href: "/analytics/liquidations", label: "Liquidations", icon: "liquidations" },
    { href: "/analytics/top-accounts", label: "Top accounts", icon: "accounts", also: ["/analytics/whales"] },
    { href: "/analytics/alerts", label: "Alerts", icon: "alerts" },
  ] },
  { group: "Markets", items: [
    { href: "/analytics/pools", label: "Lending Pools", icon: "pools" },
    { href: "/analytics/collateral", label: "Collateral", icon: "collateral" },
    { href: "/analytics/prices", label: "Prices", icon: "prices", also: ["/analytics/oracles"] },
  ] },
  { group: "Tools", items: [
    { href: "/analytics/what-if", label: "What-if Calculator", icon: "calculator", also: ["/analytics/stress-test"] },
    { href: "/analytics/risk-explorer", label: "Risk Explorer", icon: "grid", prefix: true },
    { href: "/analytics/positions-advanced", label: "Advanced positions", icon: "layers" },
  ] },
];

const isActive = (pathname: string, it: (typeof SECTIONS)[number]["items"][number]) =>
  pathname === it.href || (it.also ?? []).includes(pathname) || (!!it.prefix && pathname.startsWith(`${it.href}/`));

export function AnalyticsShell({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Every section opens at its top, not wherever the previous one was scrolled to.
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [pathname]);

  // Keep the sidebar just below the site's sticky header, whatever its height is at this screen size.
  useEffect(() => {
    const place = () => {
      const header = document.elementsFromPoint(window.innerWidth / 2, 2).find((el) => !root.current?.contains(el) && ["sticky", "fixed"].includes(getComputedStyle(el).position));
      const bottom = header ? Math.ceil(header.getBoundingClientRect().bottom) : 80;
      root.current?.style.setProperty("--an-top", `${bottom + 16}px`);
    };
    place();
    window.addEventListener("resize", place);
    const t = window.setTimeout(place, 600); // header content (wallet, fonts) can change its height just after load
    return () => { window.removeEventListener("resize", place); window.clearTimeout(t); };
  }, []);

  return (
    <div className="an-root" ref={root}>
      <div className="an-page">
        <aside className="an-sidebar" aria-label="Analytics">
          <div className="an-sidebar-caption">PROTOCOL ANALYTICS</div>
          <nav aria-label="Analytics sections">
            {SECTIONS.map((g) => (
              <div key={g.group}>
                <div className="an-nav-group-label">{g.group}</div>
                {g.items.map((it) => (
                  <Link key={it.href} href={it.href} className="an-nav-link" aria-current={isActive(pathname, it) ? "page" : undefined}>
                    <Icon name={it.icon} />{it.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="an-content" id="analytics-main">
          <StatusBar />
          {children}
        </main>
      </div>
      <TooltipHost rootRef={root} />
    </div>
  );
}

function StatusBar() {
  const d = useAnalyticsData();
  // Background polling is silent: only a click on Refresh shows a busy state.
  const [clicked, setClicked] = useState(false);
  const busy = clicked && (d.isRefreshing || d.isLoading);
  const n = d.rows?.length ?? null;
  const warming = n === null;
  const text = warming
    ? (d.isLoading ? "Reading margin accounts from Soroban…" : "Couldn't load the account snapshot. Try Refresh.")
    : `${n} open margin account${n === 1 ? "" : "s"} read from the Registry · ${d.pools.length} lending pools · Reflector prices${d.missingPrices.length ? ` (no live price: ${d.missingPrices.join(", ")})` : ""}`;
  const dot = d.error ? "an-bad" : warming || d.missingPrices.length ? "an-warn an-pulse" : "";
  return (
    <div className="an-statusbar" role="status" aria-live="polite">
      <span className="an-live"><span className={`an-dot ${dot}`} />{d.error ? "Degraded" : "Live"} · Stellar testnet</span>
      <span className="an-sep" />
      <span className="an-txt" title={d.error ?? undefined}>{text}</span>
      <span className="an-meta">{finite(d.fetchedAt) ? `Updated ${clock(d.fetchedAt)}` : "Loading…"}</span>
      <button type="button" className="an-btn an-sm" disabled={busy} onClick={() => { setClicked(true); d.refresh(); }}>{busy ? "Refreshing…" : "Refresh"}</button>
    </div>
  );
}

export function ViewHead({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="an-view-head">
      <h1>{title}</h1>
      <p>{blurb}</p>
    </div>
  );
}
