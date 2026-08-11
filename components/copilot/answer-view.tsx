"use client";

/**
 * Renders a structured read answer.
 *
 * The model returns headline / facts / note / venue as data; layout, alignment and
 * precision are decided here. That is the point — every formatting rule the prompt used
 * to beg for (no markdown, two decimals on percentages, name the venue, bullets for
 * three or more figures) is now either impossible to violate or applied in one place.
 *
 * ## Two kinds of fact, two layouts
 *
 * Figures (rates, amounts, health factors) belong in a tight two-column grid with tabular
 * numerals, so a set of them lines up down the column and is scannable.
 *
 * An **identifier** does not. A Stellar address is 56 characters with no natural break
 * point, and forcing one through a `1fr auto` grid produced both of the failures reported
 * on this card:
 *
 *   - the value column stretched, squeezing the label column until "REGISTRY" wrapped one
 *     letter at a time — "REG / IST / RY";
 *   - and where the address was shortened to fit, it rendered `CBBQQULN…5LDXUO`, which
 *     cannot be checked against a deployment. "Is this the right contract?" is the *only*
 *     question anyone asks of a protocol address, and a truncated one cannot answer it.
 *
 * So identifiers get their own full-width row: label above, the complete value below in
 * monospace, with a copy button. Nothing is hidden and nothing is squeezed.
 *
 * Brand: Plus Jakarta Sans inherited for prose, monospace for every figure and
 * identifier, radius/spacing/colour from the tokens in `globals.css` so this card
 * re-themes in dark alongside the rest of the copilot surface.
 */

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { AnswerFact, AnswerVenue, StructuredAnswer } from "@/lib/copilot/answer-schema";

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Answer venues map onto the plan card's venue palette so colour means one thing. */
const VENUE_TOKEN: Record<Exclude<AnswerVenue, "none">, string> = {
  earn: "earn",
  blend: "farm",
  aquarius: "farm",
  margin: "margin",
  wallet: "wallet",
  oracle: "wallet",
};

const VENUE_LABEL: Record<Exclude<AnswerVenue, "none">, string> = {
  earn: "vanna earn",
  blend: "blend",
  aquarius: "aquarius lp",
  margin: "margin account",
  wallet: "wallet",
  oracle: "oracle",
};

function toneColor(tone: AnswerFact["tone"]): string {
  switch (tone) {
    case "good":
      return "var(--cp-venue-earn-fg)";
    case "warn":
      return "var(--cp-warn-fg)";
    case "bad":
      return "var(--cp-danger-fg)";
    default:
      return "var(--cp-g900)";
  }
}

/**
 * Is this value an identifier rather than a figure?
 *
 * Stellar G-/C-addresses are exactly 56 base32 characters. Transaction hashes are 64 hex.
 * Both are checked in full rather than by length alone, so a long *sentence* in a fact
 * value is not mistaken for something to lay out as an address.
 */
function isIdentifier(v: string): boolean {
  const s = v.trim();
  return /^[GC][A-Z2-7]{55}$/.test(s) || /^[0-9a-f]{64}$/i.test(s);
}

/** Copy affordance. An address you cannot copy is only marginally better than a truncated one. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      })
      .catch(() => {
        /* clipboard blocked — the value is still selectable */
      });
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      className="shrink-0 rounded-[8px] p-1.5 transition-colors"
      style={{
        border: "1px solid var(--cp-g100)",
        color: done ? "var(--cp-venue-earn-fg)" : "var(--cp-g400)",
        background: "transparent",
      }}
    >
      {done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

/** Label styling is shared so a figure row and an identifier row read as one system. */
const labelStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--cp-g400)",
  // Never shatter a word to fit a column — this is what produced "REG / IST / RY".
  overflowWrap: "normal",
  wordBreak: "keep-all",
};

export function AnswerView({ answer }: { answer: StructuredAnswer }) {
  const venue = answer.venue && answer.venue !== "none" ? answer.venue : null;
  const token = venue ? VENUE_TOKEN[venue] : null;

  const facts = answer.facts ?? [];
  const figures = facts.filter((f) => !isIdentifier(f.value));
  const identifiers = facts.filter((f) => isIdentifier(f.value));

  return (
    <div>
      {venue && token ? (
        <span
          className="mb-3 inline-flex items-center gap-1.5 rounded-full font-bold uppercase"
          style={{
            border: `1px solid var(--cp-venue-${token}-bd)`,
            background: `var(--cp-venue-${token}-bg)`,
            color: `var(--cp-venue-${token}-fg)`,
            padding: "3px 10px 3px 8px",
            fontFamily: MONO,
            fontSize: 9.5,
            letterSpacing: ".16em",
          }}
        >
          <span
            aria-hidden="true"
            className="h-[5px] w-[5px] rounded-full"
            style={{ background: `var(--cp-venue-${token}-fg)` }}
          />
          {VENUE_LABEL[venue]}
        </span>
      ) : null}

      <p
        className="m-0 font-medium"
        style={{
          fontSize: 19,
          lineHeight: "28px",
          color: "var(--cp-g900)",
          textWrap: "pretty",
          maxWidth: 620,
        }}
      >
        {answer.headline}
      </p>

      {/* Figures — tight two-column grid, tabular numerals, right-aligned to line up. */}
      {figures.length > 0 ? (
        <dl
          className="mt-4 grid gap-x-8 gap-y-0"
          style={{ gridTemplateColumns: "minmax(0,1fr) auto", maxWidth: 520 }}
        >
          {figures.map((f, i) => (
            <div
              key={`${f.label}-${i}`}
              className="col-span-2 grid items-baseline gap-x-8 py-2"
              style={{
                gridTemplateColumns: "minmax(0,1fr) auto",
                borderBottom: i === figures.length - 1 ? "none" : "1px solid var(--cp-g100)",
              }}
            >
              <dt style={labelStyle}>{f.label}</dt>
              <dd
                className="m-0 text-right"
                style={{
                  fontFamily: MONO,
                  fontSize: 15,
                  fontVariantNumeric: "tabular-nums",
                  color: toneColor(f.tone),
                }}
              >
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
        Identifiers — one full-width row each, complete value, copyable.

        `min-w-0` on the value wrapper plus `break-all` is what lets a 56-character string
        wrap inside its own row instead of pushing the layout sideways. The row is a panel
        rather than a table cell because the value is the content here, not a column.
      */}
      {identifiers.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2" style={{ maxWidth: 620 }}>
          {identifiers.map((f, i) => (
            <div
              key={`${f.label}-${i}`}
              className="rounded-[12px] px-3.5 py-3"
              style={{ border: "1px solid var(--cp-g100)", background: "var(--cp-g50)" }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="m-0 mb-1.5" style={labelStyle}>
                    {f.label}
                  </p>
                  <p
                    className="m-0 select-all"
                    style={{
                      fontFamily: MONO,
                      fontSize: 12.5,
                      lineHeight: "18px",
                      color: "var(--cp-g900)",
                      wordBreak: "break-all",
                    }}
                  >
                    {f.value}
                  </p>
                </div>
                <CopyButton value={f.value} label={f.label} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {answer.note ? (
        <p
          className="m-0 mt-4"
          style={{
            fontSize: 13.5,
            lineHeight: "20px",
            color: "var(--cp-g600)",
            textWrap: "pretty",
            maxWidth: 560,
          }}
        >
          {answer.note}
        </p>
      ) : null}
    </div>
  );
}
