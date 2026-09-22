"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, History, Plus, Trash2, X } from "lucide-react";
import type { ConversationSummary } from "@/lib/copilot/investigation/thread";

export interface ConversationMenuProps {
  items: ConversationSummary[];
  activeId: string | null;
  /** Null when no one is signed in: conversations cannot be kept, and the menu says why. */
  wallet: string | null;
  busy?: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * The wall clock as an external store.
 *
 * Times here are relative ("Today", "14:32"), so they cannot be read during render: the
 * server would print one moment and the browser another, and `Date.now()` in a render body
 * is impure besides. This keeps one cached reading, refreshed each minute while anything is
 * listening, so render only ever reads a stable snapshot — zero until the first subscription,
 * which is what the server sends and what the browser hydrates against.
 */
let clockReading = 0;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribeToClock(onChange: () => void): () => void {
  clockListeners.add(onChange);
  if (clockTimer === null) {
    clockReading = Date.now();
    clockTimer = setInterval(() => {
      clockReading = Date.now();
      for (const listener of clockListeners) listener();
    }, 60_000);
    onChange();
  }
  return () => {
    clockListeners.delete(onChange);
    if (clockListeners.size === 0 && clockTimer !== null) { clearInterval(clockTimer); clockTimer = null; }
  };
}
const readClock = () => clockReading;
const readClockOnServer = () => 0;

/** "Today", "Yesterday", "Earlier" — the only grouping a person scans a chat list by. */
type Bucket = "Today" | "Yesterday" | "Earlier";
const BUCKETS: readonly Bucket[] = ["Today", "Yesterday", "Earlier"];

function bucketOf(updatedAt: number, now: number): Bucket {
  const day = 86_400_000;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (updatedAt >= start.getTime()) return "Today";
  if (updatedAt >= start.getTime() - day) return "Yesterday";
  return "Earlier";
}

function timeOf(updatedAt: number, bucket: Bucket): string {
  const date = new Date(updatedAt);
  return bucket === "Earlier"
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Shared by New chat, History, and Auto-approve so the header reads as one row of controls. */
export const HEADER_CONTROL =
  "flex cursor-pointer items-center gap-1.5 rounded-full border border-vgray-100 px-3.5 py-[7px] text-[12.5px] font-semibold text-vgray-800 transition-colors hover:border-violet-400 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:text-vgray-300";

/**
 * New chat, and every earlier conversation behind one control.
 *
 * A side rail was the obvious shape and the wrong one: the work surface on this page is
 * full width on purpose, and a column of two chat titles beside it left a tall empty
 * gutter. History is something you reach for occasionally, so it belongs in the header as
 * a menu — near the title, out of the way of the thread.
 */
export function ConversationMenu({ items, activeId, wallet, busy, onNew, onOpen, onDelete }: ConversationMenuProps) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // A conversation deleted elsewhere takes its own confirmation with it: derived, not synced.
  const confirming = asked && items.some((item) => item.id === asked) ? asked : null;
  const reading = useSyncExternalStore(subscribeToClock, readClock, readClockOnServer);
  const now = reading === 0 ? null : reading;
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  // A menu closes on Escape and on a click outside it; both return focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setAsked(null); };
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

  const groups = new Map<Bucket, ConversationSummary[]>();
  for (const item of items) {
    const bucket = bucketOf(item.updatedAt, now ?? item.updatedAt);
    groups.set(bucket, [...(groups.get(bucket) ?? []), item]);
  }

  return (
    <>
      <button type="button" onClick={onNew} disabled={busy} className={HEADER_CONTROL}>
        <Plus size={14} aria-hidden="true" /> New chat
      </button>

      <div ref={container} className="relative">
        <button
          ref={trigger}
          type="button"
          onClick={() => { setOpen((wasOpen) => !wasOpen); setAsked(null); }}
          aria-expanded={open}
          aria-haspopup="menu"
          className={HEADER_CONTROL}
        >
          <History size={14} aria-hidden="true" /> History
          {items.length > 0 && <span className="tabular-nums text-vgray-400">{items.length}</span>}
        </button>

        {open && (
          <div
            role="menu"
            aria-label="Conversations"
            className="absolute right-0 z-30 mt-2 max-h-[60vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-r2 border border-vgray-100 bg-surface p-2 shadow-lg"
          >
            {!wallet ? (
              <p className="px-2 py-3 text-[13px] leading-5 text-vgray-500">
                Sign in to keep your conversations. Without a wallet, this chat lasts as long as the tab.
              </p>
            ) : items.length === 0 ? (
              <p className="px-2 py-3 text-[13px] leading-5 text-vgray-500">Your conversations will appear here.</p>
            ) : (
              BUCKETS.map((bucket) => {
                const group = groups.get(bucket);
                if (!group?.length) return null;
                return (
                  <section key={bucket} className="mb-2 last:mb-0">
                    <h3 className="px-2 pb-1 pt-1.5 text-[12px] font-semibold text-vgray-500">{bucket}</h3>
                    <ul className="space-y-0.5">
                      {group.map((item) => {
                        const active = item.id === activeId;
                        return (
                          <li key={item.id} className="group relative">
                            {confirming === item.id ? (
                              <div className="flex items-center justify-between gap-2 rounded-r2 bg-violet-50 px-2.5 py-2 text-[13px]">
                                <span className="min-w-0 truncate text-vgray-900">Delete this chat?</span>
                                <span className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => { setAsked(null); onDelete(item.id); }}
                                    aria-label={`Delete "${item.title}"`}
                                    className="flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-semibold text-imperial-500 hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
                                  >
                                    <Check size={13} aria-hidden="true" /> Delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setAsked(null)}
                                    aria-label="Keep this chat"
                                    className="flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-vgray-700 hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
                                  >
                                    <X size={13} aria-hidden="true" /> Keep
                                  </button>
                                </span>
                              </div>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpen(false); onOpen(item.id); }}
                                  aria-current={active ? "true" : undefined}
                                  title={item.title}
                                  className={`flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-r2 px-2.5 py-2 pr-8 text-left text-[13px] leading-5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 ${
                                    active ? "bg-violet-50 text-violet-500" : "text-vgray-800 hover:bg-violet-50/60"
                                  }`}
                                >
                                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                  <span className="shrink-0 text-[11px] tabular-nums text-vgray-400 group-hover:invisible group-focus-within:invisible">
                                    {now === null ? "" : timeOf(item.updatedAt, bucket)}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAsked(item.id)}
                                  aria-label={`Delete "${item.title}"`}
                                  className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 cursor-pointer rounded p-1 text-vgray-400 hover:text-imperial-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 group-hover:block group-focus-within:block"
                                >
                                  <Trash2 size={14} aria-hidden="true" />
                                </button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })
            )}
          </div>
        )}
      </div>
    </>
  );
}
