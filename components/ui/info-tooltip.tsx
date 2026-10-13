"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/contexts/theme-context";

interface InfoTooltipProps {
  content: ReactNode;
  label: string;
  className?: string;
  triggerClassName?: string;
  placement?: "top" | "bottom" | "right" | "right-end";
  size?: "compact" | "regular";
}

/** Body-level overlay: scroll containers and table nowrap styles must not clip help text. */
export const InfoTooltip = ({
  content, label, className = "", triggerClassName, placement = "top", size = "compact",
}: InfoTooltipProps) => {
  const { isDark } = useTheme();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => { cancelClose(); setOpen(true); };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current) setOpen(false);
    }, 120);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const place = () => {
      const button = trigger.current;
      const bubble = tip.current;
      if (!button || !bubble) return;
      const r = button.getBoundingClientRect();
      const vx = viewport?.offsetLeft ?? 0;
      const vy = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const edge = 8, gap = 8;
      bubble.style.maxWidth = `${Math.max(1, Math.min(size === "regular" ? 320 : 290, width - edge * 2))}px`;
      bubble.style.maxHeight = `${Math.max(1, height - edge * 2)}px`;
      const w = bubble.offsetWidth, h = bubble.offsetHeight;
      let left = r.left + (r.width - w) / 2;
      let top = placement === "bottom" ? r.bottom + gap : r.top - h - gap;
      if (placement === "right" || placement === "right-end") {
        left = r.right + gap;
        top = placement === "right-end" ? r.bottom - h : r.top;
        if (left + w > vx + width - edge) left = r.left - w - gap;
      } else if (placement === "bottom" && top + h > vy + height - edge) {
        top = r.top - h - gap;
      } else if (top < vy + edge) {
        top = r.bottom + gap;
      }
      left = Math.max(vx + edge, Math.min(left, vx + width - w - edge));
      top = Math.max(vy + edge, Math.min(top, vy + height - h - edge));
      setPosition((prev) => prev?.left === left && prev.top === top ? prev : { left, top });
    };
    const close = () => { pinned.current = false; setOpen(false); setPosition(null); };
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !tip.current?.contains(e.target as Node)) close();
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const scroll = (e: Event) => {
      // Let long help text scroll inside the bubble; close on page/container movement.
      if (!tip.current?.contains(e.target as Node)) close();
    };
    place();
    const observer = new ResizeObserver(place);
    if (tip.current) observer.observe(tip.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, placement, size]);

  return (
    <span className={`inline-flex shrink-0 items-center ${className}`}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className={triggerClassName ?? `flex h-[15px] w-[15px] items-center justify-center rounded-full border text-[9px] font-bold leading-none outline-none transition-colors ${isDark
          ? "border-[#555555] text-[#A7A7A7] hover:border-[#8B5CF6] hover:text-white focus-visible:border-[#8B5CF6]"
          : "border-[#B8B8B8] text-[#777777] hover:border-[#703AE6] hover:text-[#703AE6] focus-visible:border-[#703AE6]"}`}
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={() => { pinned.current = false; setOpen(false); }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelClose();
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >i</button>
      {open && createPortal(
        <div
          ref={tip}
          id={id}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={leave}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed", zIndex: 10000,
            left: position?.left ?? 0, top: position?.top ?? 0,
            visibility: position ? "visible" : "hidden",
            width: "max-content", maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(100dvh - 16px)", overflowY: "auto",
            whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "normal",
            textAlign: "left", textTransform: "none", letterSpacing: "normal",
            fontSize: size === "regular" ? 12 : 11, lineHeight: 1.5, fontWeight: 500,
            padding: "8px 11px", borderRadius: 8,
            border: `1px solid ${isDark ? "#454545" : "#d1d5db"}`,
            background: isDark ? "#252525" : "#ffffff",
            color: isDark ? "#f3f4f6" : "#1f2937",
            boxShadow: "0 8px 28px rgba(0,0,0,0.24)",
          }}
        >{content}</div>,
        document.body,
      )}
    </span>
  );
};
