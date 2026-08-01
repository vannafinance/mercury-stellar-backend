"use client";

/**
 * Select-from-screen: draw a box on the page; return viewport rect.
 */

import { useCallback, useEffect, useState } from "react";
import type { CaptureRect } from "@/lib/assistant/capture-page";

export function AssistantRegionOverlay({
  active,
  onComplete,
  onCancel,
}: {
  active: boolean;
  onComplete: (rect: CaptureRect) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!active) {
      setStart(null);
      setCurrent(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onCancel]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setStart({ x: e.clientX, y: e.clientY });
    setCurrent({ x: e.clientX, y: e.clientY });
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start) return;
      setCurrent({ x: e.clientX, y: e.clientY });
    },
    [start],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!start) return;
      const end = { x: e.clientX, y: e.clientY };
      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const right = Math.max(start.x, end.x);
      const bottom = Math.max(start.y, end.y);
      setStart(null);
      setCurrent(null);
      if (right - left < 8 || bottom - top < 8) {
        onCancel();
        return;
      }
      onComplete({ left, top, right, bottom });
    },
    [start, onComplete, onCancel],
  );

  if (!active) return null;

  const box =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      data-assistant-overlay
      className="fixed inset-0 z-[10050] cursor-crosshair"
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="absolute inset-0 bg-black/35" />
      <div className="pointer-events-none absolute left-1/2 top-6 z-10 -translate-x-1/2 rounded-full bg-[#111] px-4 py-2 text-[12px] font-medium text-white shadow-lg">
        Drag to select a region · Esc to cancel
      </div>
      {box && (
        <div
          className="pointer-events-none absolute border-2 border-[#703AE6] bg-[#703AE6]/15"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          }}
        />
      )}
    </div>
  );
}
