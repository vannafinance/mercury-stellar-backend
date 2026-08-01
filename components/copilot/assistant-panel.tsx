"use client";

/**
 * Floating page-aware assistant panel.
 * Free-form chat via Gemini + page_context; multi-turn history; no canned Q&A.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/contexts/theme-context";
import type { PageDescriptor } from "@/contexts/page-context";

export type AssistantSend = (
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
) => Promise<AssistantChatResponse>;

export type AssistantChatResponse = {
  kind: string;
  message: string;
  clarify_options?: Array<{ id: string; label: string; description?: string }> | null;
  intent?: { template_id?: string | null } | null;
  unsigned_xdr?: string | null;
  preview?: { human_summary?: string } | null;
};

type Turn = {
  role: "user" | "assistant";
  text: string;
  needsCopilot?: boolean;
};

export function AssistantPanel({
  send,
  page,
  prefill,
  onConsumedPrefill,
}: {
  send: AssistantSend;
  page: PageDescriptor | null;
  prefill?: string | null;
  onConsumedPrefill?: () => void;
}) {
  const { isDark } = useTheme();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

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
      const prior = turnsRef.current.map((t) => ({ role: t.role, text: t.text }));
      setTurns((t) => [...t, { role: "user", text }]);
      try {
        const res = await send(text, prior);
        const needsCopilot =
          res.kind === "preview" ||
          res.kind === "needs_auto_sign" ||
          res.kind === "needs_wallet_sign" ||
          !!res.unsigned_xdr;
        const body =
          res.message ||
          res.preview?.human_summary ||
          (res.kind === "error" ? "Something went wrong." : "No reply.");
        setTurns((t) => [
          ...t,
          {
            role: "assistant",
            text: body,
            needsCopilot,
          },
        ]);
      } catch (e) {
        setTurns((t) => [
          ...t,
          {
            role: "assistant",
            text: e instanceof Error ? e.message : "Request failed.",
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, send],
  );

  const surface = isDark ? "bg-[#161616] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]";
  const muted = isDark ? "text-[#888]" : "text-[#777]";
  const ink = isDark ? "text-white" : "text-[#111]";
  const bubbleUser = "bg-[#703AE6] text-white";
  const bubbleAsst = isDark ? "bg-[#1E1E1E] text-[#E8E8E8]" : "bg-[#F4F2FA] text-[#222]";

  return (
    <div
      className={`flex h-[min(70vh,560px)] w-full max-w-md flex-col overflow-hidden rounded-2xl border shadow-xl ${surface}`}
    >
      <header
        className={`flex items-center gap-2 border-b px-4 py-3 ${
          isDark ? "border-[#2A2A2A]" : "border-[#EEE]"
        }`}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#703AE6] to-[#9B6CFF] text-white">
          <Sparkles size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${ink}`}>Vanna Assistant</p>
          <p className={`truncate text-[11px] ${muted}`}>
            {page ? `${page.title} · ask anything` : "Ask anything about Vanna"}
          </p>
        </div>
        <Link
          href="/copilot"
          className={`text-[11px] font-medium underline-offset-2 hover:underline ${muted}`}
        >
          Full copilot
        </Link>
      </header>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {turns.length === 0 && (
          <div className="space-y-2 pt-2">
            <p className={`text-sm leading-relaxed ${ink}`}>
              Hi — I can explain what you&apos;re looking at, how Vanna works, and what
              options this screen gives you.
            </p>
            <p className={`text-xs leading-relaxed ${muted}`}>
              {page
                ? `Context: ${page.title}. Talk naturally — follow-ups work.`
                : "Open a product page so I can see the same numbers you see."}
            </p>
            <p className={`text-[11px] leading-relaxed ${muted}`}>
              For live balances or on-chain actions (lend, swap, borrow…), say it as a
              command or use Full copilot.
            </p>
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={`${t.role}-${i}`}
            className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                t.role === "user" ? bubbleUser : bubbleAsst
              }`}
            >
              {t.text}
              {t.needsCopilot && (
                <p className="mt-2 text-[11px] opacity-90">
                  This needs signing.{" "}
                  <Link href="/copilot" className="underline font-medium">
                    Open full copilot
                  </Link>
                  .
                </p>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className={`flex items-center gap-2 text-xs ${muted}`}>
            <Loader2 size={14} className="animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      <form
        className={`flex items-center gap-2 border-t p-3 ${
          isDark ? "border-[#2A2A2A]" : "border-[#EEE]"
        }`}
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            page ? `Ask about ${page.title} or anything on Vanna…` : "Ask me anything…"
          }
          disabled={busy}
          className={`min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-[13px] outline-none focus:border-[#703AE6] ${
            isDark
              ? "border-[#2A2A2A] bg-[#111] text-white placeholder:text-[#555]"
              : "border-[#E5E5E5] bg-[#FAFAFA] text-[#111] placeholder:text-[#AAA]"
          }`}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#703AE6] text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>
    </div>
  );
}
