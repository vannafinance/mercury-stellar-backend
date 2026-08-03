"use client";

/**
 * Renders a structured read answer.
 *
 * The model returns headline / facts / note / venue as data; layout, alignment and
 * precision are decided here. That is the point — every formatting rule the prompt used
 * to beg for (no markdown, two decimals on percentages, name the venue, bullets for
 * three or more figures) is now either impossible to violate or applied in one place.
 *
 * Figures sit in a two-column grid with tabular numerals so they line up down the
 * column, which is what makes a set of rates scannable rather than a paragraph to parse.
 */

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

export function AnswerView({ answer }: { answer: StructuredAnswer }) {
  const venue = answer.venue && answer.venue !== "none" ? answer.venue : null;
  const token = venue ? VENUE_TOKEN[venue] : null;

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

      {answer.facts.length > 0 ? (
        <dl
          className="mt-4 grid gap-x-8 gap-y-0"
          style={{ gridTemplateColumns: "minmax(0,1fr) auto", maxWidth: 520 }}
        >
          {answer.facts.map((f, i) => (
            <div
              key={`${f.label}-${i}`}
              className="col-span-2 grid items-baseline gap-x-8 py-2"
              style={{
                gridTemplateColumns: "minmax(0,1fr) auto",
                borderBottom:
                  i === answer.facts.length - 1 ? "none" : "1px solid var(--cp-g100)",
              }}
            >
              <dt
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: "var(--cp-g400)",
                }}
              >
                {f.label}
              </dt>
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
