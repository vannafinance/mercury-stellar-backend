/**
 * V3 icons: token / venue logos (the design's real logos, public/logos-v3) and the design's small
 * line icons. `Icon` falls back to the app's token icon, then to a lettered circle. The venue USDC
 * wrappers (BLUSDC / AQUSDC / SOUSDC) show the USDC logo.
 */
import type { ReactNode } from "react";
import { iconPaths } from "@/lib/constants";

/** Logos shipped with the design (file name = key). */
const LOGO_FILES: Record<string, string> = {
  XLM: "XLM.png", USDC: "USDC.png", USDT: "USDT.svg", ETH: "ETH.svg", BTC: "BTC.svg", SOL: "SOL.png", EURC: "EURC.svg",
  PYTH: "PYTH.png", AQUARIUS: "AQUARIUS.png", SOROSWAP: "SOROSWAP.png",
};
/** Venue logos are rounded squares, token logos circles. */
const VENUES = new Set(["PYTH", "AQUARIUS", "SOROSWAP", "BLEND"]);
/** Common aliases used across the app. */
const ALIAS: Record<string, string> = {
  BLUSDC: "USDC", AQUSDC: "USDC", SOUSDC: "USDC", AqUSDC: "USDC", SoUSDC: "USDC", BLEND_USDC: "USDC", AquiresUSDC: "USDC", SoroswapUSDC: "USDC",
  Aquarius: "AQUARIUS", Soroswap: "SOROSWAP", Pyth: "PYTH", Blend: "BLEND", Stellar: "XLM",
};

export function logoSrc(sym: string): string | null {
  const key = ALIAS[sym] ?? sym;
  if (LOGO_FILES[key]) return `/logos-v3/${LOGO_FILES[key]}`;
  if (key === "BLEND") return null;
  return iconPaths[sym] ?? iconPaths[key] ?? null;
}

/** A token or venue logo; `className` defaults to the design's 22px `.ico`. */
export function Icon({ sym, className = "ico", title }: { sym: string; className?: string; title?: string }) {
  const key = ALIAS[sym] ?? sym;
  const src = logoSrc(sym);
  if (src)
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={`${VENUES.has(key) ? "lg-p " : ""}${className}`} src={src} alt={title ?? ""} aria-hidden={title ? undefined : true} draggable={false} />;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#999" />
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="Arial,sans-serif">
        {key.slice(0, 1)}
      </text>
    </svg>
  );
}

/** The Vanna mark (gradient), as in the design's `vmark()`. */
export function VMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="12 12 104 100" aria-hidden="true">
      <defs>
        <linearGradient id="v3Brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fc5457" />
          <stop offset="1" stopColor="#703ae6" />
        </linearGradient>
      </defs>
      <path d="M59.9886 16.0614C63.1147 13.6729 67.3757 13.3951 70.7757 15.3581C74.1757 17.3211 76.0413 21.1361 75.4986 25.0161L72.1417 49.0153L72.1454 49.0174L65.6912 95.1595L102.868 66.755L114.107 73.2444L68.4972 108.093C65.3711 110.481 61.11 110.759 57.7101 108.796C54.3101 106.833 52.4445 103.018 52.9872 99.138L56.3441 75.1388L56.3404 75.1367L62.7946 28.9947L25.6183 57.3991L14.3784 50.9098L59.9886 16.0614Z" fill="url(#v3Brand)" />
      <path d="M25.6183 57.3991L36.003 63.3948L33.9183 78.2994L45.9557 69.141L56.3404 75.1367L36.6411 90.1879C33.7348 92.4085 29.7734 92.6668 26.6125 90.8418C23.4545 89.0185 21.7201 85.4763 22.2206 81.872L25.6183 57.3991Z" fill="url(#v3Brand)" />
      <path d="M102.868 66.755L92.4828 60.7594L94.5675 45.8547L82.5301 55.0131L72.1454 49.0174L91.8447 33.9662C94.751 31.7457 98.7124 31.4874 101.873 33.3123C105.031 35.1356 106.766 38.6778 106.265 42.2822L102.868 66.755Z" fill="url(#v3Brand)" />
    </svg>
  );
}

const svg = (w: number, vb: string, children: ReactNode) => (
  <svg width={w} height={w} viewBox={vb} aria-hidden="true">
    {children}
  </svg>
);
const S = { stroke: "currentColor", fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** The design's line icons (IC in core.js), 14px unless noted. */
export const IC = {
  wallet: svg(14, "0 0 16 16", <><rect x="1.5" y="3.5" width="13" height="10" rx="2" {...S} strokeWidth="1.4" /><path d="M10.5 8.5h2" {...S} strokeWidth="1.4" /></>),
  coins: svg(14, "0 0 16 16", <><ellipse cx="8" cy="4.5" rx="5" ry="2" {...S} strokeWidth="1.4" /><path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" {...S} strokeWidth="1.4" /></>),
  pct: svg(14, "0 0 16 16", <><path d="M12.5 3.5l-9 9" {...S} strokeWidth="1.4" /><circle cx="4.5" cy="4.5" r="1.8" {...S} strokeWidth="1.4" /><circle cx="11.5" cy="11.5" r="1.8" {...S} strokeWidth="1.4" /></>),
  target: svg(14, "0 0 16 16", <><circle cx="8" cy="8" r="6" {...S} strokeWidth="1.4" /><circle cx="8" cy="8" r="2.5" {...S} strokeWidth="1.4" /></>),
  heart: svg(14, "0 0 16 16", <path d="M8 14S2 10.3 2 6.2A3.2 3.2 0 0 1 8 4.6a3.2 3.2 0 0 1 6 1.6C14 10.3 8 14 8 14z" {...S} strokeWidth="1.4" />),
  lev: svg(14, "0 0 16 16", <path d="M2 13h12M4 13V9M8 13V5M12 13V2" {...S} strokeWidth="1.5" />),
  debt: svg(14, "0 0 16 16", <path d="M2 5h12v8H2zM2 8h12" {...S} strokeWidth="1.4" />),
  spark: svg(14, "0 0 16 16", <path d="M2 11l3.5-3.5 3 2.5L14 4" {...S} strokeWidth="1.5" />),
  gear: svg(14, "0 0 16 16", <><circle cx="8" cy="8" r="2.2" {...S} strokeWidth="1.4" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" {...S} strokeWidth="1.4" /></>),
  spot: svg(16, "0 0 16 16", <path d="M3 10l3-3 3 2 4-5M10 4h3v3" {...S} strokeWidth="1.5" />),
  perp: svg(16, "0 0 16 16", <path d="M5 13V3M5 3L2.5 5.5M5 3l2.5 2.5M11 3v10M11 13l-2.5-2.5M11 13l2.5-2.5" {...S} strokeWidth="1.5" />),
  ext: svg(11, "0 0 12 12", <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" {...S} strokeWidth="1.3" />),
  bolt: svg(14, "0 0 16 16", <path d="M9 1.5L3 9h4.5L7 14.5 13 7H8.5z" {...S} strokeWidth="1.4" />),
  x: svg(14, "0 0 16 16", <path d="M4 4l8 8M12 4l-8 8" {...S} strokeWidth="1.6" />),
  check: svg(14, "0 0 16 16", <path d="M3 8.5l3.2 3L13 4.5" {...S} strokeWidth="1.8" />),
  swap: svg(14, "0 0 16 16", <path d="M4 2.5v11M4 13.5L1.8 11.3M4 13.5l2.2-2.2M12 13.5v-11M12 2.5L9.8 4.7M12 2.5l2.2 2.2" {...S} strokeWidth="1.4" />),
  search: svg(14, "0 0 16 16", <><circle cx="7" cy="7" r="4.8" {...S} strokeWidth="1.4" /><path d="M10.6 10.6L14 14" {...S} strokeWidth="1.4" /></>),
  clock: svg(14, "0 0 16 16", <><circle cx="8" cy="8" r="6" {...S} strokeWidth="1.4" /><path d="M8 4.8V8l2.2 1.6" {...S} strokeWidth="1.4" /></>),
  plus: svg(14, "0 0 16 16", <path d="M8 3v10M3 8h10" {...S} strokeWidth="1.6" />),
  minus: svg(14, "0 0 16 16", <path d="M3 8h10" {...S} strokeWidth="1.6" />),
  warn: svg(14, "0 0 16 16", <><path d="M8 2l6.5 11.5h-13z" {...S} strokeWidth="1.4" /><path d="M8 6.5v3.2M8 11.6v.1" {...S} strokeWidth="1.6" /></>),
  shield: svg(14, "0 0 16 16", <path d="M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z" {...S} strokeWidth="1.4" />),
  farm: svg(16, "0 0 16 16", <path d="M8 14V7M8 7C8 4.5 6 3 3.5 3 3.5 5.5 5.5 7 8 7zM8 9c0-2.5 2-4 4.5-4 0 2.5-2 4-4.5 4z" {...S} strokeWidth="1.4" />),
  down: svg(12, "0 0 12 12", <path d="M6 2v8M2.5 6.5L6 10l3.5-3.5" {...S} strokeWidth="1.5" />),
  up: svg(12, "0 0 12 12", <path d="M6 10V2M2.5 5.5L6 2l3.5 3.5" {...S} strokeWidth="1.5" />),
  chev: svg(10, "0 0 12 12", <path d="M3 4.5l3 3 3-3" {...S} strokeWidth="1.5" />),
  sort: svg(10, "0 0 12 12", <path d="M3.5 2v8M1.5 8l2 2 2-2M8.5 10V2M6.5 4l2-2 2 2" {...S} strokeWidth="1.1" />),
  arrow: (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
      <path d="M1 5h9M7 2l3 3-3 3" {...S} strokeWidth="1.4" />
    </svg>
  ),
  margin: (
    <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
      <path opacity=".3" d="M7.33 4L4 .67.67 4" {...S} strokeWidth="1.33" />
      <path opacity=".6" d="M7.33 8L4 4.67.67 8" {...S} strokeWidth="1.33" />
      <path d="M7.33 12L4 8.67.67 12" {...S} strokeWidth="1.33" />
    </svg>
  ),
};

/** "old → new" pair, as the design's `ba()`. */
export function BeforeAfter({ a, b, za, zb }: { a: ReactNode; b: ReactNode; za?: string; zb?: string }) {
  return (
    <span className="ba">
      <span className={`o ${za ?? ""}`}>{a}</span>
      {IC.arrow}
      <span className={zb ?? ""}>{b}</span>
    </span>
  );
}
