"use client";

/**
 * Lightweight ask/answer surface for the floating page-aware assistant.
 * Shares /api/copilot with the full copilot workspace; concept/guide answers
 * are pure prose (no facts grid). Writes that need signing deep-link to /copilot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useTheme } from "@/contexts/theme-context";
import type { PageDescriptor } from "@/contexts/page-context";

export type AssistantSend = (message: string) => Promise<AssistantChatResponse>;

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
  chips?: string[];
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
      setTurns((t) => [...t, { role: "user", text }]);
      try {
        const res = await send(text);
        const chips =
          res.clarify_options?.map((c) => c.label).filter(Boolean) ??
          [];
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
            chips: chips.length ? chips : undefined,
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

  const metricChips =
    page?.metrics.filter((m) => m.glossaryKey).slice(0, 4).map((m) => m.label) ?? [];

  const surface = isDark ? "bg-[#161616] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]";
  const muted = isDark ? "text-[#888]" : "text-[#777]";
  const ink = isDark ? "text-white" : "text-[#111]";
  const bubbleUser = isDark ? "bg-[#703AE6]/text-white" : "bg-[#703AE6] text-white";
  const bubbleAsst = isDark ? "bg-[#1E1E1E] text-[#E8E8E8]" : "bg-[#F4F2FA] text-[#222]";
  const chipCls = isDark
    ? "border border-[#333] text-[#CCC] hover:border-[#703AE6] hover:text-white"
    : "border border-[#DDD] text-[#444] hover:border-[#703AE6] hover:text-[#703AE6]";

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
            {page ? `On ${page.title}` : "Page context unavailable"}
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
          <div className="space-y-3">
            <p className={`text-sm leading-relaxed ${muted}`}>
              {page
                ? `You're on ${page.title}. Ask what any number means, or what you can do here.`
                : "Open Margin, Earn, Farm, Portfolio, or Trade — then ask about what you see."}
            </p>
            {page?.purpose && (
              <p className={`text-xs leading-relaxed ${muted}`}>{page.purpose}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {metricChips.map((label) => (
                <button
                  key={label}
                  type="button"
                  disabled={busy}
                  onClick={() => run(`what is ${label}?`)}
                  className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${chipCls}`}
                >
                  What is {label}?
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => run("what is this page for?")}
                className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${chipCls}`}
              >
                What is this page for?
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => run("what can I do here?")}
                className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${chipCls}`}
              >
                What can I do here?
              </button>
            </div>
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
                  This action needs signing.{" "}
                  <Link href="/copilot" className="underline font-medium">
                    Open full copilot
                  </Link>{" "}
                  to approve.
                </p>
              )}
              {t.chips && t.chips.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.chips.map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={busy}
                      onClick={() => run(c)}
                      className={`rounded-full bg-black/10 px-2.5 py-1 text-[11px] ${
                        isDark ? "hover:bg-white/10" : "hover:bg-white/60"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
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
          placeholder={page ? `Ask about ${page.title}…` : "Ask Vanna…"}
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
