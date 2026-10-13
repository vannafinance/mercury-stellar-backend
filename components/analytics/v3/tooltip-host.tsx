"use client";

/**
 * One floating tooltip for everything marked `data-tip` inside the analytics root (info icons,
 * status badges, chart marks). Shown on pointer hover AND keyboard focus; hidden on blur/leave/Escape.
 * No click-only dialogs for inline definitions.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Tip { title: string | null; text: string; x: number; y: number }

export function TooltipHost({ rootRef }: { rootRef: React.RefObject<HTMLElement | null> }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Prefer above the trigger; if the tooltip would run off the top of the screen, put it below instead.
  useLayoutEffect(() => {
    const el = box.current;
    if (!tip || !el) return;
    if (tip.y - el.offsetHeight - 12 < 8) { el.style.top = `${tip.y + 28}px`; el.style.transform = "translateX(-50%)"; }
  }, [tip]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const show = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) return setTip(null);
      const r = el.getBoundingClientRect();
      setTip({ title: el.getAttribute("data-tip-title"), text, x: r.left + r.width / 2, y: r.top });
    };
    const target = (e: Event) => (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
    const over = (e: Event) => { const el = target(e); if (el) show(el); };
    const out = (e: Event) => { const el = target(e); if (el && !(e instanceof FocusEvent && document.activeElement === el)) setTip(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setTip(null); };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerout", out);
    root.addEventListener("focusin", over);
    root.addEventListener("focusout", () => setTip(null));
    document.addEventListener("keydown", key);
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    return () => {
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerout", out);
      root.removeEventListener("focusin", over);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, { capture: true });
    };
  }, [rootRef]);

  if (!tip || typeof document === "undefined") return null;
  // Positioned with CSS only (no measuring during render): centred on the trigger, kept inside the
  // viewport, flipped below the trigger when there is no room above.
  return createPortal(
    <div className="v3"><div ref={box} key={`${tip.x}-${tip.y}-${tip.text}`} className="an-tip" role="tooltip" style={{ left: `clamp(150px, ${tip.x}px, calc(100vw - 150px))`, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))" }}>
      {tip.title && <strong style={{ display: "block", marginBottom: 3 }}>{tip.title}</strong>}{tip.text}
    </div></div>,
    document.body,
  );
}
