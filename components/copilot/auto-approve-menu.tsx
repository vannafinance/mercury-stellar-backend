"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  /**
   * Where this control is mounted, which is the only thing that differs between the two
   * call sites: `pill` is the header chip, `rail` is a full-width row in the left panel
   * whose panel flies out to the right instead of dropping down. The toggle, the caps
   * mode and the two limit fields are the same control in both — duplicating this
   * component to move it would have duplicated all of that with it.
   */
  variant?: "pill" | "rail" | "mini";
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
  variant = "pill",
}: AutoApproveMenuProps) {
  const [open, setOpen] = useState(false);
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0 });
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (container.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
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

  const rail = variant === "rail";
  const mini = variant === "mini";

  const toggle = () => {
    if (!open) {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) {
        const width = 248;
        setFlyoutPos({
          top: Math.max(8, Math.min(rect.top, window.innerHeight - 220)),
          left: Math.min(rect.right + 10, window.innerWidth - width - 8),
        });
      }
    }
    setOpen((wasOpen) => !wasOpen);
  };

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Auto-approve"
      className={
        rail || mini
          ? "cp-root fixed z-[100] w-[248px] rounded-r2 border border-vgray-100 bg-surface p-3 shadow-lg"
          : "absolute right-0 z-30 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-r2 border border-vgray-100 bg-surface p-3 shadow-lg"
      }
      style={rail || mini ? flyoutPos : undefined}
    >
          <div className="flex items-center justify-between gap-3 px-1 py-1">
            <span className="text-[13px] font-semibold text-vgray-900">Auto-approve</span>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              disabled={busy}
              onClick={() => onToggle()}

              className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:opacity-75 ${
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
  );

  return (
    <div ref={container} className="relative">
      {rail ? (
        <button
          ref={trigger}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="flex w-full cursor-pointer items-center justify-between gap-2 py-1.5"
        >
          <span className="text-[14px] leading-[21px] font-semibold text-vgray-900">Auto-approve</span>
          <span className="flex items-center gap-1.5 text-[12px] leading-[18px] text-vgray-400">
            {on ? "On" : "Off"}
            <span aria-hidden className="inline-flex flex-none">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg>
            </span>
          </span>
        </button>
      ) : mini ? (
        <button
          ref={trigger}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Auto-approve ${on ? "on" : "off"}`}
          title={`Auto-approve ${on ? "on" : "off"}`}
          className="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-r2 text-[12px] leading-[18px] text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500"
        >
          {on ? "On" : "Off"}
        </button>
      ) : (
        <button
          ref={trigger}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={HEADER_CONTROL}
        >
          Auto-approve
          <span className="tabular-nums text-vgray-400">{on ? "on" : "off"}</span>
        </button>
      )}
      {open && (rail || mini) && typeof document !== "undefined" ? createPortal(panel, document.body) : open ? panel : null}
    </div>
  );
}
