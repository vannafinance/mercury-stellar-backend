"use client";

import { useId } from "react";
import "./vanna-loader.css";

/**
 * Branded loading indicator: the Vanna mark breathing inside a spinning brand-gradient arc.
 *
 * Use it wherever the app is waiting on data (page/panel/table loads), instead of a plain
 * "Loading…" line. Action busy labels on buttons ("Depositing…", "Adding…") stay as text.
 *
 * - `size="page"`: large, centred, tall block for whole-route loads (`app/loading.tsx`, event pages).
 * - `size="block"` (default): medium centred block for panels, empty tables and cards.
 * - `size="inline"`: small mark + caption on one line, for table cells, sub-lines and buttons.
 *
 * Accessible: `role="status"` + `aria-live="polite"`; the caption (or a visually hidden `label`
 * when there is no caption) is what screen readers announce. Animations are disabled under
 * `prefers-reduced-motion: reduce`. Colours are theme-neutral (brand gradient + inherited muted
 * text) so it reads in both light and dark, inside or outside the `.v3` design scope.
 *
 * The root is a `<span>` (styled as a block/inline-flex) so it is valid inside `<p>`, `<td>`,
 * `<h1>` and other phrasing-content parents.
 */
export function VannaLoader({
  size = "block",
  caption,
  label = "Loading",
  className,
}: {
  size?: "page" | "block" | "inline";
  /** Short visible caption under (block/page) or beside (inline) the mark. Only when it adds info. */
  caption?: string;
  /** Screen-reader text when there is no caption. */
  label?: string;
  className?: string;
}) {
  // Per-instance gradient id: a shared id breaks when the first SVG defining it is display:none.
  const gid = `vl-g-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span role="status" aria-live="polite" className={`vl vl-${size}${className ? ` ${className}` : ""}`}>
      <span className="vl-orb" aria-hidden="true">
        <span className="vl-ring" />
        <svg className="vl-mark" viewBox="12 12 104 100" aria-hidden="true">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fc5457" />
              <stop offset="1" stopColor="#703ae6" />
            </linearGradient>
          </defs>
          <path d="M59.9886 16.0614C63.1147 13.6729 67.3757 13.3951 70.7757 15.3581C74.1757 17.3211 76.0413 21.1361 75.4986 25.0161L72.1417 49.0153L72.1454 49.0174L65.6912 95.1595L102.868 66.755L114.107 73.2444L68.4972 108.093C65.3711 110.481 61.11 110.759 57.7101 108.796C54.3101 106.833 52.4445 103.018 52.9872 99.138L56.3441 75.1388L56.3404 75.1367L62.7946 28.9947L25.6183 57.3991L14.3784 50.9098L59.9886 16.0614Z" fill={`url(#${gid})`} />
          <path d="M25.6183 57.3991L36.003 63.3948L33.9183 78.2994L45.9557 69.141L56.3404 75.1367L36.6411 90.1879C33.7348 92.4085 29.7734 92.6668 26.6125 90.8418C23.4545 89.0185 21.7201 85.4763 22.2206 81.872L25.6183 57.3991Z" fill={`url(#${gid})`} />
          <path d="M102.868 66.755L92.4828 60.7594L94.5675 45.8547L82.5301 55.0131L72.1454 49.0174L91.8447 33.9662C94.751 31.7457 98.7124 31.4874 101.873 33.3123C105.031 35.1356 106.766 38.6778 106.265 42.2822L102.868 66.755Z" fill={`url(#${gid})`} />
        </svg>
      </span>
      {caption ? <span className="vl-cap">{caption}</span> : <span className="vl-sr">{label}</span>}
    </span>
  );
}
