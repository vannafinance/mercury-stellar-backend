"use client";

/**
 * Renders assistant replies as polished document prose — no raw ** markdown stars.
 * Uses app font stack (Plus Jakarta via body).
 */

import { useMemo } from "react";
import { useTheme } from "@/contexts/theme-context";

/** Strip markdown emphasis / headings / fences the model sometimes still emits. */
export function sanitizeAssistantText(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  // code fences
  s = s.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```\w*\n?/g, "").replace(/```/g, "").trim(),
  );
  // **bold** / *italic* / __bold__
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  // markdown headings
  s = s.replace(/^#{1,6}\s+/gm, "");
  // markdown list markers to bullet
  s = s.replace(/^\s*[-*+]\s+/gm, "• ");
  // collapse excess blank lines
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; text: string }
  | { type: "ol"; items: string[] }
  | { type: "ul"; items: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const isSectionTitle = (line: string) => {
    const t = line.trim();
    if (!t || t.length > 72) return false;
    // "Swap on this page" or "1. Swap on this page" or ends with :
    if (/^\d+\.\s+\S/.test(t) && t.length < 60 && !t.includes(". ")) {
      // numbered title-only line handled as list item usually
    }
    if (/^[A-Z0-9].{2,60}:$/.test(t)) return true;
    if (/^(What you can do|Options|Summary|On this page|Balances|Next steps|Overview)\b/i.test(t))
      return true;
    // Title-case short line without trailing period
    if (/^[A-Z][\w\s/&,-]{2,50}$/.test(t) && !/[.!?]$/.test(t) && t.split(" ").length <= 8)
      return true;
    return false;
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i++;
      continue;
    }

    // Ordered list run
    if (/^\d+[\.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[\.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[\.)]\s+/, ""));
        i++;
        // continuation lines indented
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^\d+[\.)]\s+/.test(lines[i].trim()) &&
          !/^•\s+/.test(lines[i].trim()) &&
          !isSectionTitle(lines[i]) &&
          (lines[i].startsWith("  ") || lines[i].startsWith("\t") || /^[a-z(]/.test(lines[i].trim()))
        ) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        }
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Unordered bullets
    if (/^•\s+/.test(line) || /^[-–—]\s+/.test(line)) {
      const items: string[] = [];
      while (
        i < lines.length &&
        (/^•\s+/.test(lines[i].trim()) || /^[-–—]\s+/.test(lines[i].trim()))
      ) {
        items.push(lines[i].trim().replace(/^([•\-–—])\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (isSectionTitle(line)) {
      blocks.push({ type: "h", text: line.replace(/:$/, "") });
      i++;
      continue;
    }

    // Paragraph: merge consecutive non-empty non-special lines
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\d+[\.)]\s+/.test(lines[i].trim()) &&
      !/^•\s+/.test(lines[i].trim()) &&
      !isSectionTitle(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }

  return blocks;
}

export function AssistantProse({ text }: { text: string }) {
  const { isDark } = useTheme();
  const cleaned = useMemo(() => sanitizeAssistantText(text), [text]);
  const blocks = useMemo(() => parseBlocks(cleaned), [cleaned]);

  const ink = isDark ? "text-[#F2F2F2]" : "text-[#1A1A1A]";
  const muted = isDark ? "text-[#A0A0A0]" : "text-[#5C5C5C]";
  const accent = "text-[#703AE6]";
  const bullet = isDark ? "text-[#B8A0F0]" : "text-[#703AE6]";

  return (
    <div
      className={`assistant-prose space-y-3 text-[13.5px] leading-[1.65] tracking-[-0.01em] ${ink}`}
      style={{ fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif" }}
    >
      {blocks.map((b, i) => {
        if (b.type === "h") {
          return (
            <h3
              key={i}
              className={`pt-1 text-[12px] font-semibold uppercase tracking-[0.06em] ${accent}`}
            >
              {b.text}
            </h3>
          );
        }
        if (b.type === "ol") {
          return (
            <ol key={i} className="m-0 list-none space-y-2.5 p-0">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-2.5">
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      isDark ? "bg-[#703AE6]/25 text-[#D4C4FF]" : "bg-[#703AE6]/12 text-[#703AE6]"
                    }`}
                  >
                    {j + 1}
                  </span>
                  <span className="min-w-0 flex-1">{item}</span>
                </li>
              ))}
            </ol>
          );
        }
        if (b.type === "ul") {
          return (
            <ul key={i} className="m-0 list-none space-y-1.5 p-0">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-2">
                  <span className={`mt-[0.35em] shrink-0 text-[10px] ${bullet}`}>●</span>
                  <span className="min-w-0 flex-1">{item}</span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className={i === 0 ? `font-medium ${ink}` : muted}>
            {b.text}
          </p>
        );
      })}
    </div>
  );
}
