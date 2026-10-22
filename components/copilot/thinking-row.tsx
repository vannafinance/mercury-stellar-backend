"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { VANNA_ICON_SRC } from "@/components/copilot/vanna-icon-data";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";

/** How long each progress line stays before the next one; the last line holds until the reply lands. */
const STATUS_LINE_MS = 2200;

/** Lines already fetched for a prompt, so a re-render or remount does not ask again. */
const fetched = new Map<string, string[]>();

/**
 * The row under a sent message while the reply is worked out (as on the Solana Copilot): the Vanna mark, a spinner and
 * a line about what is happening. The lines come from the model, worded for this prompt (`/api/copilot/status`); until
 * they arrive, and if none come (signed out, model unavailable), it shows `fallback`: the investigation's own progress,
 * or "Thinking…" before there is any. No elapsed-time clock.
 */
export function ThinkingRow({ prompt, fallback }: { prompt: string; fallback: string }) {
  const [state, setState] = useState<{ prompt: string; lines: string[] } | null>(null);
  const lines = fetched.get(prompt) ?? (state?.prompt === prompt ? state.lines : null);

  useEffect(() => {
    if (!prompt.trim() || fetched.has(prompt)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const headers = await copilotRequestHeaders();
        const res = await fetch("/api/copilot/status", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
          cache: "no-store",
        });
        const body = res.ok ? ((await res.json()) as { lines?: unknown }) : {};
        const got = Array.isArray(body.lines) ? body.lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0) : [];
        if (got.length) fetched.set(prompt, got);
        if (!controller.signal.aborted) setState({ prompt, lines: got });
      } catch {
        if (!controller.signal.aborted) setState({ prompt, lines: [] });
      }
    })();
    return () => controller.abort();
  }, [prompt]);

  // A new set of lines remounts the ticker, which restarts it from the first line.
  const shown = lines?.length ? lines : [fallback];
  return <StatusTicker key={shown.join("|")} lines={shown} />;
}

function StatusTicker({ lines }: { lines: string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (lines.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((i) => {
        if (i + 1 >= lines.length - 1) window.clearInterval(timer);
        return Math.min(i + 1, lines.length - 1);
      });
    }, STATUS_LINE_MS);
    return () => window.clearInterval(timer);
  }, [lines]);
  const label = lines[index] ?? "Thinking…";
  return (
    <div className="flex items-start gap-2.5">
      <img src={VANNA_ICON_SRC} alt="" width={18} height={18} className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full" aria-hidden />
      <p role="status" aria-live="polite" className="m-0 flex items-center gap-2 text-[13px] leading-[20px] text-violet-500">
        <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden />
        <span>{label}</span>
      </p>
    </div>
  );
}
