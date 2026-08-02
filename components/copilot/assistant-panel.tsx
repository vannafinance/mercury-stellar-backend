"use client";

/**
 * Side-panel body — conversation only (no page-context strip / template chips).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import type { AssistantTurn } from "@/store/assistant-session";
import { AssistantProse, sanitizeAssistantText } from "./assistant-prose";

export type AssistantSend = (message: string) => Promise<{
  kind: string;
  message: string;
  client_tools?: Array<{ name: string; args: Record<string, unknown> }> | null;
  data?: Record<string, unknown> | null;
}>;

export function AssistantPanel({
  send,
  prefill,
  onConsumedPrefill,
  turns,
}: {
  send: AssistantSend;
  prefill?: string | null;
  onConsumedPrefill?: () => void;
  pageLabel?: string;
  turns: AssistantTurn[];
}) {
  const { isDark } = useTheme();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      onConsumedPrefill?.();
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [prefill, onConsumedPrefill]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const run = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;
      setBusy(true);
      setInput("");
      try {
        await send(text);
      } catch (e) {
        console.error("[assistant]", e);
      } finally {
        setBusy(false);
      }
    },
    [busy, send],
  );

  const ink = isDark ? "text-white" : "text-[#111]";
  const muted = isDark ? "text-[#8a8a8a]" : "text-[#6b6b6b]";
  const line = isDark ? "border-[#2a2a2a]" : "border-[#ececec]";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-assistant-panel
      style={{ fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif" }}
    >
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-6">
        {turns.length === 0 && !busy && (
          <div className="space-y-2 pt-2">
            <p className={`text-[15px] font-semibold tracking-tight ${ink}`}>Ask anything</p>
            <p className={`text-[13px] leading-relaxed ${muted}`}>
              About this page, Vanna products, or multi-step strategies (park then farm, swap then
              leverage). Use the refresh icon for a new chat — history is cleared completely.
            </p>
          </div>
        )}

        {turns.map((e, i) =>
          e.role === "user" ? (
            <div key={i} className="space-y-1">
              <p className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${muted}`}>
                You
              </p>
              <p className={`text-[13.5px] font-medium leading-relaxed ${ink}`}>{e.text}</p>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#703AE6]">
                Assistant
              </p>
              <AssistantProse text={sanitizeAssistantText(e.text)} />
            </div>
          ),
        )}

        {busy && (
          <div className={`flex items-center gap-2 text-[12px] ${muted}`}>
            <Loader2 size={14} className="animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      <form
        className={`shrink-0 border-t p-3 flex gap-2 ${line}`}
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything…"
          disabled={busy}
          className={`min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-[13px] outline-none focus:border-[#703AE6] ${
            isDark
              ? "border-[#2a2a2a] bg-[#111] text-white placeholder:text-[#555]"
              : "border-[#e5e5e5] bg-[#fafafa] text-[#111] placeholder:text-[#aaa]"
          }`}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Ask"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#703AE6] text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>
    </div>
  );
}
