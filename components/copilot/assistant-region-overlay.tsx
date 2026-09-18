"use client";

/**
 * Select-from-screen: draw a box on the page; return viewport rect.
 * After the box is drawn, Confirm/Cancel appear. Esc still cancels.
 */

import { useCallback, useEffect, useState } from "react";
import type { CaptureRect } from "@/lib/assistant/capture-page";

type Point = { x: number; y: number };

function toRect(a: Point, b: Point): CaptureRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

export function AssistantRegionOverlay({
  active,
  onComplete,
  onCancel,
}: {
  active: boolean;
  onComplete: (rect: CaptureRect) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const [pending, setPending] = useState<CaptureRect | null>(null);

  useEffect(() => {
    if (!active) {
      setStart(null);
      setCurrent(null);
      setPending(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onCancel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (pending) return;
      e.preventDefault();
      setStart({ x: e.clientX, y: e.clientY });
      setCurrent({ x: e.clientX, y: e.clientY });
    },
    [pending],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start || pending) return;
      setCurrent({ x: e.clientX, y: e.clientY });
    },
    [start, pending],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!start || pending) return;
      const rect = toRect(start, { x: e.clientX, y: e.clientY });
      setStart(null);
      setCurrent(null);
      if (rect.right - rect.left < 8 || rect.bottom - rect.top < 8) {
        onCancel();
        return;
      }
      setPending(rect);
    },
    [start, pending, onCancel],
  );

  if (!active) return null;

  const live =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : pending
        ? {
            left: pending.left,
            top: pending.top,
            width: pending.right - pending.left,
            height: pending.bottom - pending.top,
          }
        : null;

  const buttonsTop =
    pending && window.innerHeight - pending.bottom > 52
      ? pending.bottom + 8
      : pending
        ? Math.max(8, pending.top - 44)
        : 0;

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
        {pending ? "Confirm this region · Esc to cancel" : "Drag to select a region · Esc to cancel"}
      </div>
      {live && (
        <div
          className="pointer-events-none absolute border-2 border-[#703AE6] bg-[#703AE6]/15"
          style={{
            left: live.left,
            top: live.top,
            width: live.width,
            height: live.height,
          }}
        />
      )}
      {pending && (
        <div
          className="absolute z-10 flex items-center gap-1.5"
          style={{ left: pending.left, top: buttonsTop }}
        >
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="cursor-pointer rounded-r2 border border-vgray-100 bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-vgray-800 shadow-md transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onComplete(pending);
            }}
            className="cursor-pointer rounded-r2 bg-gradient px-2.5 py-1.5 text-[12px] font-semibold text-white shadow-md transition-opacity hover:opacity-90"
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}
