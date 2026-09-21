"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useViewportScale } from "@/lib/hooks/useViewportScale";

/**
 * The chat shell for /copilot: a fixed left rail and a stage that scrolls inside itself.
 *
 * Structure only. It owns the two column widths, the rail's single scroll region (the
 * whole panel, not Recents alone) and the grid that centres the composer on an empty
 * page and docks it to the bottom once a thread exists. It owns none of the content —
 * the rail's controls, the thread's cards and the composer are passed in, so this file
 * can never change an answer's wording or a card's styling.
 *
 * ## Two things that broke a previous attempt, handled here
 *
 * **Tailwind v4 drops custom classes containing `--`.** An earlier pass declared
 * `.cp-rail--full` in `globals.css`; LightningCSS removed it, the shell computed as
 * `display: block`, and the rail stretched to 1433px. Every structural property here is
 * therefore inline on the element, not in a stylesheet.
 *
 * **`ScaleWrapper` applies CSS `zoom` above 1440px.** Inside a zoomed subtree `100dvh`
 * still measures the real viewport, so a `100dvh` shell renders taller than the window
 * and the composer falls below the fold. The height is measured instead: the distance
 * from the shell's top to the bottom of the window, converted back into layout pixels by
 * dividing by the same zoom factor the wrapper used. Self-correcting on resize, with no
 * navbar constant to keep in step.
 */

/** Rail widths, from the deployed mock. */
const RAIL_FULL = 292;
const RAIL_MINI = 60;

export interface CopilotShellProps {
  collapsed: boolean;
  /** New chat and Auto-approve. Scrolls with the rest of the rail, not as a sticky header. */
  railTop: React.ReactNode;
  /** Health factor, positions, recents. Same scroll as New chat / Auto-approve. */
  railBody: React.ReactNode;
  /** The icon column shown when the rail is collapsed. */
  railMini: React.ReactNode;
  onToggleCollapsed: () => void;
  /** The conversation. Whatever cards the workspace already renders, unchanged. */
  thread: React.ReactNode;
  /** Hero copy, the composer pill and the starter chips. */
  composer: React.ReactNode;
  /**
   * No turn on screen yet. Drives the grid: an empty stage centres the composer between
   * two equal spacers; a threaded one collapses the lower spacer so it docks to the
   * bottom and the thread takes the remaining height.
   */
  empty: boolean;
}

export function CopilotShell({
  collapsed,
  railTop,
  railBody,
  railMini,
  onToggleCollapsed,
  thread,
  composer,
  empty,
}: CopilotShellProps) {
  const shell = useRef<HTMLDivElement | null>(null);
  const zoom = useViewportScale(1440);
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const node = shell.current;
    if (!node) return;
    // `getBoundingClientRect` reports visual pixels — already multiplied by the wrapper's
    // zoom — while the style we set is interpreted in layout pixels. Divide to convert.
    const top = node.getBoundingClientRect().top;
    const visible = window.innerHeight - top;
    const layout = visible / (zoom || 1);
    setHeight(layout > 320 ? layout : 320);
  }, [zoom]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <div
      ref={shell}
      style={{
        display: "flex",
        alignItems: "stretch",
        // Until the first measurement lands, fall back to a viewport height: at zoom 1
        // that is already correct, and above 1440px it is corrected on the same frame.
        height: height ? `${height}px` : "calc(100dvh - 96px)",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <aside
        style={{
          position: "relative",
          flex: "none",
          width: collapsed ? RAIL_MINI : RAIL_FULL,
          minWidth: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--g100)",
          transition: "width .22s cubic-bezier(.22,1,.36,1)",
          overflow: "visible",
        }}
      >
        {collapsed ? (
          <div
            style={{
              position: "absolute",
              inset: "0 auto 0 0",
              width: RAIL_MINI,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: "14px 0",
            }}
          >
            {railMini}
          </div>
        ) : (
          <div
            className="cp-rail-scroll"
            style={{
              position: "absolute",
              inset: 0,
              width: RAIL_FULL,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              overflowX: "hidden",
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "14px 16px 10px",
                flex: "none",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
                  fontSize: 12,
                  lineHeight: "18px",
                  fontWeight: 600,
                  color: "var(--g900)",
                }}
              >
                Copilot
              </span>
              <button
                type="button"
                onClick={onToggleCollapsed}
                title="Collapse"
                aria-label="Collapse the panel"
                className="cp-rail-icon"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--g500)",
                  cursor: "pointer",
                }}
              >
                <PanelIcon />
              </button>
            </div>
            <div style={{ flex: "none" }}>{railTop}</div>
            <div style={{ flex: "none", minWidth: 0 }}>{railBody}</div>
          </div>
        )}
      </aside>

      <main
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "grid",
          // Empty: equal spacers above and below, so the composer sits in the middle.
          // Threaded: the lower spacer collapses and the thread takes the space, which
          // docks the composer to the bottom without it ever being position: fixed.
          gridTemplateRows: empty ? "minmax(0,1fr) auto minmax(0,1fr)" : "minmax(0,1fr) auto 0fr",
          transition: "grid-template-rows .48s cubic-bezier(.22,1,.36,1)",
        }}
      >
        <div className="cp-stage-scroll" style={{ minWidth: 0, minHeight: 0, overflowY: "auto", padding: "0 20px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>{thread}</div>
        </div>
        <div style={{ minWidth: 0, padding: "8px 20px 14px" }}>
          <div style={{ maxWidth: 680, margin: "0 auto" }}>{composer}</div>
        </div>
        <div />
      </main>
    </div>
  );
}

/** The collapse chevron-into-panel glyph the mock uses. */
function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}
