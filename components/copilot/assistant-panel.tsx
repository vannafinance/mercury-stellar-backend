"use client";

/**
 * Assistant drawer body — the Guide surface from the Copilot design.
 *
 * The Guide explains; the Copilot acts. A turn renders as the design's article
 * (summary → sections → glossary → follow-ups) whenever the brain returned a
 * structured answer, and falls back to prose when it returned only text — an error,
 * a clarification, or a turn that navigated the page instead of explaining it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import type { AssistantTurn } from "@/store/assistant-session";
import { AssistantProse, sanitizeAssistantText } from "./assistant-prose";
import { GuideAnswerView, GuideQuestion, GuideSkeleton } from "./guide-answer-view";

export type AssistantSend = (message: string) => Promise<{
  kind: string;
  message: string;
  client_tools?: Array<{ name: string; args: Record<string, unknown> }> | null;
  data?: Record<string, unknown> | null;
}>;

/** Openers that show what the Guide is for: mechanics and this page, never a trade. */
const SUGGESTIONS = [
  "What is a health factor and how do I keep mine safe?",
  "What am I looking at on this page?",
  "What is Blend, and how does supplying differ from Earn?",
  "What happens if I cancel a multi-leg plan halfway through?",
];

export function AssistantPanel({
  send,
  prefill,
  onConsumedPrefill,
  turns,
  onShowRef,
}: {
  send: AssistantSend;
  prefill?: string | null;
  onConsumedPrefill?: () => void;
  pageLabel?: string;
  turns: AssistantTurn[];
  /** Scroll to and pulse the element an answer points at. */
  onShowRef?: (ref: { label: string; elementId: string }) => void;
}) {
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

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-assistant-panel
      style={{ fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif" }}
    >
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-[22px] pb-7">
        {turns.length === 0 && !busy && (
          <div>
            <h3 className="text-[19px] font-semibold leading-7 text-vgray-900">Ask anything</h3>
            <p className="mt-2.5 text-[14.5px] leading-[25px] text-vgray-500 text-pretty">
              About this page, Vanna products, or how a multi-step strategy works. The Assistant
              reads the page and explains it — Copilot is the one that acts.
            </p>
            <div className="mt-5 flex flex-col gap-[7px]">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void run(s)}
                  className="cursor-pointer rounded-r3 border border-vgray-100 bg-transparent px-3.5 py-[11px] text-left text-[14px] text-vgray-700 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-7">
          {turns.map((e, i) =>
            e.role === "user" ? (
              <div key={i} className={i > 0 ? "border-t border-vgray-100 pt-7" : undefined}>
                <GuideQuestion text={e.text} />
              </div>
            ) : e.guide ? (
              <GuideAnswerView
                key={i}
                answer={e.guide}
                onAsk={(q) => void run(q)}
                onShowRef={onShowRef}
                hasPageContext={e.hasPageContext !== false}
              />
            ) : (
              <AssistantProse key={i} text={sanitizeAssistantText(e.text)} />
            ),
          )}
        </div>

        {busy && (
          <div className={turns.length ? "mt-7" : undefined}>
            <GuideSkeleton />
          </div>
        )}
      </div>

      <form
        className="sticky bottom-0 z-[3] flex shrink-0 items-center gap-2.5 border-t border-vgray-100 bg-surface px-[18px] pt-3.5 pb-[18px]"
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
          aria-label="Ask the Assistant about this page"
          disabled={busy}
          className="min-w-0 flex-1 rounded-r3 border border-vgray-100 bg-transparent px-3.5 py-3 text-[14px] text-vgray-900 outline-none transition-colors placeholder:text-vgray-400 focus:border-violet-400 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="flex shrink-0 items-center justify-center rounded-r3 bg-gradient px-3.5 py-3 text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-none disabled:bg-vgray-100 disabled:text-vgray-400 disabled:opacity-100"
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
