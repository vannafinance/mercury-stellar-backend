"use client";

import { useEffect, useRef, useState } from "react";
import { MoreVertical, AlignLeft } from "lucide-react";
import {
  assistantChatTitle,
  openAssistantChat,
  useAssistantSessionStore,
} from "@/store/assistant-session";

/**
 * The three-dots control in the Assist header: the current chat and every earlier one, newest first.
 * Choosing one swaps it in; the chat that was on screen moves into this list, so nothing is lost.
 */
export function AssistantHistoryMenu({ onOpened }: { onOpened?: () => void }) {
  const turns = useAssistantSessionStore((s) => s.turns);
  const history = useAssistantSessionStore((s) => s.history ?? []);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: PointerEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = turns.length ? { id: "current", title: assistantChatTitle(turns) } : null;
  const earlier = [...history].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div ref={wrapRef} className="relative" data-no-drag>
      <button
        type="button"
        aria-label="Chat history"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chat history"
        onClick={() => setOpen((v) => !v)}
        className={`flex cursor-pointer items-center justify-center rounded-r2 p-[7px] text-vgray-600 transition-colors hover:bg-violet-50 hover:text-violet-500 ${
          open ? "bg-violet-50 text-violet-500" : ""
        }`}
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Chat history"
          className="absolute right-0 top-[calc(100%+6px)] z-10 flex max-h-[60vh] w-[300px] max-w-[calc(100vw-24px)] flex-col gap-0.5 overflow-y-auto rounded-r3 border border-vgray-100 bg-surface p-1.5 shadow-2xl"
        >
          {!current && earlier.length === 0 ? (
            <p className="px-3 py-2.5 text-[13px] text-vgray-500">No earlier chats yet.</p>
          ) : null}
          {current ? (
            <div
              role="menuitem"
              aria-current="true"
              className="flex items-center gap-2.5 rounded-r2 bg-violet-50 px-3 py-2 text-[13.5px] font-medium text-violet-500"
            >
              <AlignLeft size={15} className="shrink-0" aria-hidden />
              <span className="truncate">{current.title}</span>
            </div>
          ) : null}
          {earlier.map((chat) => (
            <button
              key={chat.id}
              type="button"
              role="menuitem"
              onClick={() => {
                openAssistantChat(chat.id);
                setOpen(false);
                onOpened?.();
              }}
              className="flex cursor-pointer items-center gap-2.5 rounded-r2 px-3 py-2 text-left text-[13.5px] text-vgray-800 transition-colors hover:bg-vgray-50"
            >
              <AlignLeft size={15} className="shrink-0 text-vgray-400" aria-hidden />
              <span className="truncate">{chat.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
