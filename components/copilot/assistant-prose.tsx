"use client";

/**
 * Renders assistant replies with clear spacing, bullets, and numbered steps.
 * Strips ** markdown stars; keeps structure AI models typically emit.
 */

import { useMemo } from "react";

/** Normalize model text for structured rendering. */
export function sanitizeAssistantText(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  s = s.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```\w*\n?/g, "").replace(/```/g, "").trim(),
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  // markdown / dash lists → bullet
  s = s.replace(/^\s*[-*+]\s+/gm, "• ");
  // First,/Second, → numbered
  s = s.replace(
    /^(First|Second|Third|Fourth|Fifth|Finally),?\s+/gim,
    (_m, w: string) => {
      const map: Record<string, string> = {
        first: "1. ",
        second: "2. ",
        third: "3. ",
        fourth: "4. ",
        fifth: "5. ",
        finally: "6. ",
      };
      return map[w.toLowerCase()] || "• ";
    },
  );
  // Keep intentional blank lines; cap runs of 3+
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; text: string }
  | { type: "ol"; items: string[] }
  | { type: "ul"; items: string[] };

function isSectionTitle(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 80) return false;
  if (/^\d+[\.)]\s+/.test(t) || /^•\s+/.test(t)) return false;
  if (/[:：]$/.test(t) && t.length < 70) return true;
  if (
    /^(What it means|How to do it|How it works|Key points|Options|Summary|Next steps|Steps|Overview|On this page|Balances|Risks?|Tips?)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // Short Title Case line without end punctuation
  if (
    /^[A-Z][\w\s/&,'-]{1,55}$/.test(t) &&
    !/[.!?]$/.test(t) &&
    t.split(/\s+/).length <= 8
  ) {
    return true;
  }
  return false;
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }

    // Ordered list
    if (/^\d+[\.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const L = lines[i].trim();
        if (!L) {
          // blank inside list ends the list (cleaner spacing)
          if (items.length) break;
          i++;
          continue;
        }
        if (/^\d+[\.)]\s+/.test(L)) {
          items.push(L.replace(/^\d+[\.)]\s+/, ""));
          i++;
          // soft wrap continuations
          while (
            i < lines.length &&
            lines[i].trim() &&
            !/^\d+[\.)]\s+/.test(lines[i].trim()) &&
            !/^•\s+/.test(lines[i].trim()) &&
            !isSectionTitle(lines[i]) &&
            (lines[i].startsWith("  ") ||
              lines[i].startsWith("\t") ||
              /^[a-z(]/.test(lines[i].trim()))
          ) {
            items[items.length - 1] += " " + lines[i].trim();
            i++;
          }
          continue;
        }
        break;
      }
      if (items.length) blocks.push({ type: "ol", items });
      continue;
    }

    // Unordered list
    if (/^•\s+/.test(line) || /^[-–—]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const L = lines[i].trim();
        if (!L) {
          if (items.length) break;
          i++;
          continue;
        }
        if (/^•\s+/.test(L) || /^[-–—]\s+/.test(L)) {
          items.push(L.replace(/^([•\-–—])\s+/, ""));
          i++;
          continue;
        }
        break;
      }
      if (items.length) blocks.push({ type: "ul", items });
      continue;
    }

    if (isSectionTitle(line)) {
      blocks.push({ type: "h", text: line.replace(/[:：]\s*$/, "") });
      i++;
      continue;
    }

    // Paragraph: only merge until blank or structure
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const L = lines[i];
      if (!L.trim()) break;
      if (/^\d+[\.)]\s+/.test(L.trim())) break;
      if (/^•\s+/.test(L.trim()) || /^[-–—]\s+/.test(L.trim())) break;
      if (isSectionTitle(L)) break;
      para.push(L.trim());
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }

  return blocks;
}

export function AssistantProse({ text }: { text: string }) {
  const cleaned = useMemo(() => sanitizeAssistantText(text), [text]);
  const blocks = useMemo(() => parseBlocks(cleaned), [cleaned]);

  // Tokens, not a JS theme branch. These five lines were ten hardcoded hexes chosen
  // per theme in render, which is the one place a theme can disagree with CSS: the
  // component had to re-render to recolour, and every value was invisible to the
  // palette. The drawer carries `.cp-root` (see `assistant-launcher`), so the
  // surface's own tokens resolve here and the theme is handled where the rest of the
  // app handles it.
  //
  // The step chip moves from an alpha wash on violet to the violet-50/violet-500
  // pair the rest of the copilot uses for a soft chip (21 other sites), so it now
  // matches them instead of approximating them.
  const ink = "text-[var(--g800)]";
  const body = "text-[var(--g500)]";
  const accent = "text-[var(--cp-violet-500)]";
  const bullet = accent;
  const stepBg = "bg-[var(--cp-violet-soft)] text-[var(--cp-violet-500)]";

  return (
    <div
      className={`assistant-prose flex flex-col gap-4 text-[13.5px] leading-[1.7] tracking-[-0.01em] ${ink}`}
      style={{ fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif" }}
    >
      {blocks.map((b, i) => {
        if (b.type === "h") {
          return (
            <h3
              key={i}
              className={`mt-1 text-[12px] font-semibold uppercase tracking-[0.07em] ${accent}`}
            >
              {b.text}
            </h3>
          );
        }
        if (b.type === "ol") {
          return (
            <ol key={i} className="m-0 flex list-none flex-col gap-3 p-0">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-3">
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${stepBg}`}
                  >
                    {j + 1}
                  </span>
                  <span className={`min-w-0 flex-1 pt-0.5 ${body}`}>{item}</span>
                </li>
              ))}
            </ol>
          );
        }
        if (b.type === "ul") {
          return (
            <ul key={i} className="m-0 flex list-none flex-col gap-2.5 p-0">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-2.5">
                  <span className={`mt-[0.45em] shrink-0 text-[8px] leading-none ${bullet}`}>
                    ●
                  </span>
                  <span className={`min-w-0 flex-1 ${body}`}>{item}</span>
                </li>
              ))}
            </ul>
          );
        }
        // Lead paragraph slightly stronger; later paras normal
        return (
          <p
            key={i}
            className={
              i === 0
                ? `font-medium leading-[1.7] ${ink}`
                : `leading-[1.7] ${body}`
            }
          >
            {b.text}
          </p>
        );
      })}
    </div>
  );
}
