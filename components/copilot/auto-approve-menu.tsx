"use client";

import { useEffect, useRef, useState } from "react";
import { HEADER_CONTROL } from "./conversation-menu";

export interface AutoApproveMenuProps {
  on: boolean;
  busy?: boolean;
  capsMode: "defaults" | "custom";
  customTx: string;
  customDay: string;
  defaultTx: number;
  defaultDay: number;
  onToggle: () => void;
  onCapsMode: (mode: "defaults" | "custom") => void;
  onCustomTx: (value: string) => void;
  onCustomDay: (value: string) => void;
}

const PILL =
  "cursor-pointer rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500";

function CapField({
  label,
  aria,
  value,
  onChange,
}: {
  label: string;
  aria: string;
  value: string;
  onChange?: (value: string) => void;
}) {
  const locked = onChange == null;
  return (
    <label className={`block min-w-0 ${locked ? "cursor-not-allowed" : ""}`}>
      <span className="text-[11px] font-semibold text-vgray-500">{label}</span>
      <span
        className={`mt-1 flex items-center gap-1 rounded-full border px-2.5 ${
          locked
            ? "cursor-not-allowed border-vgray-100 bg-vgray-50 text-vgray-400"
            : "border-vgray-100 focus-within:border-violet-400"
        }`}
      >
        <span className="text-[12.5px] text-vgray-400">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          value={value}
          readOnly={locked}
          tabIndex={locked ? -1 : undefined}
          onChange={locked ? undefined : (e) => onChange(e.target.value)}
          onMouseDown={locked ? (e) => e.preventDefault() : undefined}
          placeholder={label === "per tx" ? "500" : "2000"}
          aria-label={aria}
          aria-readonly={locked || undefined}
          className={`w-full min-w-0 border-0 bg-transparent py-1.5 text-[13px] tabular-nums outline-none ${
            locked ? "pointer-events-none cursor-not-allowed text-vgray-400" : "text-vgray-900"
          }`}
        />
      </span>
    </label>
  );
}

/**
 * Auto-approve as a header control, same shape as New chat / History.
 *
 * The spend limit lives in this menu so the page does not need a second card for a
 * setting the user flips once.
 */
export function AutoApproveMenu({
  on,
  busy,
  capsMode,
  customTx,
  customDay,
  defaultTx,
  defaultDay,
  onToggle,
  onCapsMode,
  onCustomTx,
  onCustomDay,
}: AutoApproveMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={HEADER_CONTROL}
      >
        Auto-approve
        <span className="tabular-nums text-vgray-400">{on ? "on" : "off"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Auto-approve"
          className="absolute right-0 z-30 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-r2 border border-vgray-100 bg-surface p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-3 px-1 py-1">
            <span className="text-[13px] font-semibold text-vgray-900">Auto-approve</span>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              disabled={busy}
              onClick={() => {
                onToggle();
                setOpen(false);
              }}
              className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed ${
                on ? "bg-violet-500" : "bg-vgray-100"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
                  on ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <div className="mt-3 flex gap-1.5">
            <button
              type="button"
              aria-pressed={capsMode === "defaults"}
              onClick={() => onCapsMode("defaults")}
              className={`${PILL} flex-1 ${
                capsMode === "defaults"
                  ? "border-violet-500 bg-violet-50 text-violet-500"
                  : "border-vgray-100 text-vgray-800 hover:border-violet-400 hover:text-violet-500"
              }`}
            >
              Default
            </button>
            <button
              type="button"
              aria-pressed={capsMode === "custom"}
              onClick={() => onCapsMode("custom")}
              className={`${PILL} flex-1 ${
                capsMode === "custom"
                  ? "border-violet-500 bg-violet-50 text-violet-500"
                  : "border-vgray-100 text-vgray-800 hover:border-violet-400 hover:text-violet-500"
              }`}
            >
              Custom
            </button>
          </div>

          {capsMode === "defaults" && (
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <CapField label="per tx" aria="Default per transaction cap in USD" value={String(defaultTx)} />
              <CapField label="per day" aria="Default per day cap in USD" value={String(defaultDay)} />
            </div>
          )}

          {capsMode === "custom" && (
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <CapField
                label="per tx"
                aria="Per transaction cap in USD"
                value={customTx}
                onChange={onCustomTx}
              />
              <CapField
                label="per day"
                aria="Per day cap in USD"
                value={customDay}
                onChange={onCustomDay}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
