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
import { Crop, Send, X } from "lucide-react";
import Image from "next/image";
import type { AssistantPhase } from "@/lib/assistant/phase";
import toast from "react-hot-toast";
import { CopyIcon } from "@/components/icons";
import type { AssistantImageAttachment } from "@/lib/copilot/types";
import { MAX_ATTACHMENTS } from "@/lib/assistant/packet";
import { compressImageFile, isAllowedImageMime } from "@/lib/assistant/image-attach";
import type { AssistantTurn } from "@/store/assistant-session";
import { AssistantProse, sanitizeAssistantText } from "./assistant-prose";
import { GuideAnswerView, GuideQuestion, GuideSkeleton } from "./guide-answer-view";

export type AssistantSendExtras = {
  attachments: AssistantImageAttachment[];
  selectedText?: string | null;
};

export type AssistantSend = (
  message: string,
  extras?: AssistantSendExtras,
) => Promise<{
  kind: string;
  message: string;
  client_tools?: Array<{ name: string; args: Record<string, unknown> }> | null;
  data?: Record<string, unknown> | null;
}>;

/** Short openers, Gemini-style — chips hug the text, they don’t stretch full width. */
const SUGGESTIONS = [
  "What can you do?",
  "What am I looking at?",
  "What is a health factor?",
  "How is Earn different from Farm?",
];

function CopyTurn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1400);
          },
          () => undefined,
        );
      }}
      className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-r2 border border-vgray-100 bg-transparent px-2.5 py-1.5 text-[12px] font-semibold text-vgray-800 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
    >
      <CopyIcon width={12} height={13} stroke="currentColor" />
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function VannaMark() {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-r2 bg-violet-50"
    >
      <Image src="/logos/vanna-icon.png" alt="" width={14} height={14} className="object-contain" />
    </span>
  );
}

function snippetLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= 40) return t;
  return `${t.slice(0, 37)}…`;
}

function composeMessage(
  input: string,
  selection: string | null,
  hasVisual: boolean,
): string {
  const text = input.trim();
  if (text) return text;
  if (selection) return `Ask about “${snippetLabel(selection)}”`;
  if (hasVisual) return "What am I looking at?";
  return "";
}

export function AssistantPanel({
  send,
  prefill,
  onConsumedPrefill,
  turns,
  onSelectFromScreen,
  hasRegion,
  onClearRegion,
  phase = "idle",
}: {
  send: AssistantSend;
  prefill?: string | null;
  onConsumedPrefill?: () => void;
  pageLabel?: string;
  turns: AssistantTurn[];
  onSelectFromScreen?: () => void;
  hasRegion?: boolean;
  onClearRegion?: () => void;
  phase?: AssistantPhase;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [attachments, setAttachments] = useState<AssistantImageAttachment[]>([]);
  const [selectionSnippet, setSelectionSnippet] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const lastAnswerRef = useRef<HTMLDivElement>(null);
  const waiting = busy || phase !== "idle";
  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      onConsumedPrefill?.();
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [prefill, onConsumedPrefill]);

  useEffect(() => {
    const list = listRef.current;
    const target = waiting ? lastUserRef.current : lastAnswerRef.current ?? lastUserRef.current;
    if (!list || !target) return;
    const top = target.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
  }, [turns.length, waiting]);

  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 4) return;
      const node = sel.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      if (el?.closest("[data-assistant-panel]")) return;
      // Don't steal in-progress form edits on Earn / Margin / Farm.
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      setSelectionSnippet(text.slice(0, 240));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const ingestFiles = useCallback(async (files: File[], source: "paste" | "drop") => {
    let rejected = false;
    const next: AssistantImageAttachment[] = [];
    for (const file of files) {
      if (!isAllowedImageMime(file.type)) {
        rejected = true;
        continue;
      }
      try {
        const att = await compressImageFile(file, source);
        if (att) next.push(att);
        else rejected = true;
      } catch {
        rejected = true;
      }
    }
    if (next.length) {
      setAttachments((prev) => [...prev, ...next].slice(-MAX_ATTACHMENTS));
    }
    if (rejected) {
      toast("Only PNG, JPEG, or WebP screenshots can be attached.", { duration: 2200 });
    }
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((f): f is File => !!f);
      if (!files.length) return;
      e.preventDefault();
      void ingestFiles(files, "paste");
    },
    [ingestFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      void ingestFiles(files, "drop");
    },
    [ingestFiles],
  );

  const run = useCallback(
    async (message: string, extras?: AssistantSendExtras) => {
      const visual = (extras?.attachments?.length ?? 0) > 0 || !!hasRegion;
      const text = composeMessage(message, extras?.selectedText ?? selectionSnippet, visual);
      if (!text || busy) return;
      setBusy(true);
      setInput("");
      setAttachments([]);
      setSelectionSnippet(null);
      try {
        await send(text, extras ?? { attachments: [], selectedText: selectionSnippet });
      } catch (e) {
        console.error("[assistant]", e);
      } finally {
        setBusy(false);
      }
    },
    [busy, send, hasRegion, selectionSnippet],
  );

  const submitComposer = useCallback(() => {
    void run(input, { attachments, selectedText: selectionSnippet });
  }, [run, input, attachments, selectionSnippet]);

  const canSend =
    !waiting &&
    (!!input.trim() || attachments.length > 0 || !!hasRegion || !!selectionSnippet);

  const hasChips = attachments.length > 0 || hasRegion || !!selectionSnippet;

  const loadingHint =
    phase === "capturing"
      ? "Reading this page…"
      : phase === "thinking"
        ? "Thinking — answers usually take 10–30 seconds."
        : "Working…";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-assistant-panel
      style={{ fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif" }}
      onPaste={onPaste}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-[22px] pb-7">
        <div className="flex flex-col gap-6">
          {turns.map((e, i) => {
            const lastUserIdx = turns.reduce((acc, t, idx) => (t.role === "user" ? idx : acc), -1);
            const lastAssistantIdx = turns.reduce(
              (acc, t, idx) => (t.role === "assistant" ? idx : acc),
              -1,
            );
            if (e.role === "user") {
              return (
                <div key={i} ref={i === lastUserIdx ? lastUserRef : undefined}>
                  <GuideQuestion text={e.text} />
                </div>
              );
            }
            return (
              <div
                key={i}
                ref={!waiting && i === lastAssistantIdx ? lastAnswerRef : undefined}
                className="flex items-start gap-2.5"
              >
                <VannaMark />
                <div className="min-w-0 flex-1">
                  {e.guide ? (
                    <GuideAnswerView
                      answer={e.guide}
                      onAsk={(q) => void run(q)}
                      hasPageContext={e.hasPageContext !== false}
                    />
                  ) : (
                    <AssistantProse text={sanitizeAssistantText(e.text)} />
                  )}
                  <CopyTurn text={e.text} />
                </div>
              </div>
            );
          })}
        </div>

        {waiting && (
          <div
            className={`flex items-start gap-2.5 ${turns.length ? "mt-6" : ""}`}
            ref={lastAnswerRef}
          >
            <VannaMark />
            <div className="min-w-0 flex-1">
              <GuideSkeleton status={loadingHint} />
            </div>
          </div>
        )}
      </div>

      {turns.length === 0 && !waiting && (
        <div className="shrink-0 px-[18px] pb-3">
          <h3 className="text-[22px] font-semibold leading-7 text-violet-500">Hello</h3>
          <p className="mt-1 text-[22px] font-semibold leading-7 text-vgray-900">
            How can I help you today?
          </p>
          <div className="mt-5 flex flex-col items-start gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void run(s)}
                className="cursor-pointer rounded-full bg-vgray-50 px-3.5 py-2 text-left text-[13.5px] text-vgray-800 transition-colors hover:bg-violet-50 hover:text-violet-500"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        className={`sticky bottom-0 z-[3] flex shrink-0 flex-col gap-2 border-t border-vgray-100 bg-surface px-[18px] pt-3.5 pb-[18px] ${
          dragging ? "outline outline-2 outline-violet-400 outline-offset-[-2px]" : ""
        }`}
        onSubmit={(e) => {
          e.preventDefault();
          submitComposer();
        }}
      >
        {hasChips && (
          <div className="flex flex-wrap gap-1.5">
            {hasRegion && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-r2 border border-violet-50 bg-violet-50 px-2.5 py-1 text-[12px] font-medium text-violet-500">
                Selected region · page text
                <button
                  type="button"
                  aria-label="Remove selected region"
                  onClick={() => onClearRegion?.()}
                  className="cursor-pointer rounded-r2 text-violet-500 transition-colors hover:text-vgray-800"
                >
                  <X size={12} />
                </button>
              </span>
            )}
            {selectionSnippet && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-r2 border border-violet-50 bg-violet-50 px-2.5 py-1 text-[12px] font-medium text-violet-500">
                <span className="min-w-0 truncate">Ask about “{snippetLabel(selectionSnippet)}”</span>
                <button
                  type="button"
                  aria-label="Clear text selection"
                  onClick={() => {
                    setSelectionSnippet(null);
                    window.getSelection()?.removeAllRanges();
                  }}
                  className="cursor-pointer rounded-r2 text-violet-500 transition-colors hover:text-vgray-800"
                >
                  <X size={12} />
                </button>
              </span>
            )}
            {attachments.map((att, i) => (
              <span
                key={`${att.source}-${i}-${att.width}x${att.height}`}
                className="inline-flex items-center gap-1.5 rounded-r2 border border-violet-50 bg-violet-50 py-0.5 pr-2 pl-0.5 text-[12px] font-medium text-violet-500"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${att.mime};base64,${att.data}`}
                  alt=""
                  width={22}
                  height={22}
                  className="h-[22px] w-[22px] rounded-[6px] object-cover"
                />
                {att.source === "drop" ? "Dropped screenshot" : "Screenshot"}
                <button
                  type="button"
                  aria-label="Remove screenshot"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="cursor-pointer rounded-r2 text-violet-500 transition-colors hover:text-vgray-800"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex h-[42px] items-center gap-2">
          <button
            type="button"
            title="Select part of the page (sends that region’s text with your question)"
            aria-label="Select part of the page"
            disabled={waiting}
            onClick={() => onSelectFromScreen?.()}
            className="flex h-full w-[42px] shrink-0 cursor-pointer items-center justify-center rounded-r3 border border-vgray-100 bg-transparent text-vgray-700 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Crop size={16} />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitComposer();
              }
            }}
            placeholder="Ask anything…"
            aria-label="Ask Vanna Assist about this page"
            disabled={waiting}
            autoComplete="off"
            className="box-border h-full min-w-0 flex-1 rounded-r3 border border-vgray-100 bg-transparent px-3.5 text-[14px] text-vgray-900 outline-none transition-colors placeholder:text-vgray-400 focus:border-violet-400 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            className="flex h-full w-[42px] shrink-0 items-center justify-center rounded-r3 bg-gradient text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
