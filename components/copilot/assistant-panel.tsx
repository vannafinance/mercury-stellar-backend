"use client";

/**
 * Side-panel body for the page-aware agent.
 * History comes from session store (survives route changes).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import { captureSemanticPageContext } from "@/lib/assistant/semantic-page-context";
import type { AssistantTurn } from "@/store/assistant-session";
import { AssistantProse, sanitizeAssistantText } from "./assistant-prose";
import { copilotConfigHint } from "./assistant-model-hint";

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
  pageLabel,
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
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [pathMeta, setPathMeta] = useState(pageLabel || "/");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live selection chip (plan Step 4)
  useEffect(() => {
    const tick = () => {
      try {
        const t = window.getSelection()?.toString()?.trim();
        setSelectedChip(t ? t.slice(0, 120) : null);
        const ctx = captureSemanticPageContext({ maxMainText: 500 });
        setPathMeta(ctx.path || pageLabel || "/");
      } catch {
        /* ignore */
      }
    };
    tick();
    document.addEventListener("selectionchange", tick);
    return () => document.removeEventListener("selectionchange", tick);
  }, [pageLabel]);

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
        // send() already appends user; surface error as assistant line via throw handling in parent
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
      <div className={`px-4 py-2.5 border-b ${line} shrink-0 space-y-2`}>
        <p className={`text-[11px] leading-snug ${muted}`}>
          Page context: <span className={`font-medium ${ink}`}>{pathMeta}</span>
          {" · "}semantic reader active
        </p>
        {selectedChip && (
          <div
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${
              isDark ? "bg-[#703AE6]/20 text-[#D4C4FF]" : "bg-[#703AE6]/10 text-[#5B2BB8]"
            }`}
            title={selectedChip}
          >
            <span className="shrink-0 font-semibold">Context: Selected Text</span>
            <span className="truncate opacity-90">“{selectedChip}”</span>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {["Summarize this page", "What am I looking at?", "Where can I go next?"].map(
            (label) => (
              <button
                key={label}
                type="button"
                disabled={busy}
                onClick={() => void run(label)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  isDark
                    ? "bg-[#222] text-[#ccc] hover:bg-[#2e2e2e]"
                    : "bg-[#f3f3f3] text-[#444] hover:bg-[#e9e9e9]"
                }`}
              >
                {label}
              </button>
            ),
          )}
        </div>
        <p className={`text-[10px] ${muted}`}>{copilotConfigHint()}</p>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-6">
        {turns.length === 0 && !busy && (
          <div className="space-y-3 pt-1">
            <p className={`text-[16px] font-semibold tracking-tight ${ink}`}>
              Ask about this page
            </p>
            <p className={`text-[13px] leading-relaxed ${muted}`}>
              I read the live page structure and content. Highlight text for focused answers.
              I can scroll to sections, highlight UI, or navigate you to other pages.
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
            Reading page…
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
          placeholder="Ask about this page…"
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
