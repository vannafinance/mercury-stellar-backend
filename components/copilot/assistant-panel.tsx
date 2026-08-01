"use client";

/**
 * Gemini-in-Chrome style side panel body.
 * Document-style polished replies (AssistantProse), live DOM snapshot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Crop, Loader2, Send } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import type { PageSnapshot } from "@/lib/assistant/capture-page";
import { AssistantProse, sanitizeAssistantText } from "./assistant-prose";
import { copilotConfigHint } from "./assistant-model-hint";

export type AssistantSend = (
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  snapshot: PageSnapshot,
) => Promise<{ kind: string; message: string; data?: Record<string, unknown> | null }>;

type Entry = {
  kind: "user" | "assist";
  text: string;
};

export function AssistantPanel({
  send,
  capture,
  prefill,
  onConsumedPrefill,
  pageLabel,
  onSelectRegion,
  selectingRegion,
}: {
  send: AssistantSend;
  capture: () => PageSnapshot;
  prefill?: string | null;
  onConsumedPrefill?: () => void;
  pageLabel?: string;
  onSelectRegion?: () => void;
  selectingRegion?: boolean;
}) {
  const { isDark } = useTheme();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [snapMeta, setSnapMeta] = useState<{
    path: string;
    chars: number;
    selection: boolean;
    region: boolean;
    metrics: number;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const entriesRef = useRef<Entry[]>([]);
  entriesRef.current = entries;

  const refreshMeta = useCallback(() => {
    try {
      const s = capture();
      setSnapMeta({
        path: s.path || "/",
        chars: s.char_count,
        selection: Boolean(s.selection),
        region: Boolean(s.region_text),
        metrics: s.metrics?.length ?? 0,
      });
    } catch {
      setSnapMeta(null);
    }
  }, [capture]);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta, pageLabel]);

  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      onConsumedPrefill?.();
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [prefill, onConsumedPrefill]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, busy]);

  const run = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;
      setBusy(true);
      setInput("");
      const snap = capture();
      setSnapMeta({
        path: snap.path || "/",
        chars: snap.char_count,
        selection: Boolean(snap.selection),
        region: Boolean(snap.region_text),
        metrics: snap.metrics?.length ?? 0,
      });
      const prior = entriesRef.current.map((e) => ({
        role: (e.kind === "user" ? "user" : "assistant") as "user" | "assistant",
        text: e.text,
      }));
      setEntries((prev) => [...prev, { kind: "user", text }]);
      try {
        const res = await send(text, prior, snap);
        setEntries((prev) => [
          ...prev,
          {
            kind: "assist",
            text: sanitizeAssistantText(res.message || "No reply."),
          },
        ]);
      } catch (e) {
        setEntries((prev) => [
          ...prev,
          {
            kind: "assist",
            text: e instanceof Error ? e.message : "Request failed.",
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, send, capture],
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
          Reading{" "}
          <span className={`font-medium ${ink}`}>{snapMeta?.path || pageLabel || "this page"}</span>
          {snapMeta && snapMeta.chars > 0
            ? ` · ${snapMeta.chars.toLocaleString()} chars`
            : " · capturing…"}
          {snapMeta && snapMeta.metrics > 0 ? ` · ${snapMeta.metrics} metrics` : ""}
          {snapMeta?.selection ? " · text selection" : ""}
          {snapMeta?.region ? " · screen region" : ""}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {[
            "Summarize this page",
            "What am I looking at?",
            snapMeta?.selection || snapMeta?.region
              ? "Explain what I selected"
              : null,
          ]
            .filter(Boolean)
            .map((label) => (
              <button
                key={label as string}
                type="button"
                disabled={busy || selectingRegion}
                onClick={() => void run(label as string)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  isDark
                    ? "bg-[#222] text-[#ccc] hover:bg-[#2e2e2e]"
                    : "bg-[#f3f3f3] text-[#444] hover:bg-[#e9e9e9]"
                }`}
              >
                {label}
              </button>
            ))}
          {onSelectRegion && (
            <button
              type="button"
              disabled={busy}
              onClick={onSelectRegion}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                selectingRegion
                  ? "bg-[#703AE6] text-white"
                  : isDark
                    ? "bg-[#222] text-[#ccc] hover:bg-[#2e2e2e]"
                    : "bg-[#f3f3f3] text-[#444] hover:bg-[#e9e9e9]"
              }`}
            >
              <Crop size={12} />
              {selectingRegion ? "Draw on page…" : "Select region"}
            </button>
          )}
        </div>
        <p className={`text-[10px] ${muted}`}>{copilotConfigHint()}</p>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-6">
        {entries.length === 0 && !busy && (
          <div className="space-y-3 pt-1">
            <p className={`text-[16px] font-semibold tracking-tight ${ink}`}>
              Ask about this page
            </p>
            <p className={`text-[13px] leading-relaxed ${muted}`}>
              I read the live screen — tables, labels, and balances — on any route.
              Highlight text or use Select region for a focused answer.
            </p>
          </div>
        )}

        {entries.map((e, i) =>
          e.kind === "user" ? (
            <div key={i} className="space-y-1">
              <p
                className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${muted}`}
              >
                You
              </p>
              <p className={`text-[13.5px] font-medium leading-relaxed ${ink}`}>{e.text}</p>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#703AE6]">
                Assistant
              </p>
              <AssistantProse text={e.text} />
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
          disabled={busy || selectingRegion}
          className={`min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-[13px] outline-none focus:border-[#703AE6] ${
            isDark
              ? "border-[#2a2a2a] bg-[#111] text-white placeholder:text-[#555]"
              : "border-[#e5e5e5] bg-[#fafafa] text-[#111] placeholder:text-[#aaa]"
          }`}
        />
        <button
          type="submit"
          disabled={busy || selectingRegion || !input.trim()}
          aria-label="Ask"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#703AE6] text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>
    </div>
  );
}
