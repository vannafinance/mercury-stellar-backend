"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useViewportScale } from "@/lib/hooks/useViewportScale";

/**
 * The chat shell for /copilot: a sticky left rail, and a thread that scrolls with the page.
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
/** Breathing room above a pinned message, in px. */
const PIN_GAP = 12;

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
  /** When a send or reply landing changes the thread content, triggers the bottom-scroll check. */
  scrollKey?: unknown;
  /** Identifies the conversation so pin state cannot leak across equal-sized threads. */
  conversationId?: string | null;
  /** When the user has just submitted a prompt, forces scrolling to bottom unconditionally. */
  justSubmitted?: boolean;
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
  scrollKey,
  conversationId,
  justSubmitted,
}: CopilotShellProps) {
  const shell = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);
  /** Where the copilot area starts on screen (the navbar's bottom edge), in visual px. */
  const topEdgeRef = useRef(0);
  const zoomRef = useRef(1);

  /**
   * The chat scrolls with the PAGE, not inside a box of its own. 23 Sep, owner: a second
   * scrollbar for the chat was not wanted; the page scrollbar and the mouse wheel anywhere
   * over the chat should move it. The navbar and the rail are sticky, the composer is stuck
   * to the bottom of the window, and everything else is ordinary document flow.
   */
  const handleScroll = useCallback(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    wasNearBottomRef.current = doc.scrollHeight - window.scrollY - window.innerHeight <= 120;
  }, []);
  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const doc = document.scrollingElement ?? document.documentElement;
        window.scrollTo({ top: doc.scrollHeight });
        wasNearBottomRef.current = true;
      });
    });
  }, []);

  /**
   * On send, the new message is pinned to the top of the chat area and the reply grows
   * beneath it, the pattern ChatGPT, Claude and Gemini use. Jumping to the bottom (as before)
   * scrolled the user's own message out of sight while a long plan rendered, 23 Sep.
   *
   * A spacer under the thread gives the page room to put the message at the top even while
   * the reply is short. As the reply grows the spacer only shrinks, so the scroll position
   * never moves and the message stays put. It is recomputed on resize rather than per token,
   * which keeps it from jittering. Pinned until the next send; a restored conversation with
   * no send still opens at the bottom.
   */
  const pinnedRef = useRef<HTMLElement | null>(null);
  const pinnedConversationRef = useRef<string | null | undefined>(conversationId);
  const wasSubmittedRef = useRef(false);
  const [spacer, setSpacer] = useState(0);

  /** Visual px between the top of the chat area and the top of the composer. */
  const room = useCallback(() => {
    const composerHeight = composerRef.current?.getBoundingClientRect().height ?? 0;
    return window.innerHeight - topEdgeRef.current - composerHeight - PIN_GAP;
  }, []);

  const fitSpacer = useCallback(() => {
    const thread = threadRef.current;
    const bubble = pinnedRef.current;
    if (!thread || !bubble || !bubble.isConnected) {
      setSpacer(0);
      return;
    }
    const below = thread.getBoundingClientRect().bottom - bubble.getBoundingClientRect().top;
    // Visual px back into layout px, for a style inside the zoomed wrapper.
    setSpacer(Math.max(0, room() - below) / (zoomRef.current || 1));
  }, [room]);

  const latestBubble = () => {
    const bubbles = threadRef.current?.querySelectorAll<HTMLElement>("[data-cp-user-bubble]");
    return bubbles?.length ? bubbles[bubbles.length - 1] : null;
  };

  const pinLatest = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const bubble = latestBubble();
        // Nothing to pin (no bubble rendered): keep the previous behaviour and show the end.
        if (!bubble) { scrollToBottom(); return; }
        pinnedRef.current = bubble;
        fitSpacer();
        // Scroll after the spacer lands, or the browser clamps it to the old page height.
        requestAnimationFrame(() => {
          window.scrollBy({ top: bubble.getBoundingClientRect().top - topEdgeRef.current - PIN_GAP });
          wasNearBottomRef.current = false;
        });
      });
    });
  }, [fitSpacer, scrollToBottom]);

  useEffect(() => {
    const previous = pinnedConversationRef.current;
    /**
     * A new chat has no id until the server records its first turn, so "no id -> an id" is the
     * SAME conversation landing its first reply: the pin must survive it, or the message the
     * user just sent is unpinned the moment its answer arrives. Only a switch between two
     * different conversations, or an emptied thread, clears the pin.
     */
    if (!previous && conversationId && !empty) {
      pinnedConversationRef.current = conversationId;
      return undefined;
    }
    if (previous !== conversationId || empty) {
      pinnedConversationRef.current = conversationId;
      pinnedRef.current = null;
      const frame = requestAnimationFrame(() => setSpacer(0));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [conversationId, empty]);

  useEffect(() => {
    const rising = Boolean(justSubmitted) && !wasSubmittedRef.current;
    wasSubmittedRef.current = Boolean(justSubmitted);
    if (rising) { pinLatest(); return; }
    if (pinnedRef.current) return;
    if (wasNearBottomRef.current) scrollToBottom();
  }, [scrollKey, justSubmitted, scrollToBottom, pinLatest]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // The pending bubble is replaced by the recorded one when the turn lands; follow it.
      if (pinnedConversationRef.current === conversationId && pinnedRef.current && !pinnedRef.current.isConnected) {
        const bubble = latestBubble();
        if (bubble) pinnedRef.current = bubble;
        else {
          pinnedRef.current = null;
          setSpacer(0);
        }
      }
      fitSpacer();
    });
    observer.observe(thread);
    return () => observer.disconnect();
  }, [conversationId, fitSpacer]);

  /**
   * A send is detected from the thread itself: exactly one new message bubble appeared.
   * `justSubmitted` alone missed almost every send, because the workspace records the turn at
   * once and its `pendingUser` is null by the next render (23 Sep, the "aquarius lp" reply
   * never pinned). The recorded bubble replacing the pending one keeps the count, so a send
   * pins once; a restored chat that loads many turns at once still opens at the end.
   */
  const bubbleCountRef = useRef<number | null>(null);
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || typeof MutationObserver === "undefined") return;
    const count = () => thread.querySelectorAll("[data-cp-user-bubble]").length;
    bubbleCountRef.current = count();
    const observer = new MutationObserver(() => {
      const now = count();
      const before = bubbleCountRef.current ?? now;
      bubbleCountRef.current = now;
      if (now === before + 1) pinLatest();
    });
    observer.observe(thread, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pinLatest]);
  const zoom = useViewportScale(1440);
  const [height, setHeight] = useState<number | null>(null);
  /** The navbar's bottom edge in layout px: where the sticky rail sits once the page scrolls. */
  const [stickyTop, setStickyTop] = useState(0);

  const measure = useCallback(() => {
    const node = shell.current;
    if (!node) return;
    // `getBoundingClientRect` reports visual pixels — already multiplied by the wrapper's
    // zoom — while the style we set is interpreted in layout pixels. Divide to convert.
    // The page scrolls now, so the shell's top is taken at scroll 0 (its document offset);
    // the sticky navbar ends exactly there.
    const top = node.getBoundingClientRect().top + window.scrollY;
    zoomRef.current = zoom || 1;
    topEdgeRef.current = top;
    const visible = window.innerHeight - top;
    const layout = visible / (zoom || 1);
    setHeight(layout > 320 ? layout : 320);
    setStickyTop(top / (zoom || 1));
  }, [zoom]);

  /**
   * Measure before paint, then keep measuring whatever can move the shell's top edge.
   *
   * A single `requestAnimationFrame` was not enough: it fired before the navbar above had
   * settled, the height state was never set, and the shell silently kept its fallback
   * `calc(100dvh - 96px)` — 23px short of the viewport at 1440x900, which shows as a dead
   * strip under the rail. The navbar's height is not a constant this file may assume, so
   * the only reliable answer is to observe it: `useLayoutEffect` catches the first
   * correct layout, and a ResizeObserver on the document element and on the shell's own
   * parent catches every later reflow (font swap, banner, wallet row wrapping).
   */
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    const parent = shell.current?.parentElement;
    if (parent) observer.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <div
      ref={shell}
      style={{
        display: "flex",
        alignItems: "flex-start",
        // At least one window tall; taller as the thread grows, since the PAGE scrolls.
        // Until the first measurement lands, fall back to a viewport height: at zoom 1
        // that is already correct, and above 1440px it is corrected on the same frame.
        minHeight: height ? `${height}px` : "calc(100dvh - 96px)",
      }}
    >
      <aside
        style={{
          // Stays in view while the page scrolls, and keeps its own scroll for the rail.
          position: "sticky",
          top: stickyTop,
          height: height ? `${height}px` : "calc(100dvh - 96px)",
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
          alignSelf: "stretch",
          display: "grid",
          // At least one window tall, so a short thread still docks the composer at the bottom.
          minHeight: height ? `${height}px` : "calc(100dvh - 96px)",
          // Empty: equal spacers above and below, so the composer sits in the middle.
          // Threaded: the lower spacer collapses and the thread takes the space above the
          // composer, which then sticks to the bottom of the window as the page scrolls.
          gridTemplateRows: empty ? "minmax(0,1fr) auto minmax(0,1fr)" : "1fr auto 0fr",
          transition: "grid-template-rows .48s cubic-bezier(.22,1,.36,1)",
        }}
      >
        <div className="cp-stage" style={{ minWidth: 0, padding: "0 20px" }}>
          <div ref={threadRef} style={{ maxWidth: 760, margin: "0 auto" }}>{thread}</div>
          <div aria-hidden style={{ height: spacer }} />
        </div>
        <div
          ref={composerRef}
          style={{
            minWidth: 0, padding: "8px 20px 14px",
            // Over the thread as it scrolls beneath; the page colour so nothing shows through.
            ...(empty ? {} : { position: "sticky", bottom: 0, background: "var(--page)", zIndex: 5 }),
          }}
        >
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
