"use client";

/**
 * Structured Guide answer — the reading surface from the Copilot design.
 *
 * The Guide's value is its shape: a summary you can stop after, sections that each
 * cover one thing, a formula set apart because formulas get re-read, a glossary of the
 * jargon it just used, and the questions that answer naturally raises. Flattened to a
 * paragraph (what `message` carries) all of that is lost, so this renders the fields of
 * `GuideAnswer` directly.
 *
 * Everything here comes from the model. Nothing is authored in this file — an answer
 * with no sections renders no sections rather than filling the space.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Crosshair } from "lucide-react";
import type { GuideAnswer, GuideTerm } from "@/lib/copilot/guide-schema";

const EYEBROW = "font-mono text-[10.5px] font-semibold uppercase tracking-[0.2em] text-vgray-400";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Underline the first mention of each glossary term, so the definition is one click
 * away at the moment the word is read rather than only at the bottom of the answer.
 * Only the first mention is linked — underlining every "collateral" in a long answer
 * turns the prose into a field of dotted lines.
 */
function useTermLinker(terms: GuideTerm[], onToggle: (key: string) => void) {
  const pattern = useMemo(() => {
    if (!terms.length) return null;
    const alts = terms
      .map((t) => t.term.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|");
    return alts ? new RegExp(`\\b(${alts})\\b`, "gi") : null;
  }, [terms]);

  return (text: string, seen: Set<string>): ReactNode => {
    if (!pattern) return text;
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      const key = m[0].toLowerCase();
      if (seen.has(key) || m.index === undefined) continue;
      seen.add(key);
      out.push(text.slice(last, m.index));
      out.push(
        <button
          key={`${key}-${m.index}`}
          type="button"
          onClick={() => onToggle(key)}
          title={`What is ${m[0]}?`}
          className="border-0 border-b border-dotted border-violet-400 bg-transparent p-0 text-vgray-600 transition-colors hover:text-violet-500"
          style={{ font: "inherit", cursor: "help" }}
        >
          {m[0]}
        </button>,
      );
      last = m.index + m[0].length;
    }
    if (!out.length) return text;
    out.push(text.slice(last));
    return out;
  };
}

export function GuideQuestion({ text }: { text: string }) {
  return (
    <div>
      <p className={EYEBROW}>Question</p>
      <h3 className="mt-2.5 text-[19px] font-semibold leading-7 text-vgray-900 text-pretty">
        {text}
      </h3>
    </div>
  );
}

/** Skeleton while the Guide is thinking — the answer's own shape, greyed. */
export function GuideSkeleton() {
  const bar = "rounded-md bg-[var(--cp-skel)]";
  return (
    <div aria-busy="true" aria-live="polite" style={{ animation: "cp-shimmer 1.5s ease-in-out infinite" }}>
      <div className={`h-3 w-[46%] ${bar}`} />
      <div className={`mt-[18px] h-[22px] w-[86%] ${bar}`} />
      <div className="mt-[22px] flex flex-col gap-2.5">
        <div className={`h-3.5 w-full ${bar}`} />
        <div className={`h-3.5 w-[96%] ${bar}`} />
        <div className={`h-3.5 w-[62%] ${bar}`} />
      </div>
      <div className={`mt-8 h-[15px] w-[40%] ${bar}`} />
      <div className="mt-4 flex flex-col gap-2.5">
        <div className={`h-3.5 w-full ${bar}`} />
        <div className={`h-3.5 w-[88%] ${bar}`} />
      </div>
      <div className="mt-[18px] h-[52px] w-full rounded-r3 bg-[var(--cp-skel)]" />
    </div>
  );
}

function Section({
  heading,
  body,
  formula,
  bullets,
}: {
  heading: string;
  body: ReactNode;
  formula?: string;
  bullets: ReactNode[];
}) {
  return (
    <section className="mt-[30px]">
      <h4 className="text-[15px] font-semibold leading-[23px] text-vgray-900">{heading}</h4>
      <p className="mt-2.5 text-[14.5px] leading-[26px] text-vgray-600 text-pretty">{body}</p>
      {formula && (
        <p
          role="figure"
          aria-label={`Formula: ${formula}`}
          className="mt-4 rounded-r3 border border-vgray-100 bg-vgray-50 px-4 py-[15px] font-mono text-[15px] leading-6 text-vgray-900"
        >
          <span className="mb-[7px] block text-[9.5px] uppercase tracking-[0.2em] text-violet-500">
            formula
          </span>
          {formula}
        </p>
      )}
      {bullets.length > 0 && (
        <ul className="mt-3.5 flex list-disc flex-col gap-2 pl-5">
          {bullets.map((b, i) => (
            <li key={i} className="text-[14.5px] leading-[26px] text-vgray-600">
              {b}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Terms({
  terms,
  open,
  onToggle,
}: {
  terms: GuideTerm[];
  open: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  return (
    <section className="mt-[30px]">
      <h4 className={`mb-2.5 ${EYEBROW}`}>Terms used here</h4>
      <dl className="m-0 border-t border-vgray-100">
        {terms.map((t) => {
          const key = t.term.toLowerCase();
          const isOpen = !!open[key];
          return (
            <div key={key} className="border-b border-vgray-100">
              <dt className="m-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => onToggle(key)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-0.5 py-[11px] text-left text-[14px] font-semibold text-vgray-800 transition-colors hover:text-violet-500"
                >
                  {t.term}
                  <span aria-hidden="true" className="font-mono text-[14px] text-vgray-400">
                    {isOpen ? "–" : "+"}
                  </span>
                </button>
              </dt>
              {isOpen && (
                <dd className="m-0 px-0.5 pb-[13px] text-[14px] leading-6 text-vgray-500">
                  {t.short}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export function GuideAnswerView({
  answer,
  onAsk,
  onShowRef,
  hasPageContext,
}: {
  answer: GuideAnswer;
  onAsk: (question: string) => void;
  /** Scrolls to and pulses the element the answer refers to. */
  onShowRef?: (ref: { label: string; elementId: string }) => void;
  /** False when the send captured no page — the honest "general answer" note. */
  hasPageContext: boolean;
}) {
  const ref = answer.pageRef ?? null;
  const [openTerms, setOpenTerms] = useState<Record<string, boolean>>({});
  const toggleTerm = (key: string) => setOpenTerms((s) => ({ ...s, [key]: !s[key] }));
  const linkify = useTermLinker(answer.terms, toggleTerm);

  // Linked in one pass over the whole answer, top to bottom, so "first mention" means
  // first on the page rather than first within whichever block React renders first.
  const seen = new Set<string>();
  const summary = linkify(answer.summary, seen);
  const sections = answer.sections.map((s) => ({
    heading: s.heading,
    formula: s.formula,
    body: linkify(s.body, seen),
    bullets: (s.bullets ?? []).map((b) => linkify(b, seen)),
  }));

  return (
    <article style={{ animation: "cp-in 260ms ease-out forwards" }}>
      {answer.unknown && (
        <p className="mb-3 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-[var(--cp-warn-fg)]">
          <span className="h-[5px] w-[5px] rounded-full bg-[var(--cp-warn-fg)]" />
          not confident
        </p>
      )}

      <p className="text-[16px] leading-7 text-vgray-700 text-pretty">{summary}</p>

      {sections.map((s, i) => (
        <Section key={i} {...s} />
      ))}

      {answer.terms.length > 0 && (
        <Terms terms={answer.terms} open={openTerms} onToggle={toggleTerm} />
      )}

      {ref && onShowRef && (
        <section className="mt-[26px]">
          <h4 className={`mb-2.5 ${EYEBROW}`}>On this page</h4>
          <button
            type="button"
            onClick={() => onShowRef(ref)}
            className="inline-flex cursor-pointer items-center gap-2.5 rounded-r2 border border-dashed border-violet-100 bg-violet-50 px-3.5 py-2.5 text-[13.5px] font-semibold text-violet-500 transition-[border-style] hover:border-solid"
          >
            <Crosshair size={14} aria-hidden="true" />
            Show me “{ref.label}”
          </button>
        </section>
      )}

      {!hasPageContext && (
        <p className="mt-[26px] rounded-r3 border border-vgray-100 bg-vgray-50 px-[15px] py-[13px] text-[13.5px] leading-[23px] text-vgray-500">
          I couldn&apos;t read a page for this one, so it&apos;s a general answer. Ask again from
          Portfolio or Margin and I can point at the exact tile.
        </p>
      )}

      {answer.followUps.length > 0 && (
        <section className="mt-[26px]">
          <h4 className={`mb-2.5 ${EYEBROW}`}>Keep going</h4>
          <div className="flex flex-wrap gap-[7px]">
            {answer.followUps.map((f, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAsk(f)}
                className="cursor-pointer rounded-r2 border border-vgray-100 bg-transparent px-[13px] py-2 text-[13.5px] text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-500"
              >
                {f}
              </button>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
