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

import type { ReactNode } from "react";
import type { GuideAnswer } from "@/lib/copilot/guide-schema";

const SECTION_TITLE = "text-[15px] font-semibold leading-[23px] text-vgray-900";

export function GuideQuestion({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-r3 rounded-br-[8px] bg-vgray-50 px-3.5 py-2.5 text-[14px] leading-[22px] text-vgray-900 text-pretty">
        {text}
      </div>
    </div>
  );
}

/** Skeleton while the Guide is thinking — the answer's own shape, greyed. */
export function GuideSkeleton({ status }: { status?: string }) {
  const bar = "rounded-md bg-[var(--cp-skel)]";
  return (
    <div aria-busy="true" aria-live="polite" style={{ animation: "cp-shimmer 1.5s ease-in-out infinite" }}>
      {status ? (
        <p className="mb-4 text-[13px] font-medium text-violet-500">{status}</p>
      ) : null}
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
        <div
          role="figure"
          aria-label={`Formula: ${formula}`}
          className="mt-4 rounded-r3 border border-vgray-100 bg-vgray-50 px-4 py-3.5"
        >
          <p className="text-[11px] font-medium text-vgray-500">Formula</p>
          <p className="mt-1.5 text-[15px] font-semibold leading-6 text-vgray-900">{formula}</p>
        </div>
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

export function GuideAnswerView({
  answer,
  onAsk,
  hasPageContext,
}: {
  answer: GuideAnswer;
  onAsk: (question: string) => void;
  hasPageContext: boolean;
}) {
  return (
    <article style={{ animation: "cp-in 260ms ease-out forwards" }}>
      {answer.unknown && (
        <p className="mb-3 text-[12px] font-semibold text-[var(--cp-warn-fg)]">Not confident</p>
      )}

      <p className="text-[15px] leading-7 text-vgray-700 text-pretty">{answer.summary}</p>

      {answer.sections.map((s, i) => (
        <Section
          key={i}
          heading={s.heading}
          body={s.body}
          formula={s.formula}
          bullets={s.bullets ?? []}
        />
      ))}

      {!hasPageContext && (
        <p className="mt-[26px] rounded-r3 border border-vgray-100 bg-vgray-50 px-[15px] py-[13px] text-[13.5px] leading-[23px] text-vgray-500">
          I couldn&apos;t read a page for this one, so it&apos;s a general answer. Ask again from
          Portfolio or Margin if you want it tied to what you see.
        </p>
      )}

      {answer.followUps.length > 0 && (
        <section className="mt-[26px]">
          <h4 className={`mb-2.5 ${SECTION_TITLE}`}>Keep going</h4>
          <div className="flex flex-col items-start gap-2">
            {answer.followUps.map((f, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAsk(f)}
                className="cursor-pointer rounded-full bg-vgray-50 px-3.5 py-2 text-left text-[13.5px] text-vgray-800 transition-colors hover:bg-violet-50 hover:text-violet-500"
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
