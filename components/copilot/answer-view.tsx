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
      // The `ok` status ink, not the earn venue's. They are the same green family, but a
      // venue answers "which product" and a tone answers "is this good" — reusing the
      // venue token here made colour mean two things on one card.
      return "var(--cp-ok-fg)";
    case "warn":
      return "var(--cp-warn-fg)";
    case "bad":
      return "var(--cp-danger-fg)";
    default:
      return "var(--cp-g900)";
  }
}

/**
 * Tone, carried by SHAPE as well as colour.
 *
 * A tinted figure is invisible as a tone to anyone who cannot separate the hues, and this
 * card reports health factors and debt — the two numbers where "is this bad" is the whole
 * question. The glyph is `aria-hidden` and paired with a real word for screen readers, so
 * the meaning arrives three ways: shape, colour and text.
 */
const TONE_MARK: Record<NonNullable<AnswerFact["tone"]>, { glyph: string; say: string } | null> = {
  neutral: null,
  good: { glyph: "▲", say: "good" },
  warn: { glyph: "▪", say: "warning" },
  bad: { glyph: "▼", say: "bad" },
};

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

  // A worded button, per the design, not an icon: at 10.5px mono beside a 56-character
  // address, "Copy" reads instantly and its "Copied" state is legible without colour. The
  // aria-label still carries which row it belongs to, which an icon could not.
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      className="shrink-0 cursor-pointer rounded-[4px] transition-colors"
      style={{
        border: "1px solid var(--cp-g100)",
        background: "var(--cp-g50)",
        padding: "4px 10px",
        fontFamily: MONO,
        fontSize: 10.5,
        fontWeight: 600,
        color: done ? "var(--cp-ok-fg)" : "var(--cp-g600)",
      }}
    >
      {done ? "Copied" : "Copy"}
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
  const figures = facts.filter((f) => !isIdentifier(f.value) && f.group !== "lp" && f.group !== "earn");
  const lpFacts = facts.filter((f) => !isIdentifier(f.value) && f.group === "lp");
  const earnFacts = facts.filter((f) => !isIdentifier(f.value) && f.group === "earn");
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
        }}
      >
        {answer.headline}
      </p>

      {/*
        Figures — the design's two-column pair grid inside one hairline panel, so a set of
        numbers aligns down a column and the whole set reads as one object rather than as a
        run of loose rows.
      */}
      {figures.length > 0 ? (
        <dl
          className="mt-[18px] grid"
          style={{
            /**
             * One long label forces EVERY row to single-column, not just its own.
             *
             * A per-row override used to decide this alone: "collateral left before
             * liquidation" (>22 chars) went full-width while "amount borrowed" (under the
             * threshold) stayed half-width in the same two-fact answer — the short row's
             * value then landed at the grid's midpoint while the long row's value reached
             * the far right edge, so the two rows visibly did not line up. A pair grid only
             * reads as one object when every row shares the same width.
             */
            /**
             * Pair columns only when every label AND value fits a half-row.
             * Farm Deposit TVL: "13.9801 XLM + 0.1945 AQUSDC ($2.73) · 1.6416 LP"
             * in a 620px two-col cell wrapped "LP" onto its own line. A long
             * value (or label) forces the whole panel to one column, full width.
             */
            gridTemplateColumns:
              figures.length > 1 &&
              !figures.some((f) => f.label.length > 22 || f.value.length > 36)
                ? "1fr 1fr"
                : "1fr",
            gap: "2px 32px",
            borderRadius: 8,
            border: "1px solid var(--cp-g100)",
            background: "var(--cp-g50)",
            padding: "16px 18px",
            width: "100%",
          }}
        >
          {figures.map((f, i) => (
            <div
              key={`${f.label}-${i}`}
              className="flex min-w-0 items-baseline justify-between gap-3"
              style={{
                borderBottom: "1px solid var(--cp-g100)",
                padding: "7px 0",
              }}
            >
              <dt style={{ ...labelStyle, whiteSpace: "nowrap" }}>{f.label}</dt>
              <dd
                className="m-0 flex min-w-0 items-baseline justify-end gap-1.5 text-right"
                style={{
                  fontFamily: MONO,
                  fontSize: 13,
                  fontVariantNumeric: "tabular-nums",
                  color: toneColor(f.tone),
                  whiteSpace: "nowrap",
                }}
                title={f.value}
              >
                {f.tone && TONE_MARK[f.tone] ? (
                  <>
                    <span aria-hidden="true" style={{ fontSize: 9, lineHeight: 1 }}>
                      {TONE_MARK[f.tone]!.glyph}
                    </span>
                    <span className="sr-only">{TONE_MARK[f.tone]!.say}:</span>
                  </>
                ) : null}
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
        LP / farm positions — their own box, one step down in visual weight from the plain
        figures grid above. These are collateral held THROUGH a venue (a Blend supply, an
        Aquarius LP share) rather than plain margin collateral, and listing them in the same
        grid as XLM/BLUSDC read as duplicate or confusing entries.
      */}
      {lpFacts.length > 0 ? (
        <div>
          <p
            className="m-0 mt-[18px] mb-2"
            style={{ ...labelStyle, color: "var(--cp-g400)" }}
          >
            LP / farm positions
          </p>
          <dl
            className="m-0 grid"
            style={{
              gridTemplateColumns: "1fr",
              gap: "2px",
              borderRadius: 8,
              border: "1px solid var(--cp-g100)",
              background: "var(--cp-g50)",
              padding: "10px 18px",
            }}
          >
            {lpFacts.map((f, i) => (
              <div
                key={`${f.label}-${i}`}
                className="flex min-w-0 items-baseline justify-between gap-3"
                style={{
                  borderBottom: i === lpFacts.length - 1 ? "none" : "1px solid var(--cp-g100)",
                  padding: "7px 0",
                }}
              >
                <dt style={{ ...labelStyle, textTransform: "none", letterSpacing: 0 }}>
                  {f.label}
                </dt>
                <dd
                  className="m-0 text-right"
                  style={{
                    fontFamily: MONO,
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--cp-g900)",
                  }}
                >
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {/*
        Earn positions — same box treatment as LP/farm, its own section: vToken supply is
        a genuinely different pool from margin collateral or a farm-venue LP share, and a
        token can be held in more than one of these three at once.
      */}
      {earnFacts.length > 0 ? (
        <div>
          <p
            className="m-0 mt-[18px] mb-2"
            style={{ ...labelStyle, color: "var(--cp-g400)" }}
          >
            Earn positions
          </p>
          <dl
            className="m-0 grid"
            style={{
              gridTemplateColumns: "1fr",
              gap: "2px",
              borderRadius: 8,
              border: "1px solid var(--cp-g100)",
              background: "var(--cp-g50)",
              padding: "10px 18px",
            }}
          >
            {earnFacts.map((f, i) => (
              <div
                key={`${f.label}-${i}`}
                className="flex min-w-0 items-baseline justify-between gap-3"
                style={{
                  borderBottom: i === earnFacts.length - 1 ? "none" : "1px solid var(--cp-g100)",
                  padding: "7px 0",
                }}
              >
                <dt style={{ ...labelStyle, textTransform: "none", letterSpacing: 0 }}>
                  {f.label}
                </dt>
                <dd
                  className="m-0 text-right"
                  style={{
                    fontFamily: MONO,
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--cp-g900)",
                  }}
                >
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {/*
        Identifiers — the design's scrolling register, not a stack of cards.

        Sixteen addresses is the payload this card was drawn for, and the design's answer to
        "sixteen identical rows" is density plus alignment rather than grouping: every label
        sits in a fixed 172px column so the addresses all start at the same x and the eye can
        run straight down them, and the list caps at 340px so a long set scrolls inside the
        card instead of pushing the rest of the turn off screen.

        The label truncates with an ellipsis and keeps its full text in `title`. That is
        deliberately NOT the old "1fr auto" grid that shattered "REGISTRY" into "REG / IST /
        RY" — `nowrap` makes shattering impossible, while the value keeps `break-all` so a
        56-character address wraps inside its own cell and never widens the row.
      */}
      {identifiers.length > 0 ? (
        <div>
          <div
            className="mt-[18px] overflow-y-auto"
            style={{ border: "1px solid var(--cp-g100)", borderRadius: 8, maxHeight: 340 }}
          >
            {identifiers.map((f, i) => (
              <div
                key={`${f.label}-${i}`}
                className="flex items-center gap-3.5"
                style={{
                  padding: "11px 16px",
                  borderBottom:
                    i === identifiers.length - 1 ? "none" : "1px solid var(--cp-g100)",
                }}
              >
                <span
                  title={f.label}
                  className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
                  style={{
                    width: 172,
                    fontFamily: MONO,
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: ".05em",
                    textTransform: "uppercase",
                    color: "var(--cp-g400)",
                  }}
                >
                  {f.label}
                </span>
                <span
                  className="min-w-0 flex-1 select-all"
                  style={{
                    fontFamily: MONO,
                    fontSize: 12.5,
                    color: "var(--cp-g900)",
                    wordBreak: "break-all",
                  }}
                >
                  {f.value}
                </span>
                <CopyButton value={f.value} label={f.label} />
              </div>
            ))}
          </div>
          <p
            className="m-0 mt-2"
            style={{ fontFamily: MONO, fontSize: 11, color: "var(--cp-g400)" }}
          >
            {identifiers.length} contracts · full addresses, always copyable
          </p>
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
