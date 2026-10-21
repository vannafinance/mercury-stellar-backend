"use client";

/**
 * Structured Guide answer - the reading surface for Vanna Assist.
 *
 * Renders the structured fields of `GuideAnswer` directly:
 * - Crisp lead summary
 * - Optional key-metric highlight cards from the current screen
 * - Structured sections with formula callouts, bullet lists, and numbered step badges
 * - Inline glossary of specialized DeFi/Vanna terms used
 * - Optional one-click handoff to Vanna Copilot when an on-chain action is requested
 * - Contextual follow-up question chips
 */

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { GuideAnswer, GuideHighlight } from "@/lib/copilot/guide-schema";

const SECTION_TITLE = "text-[14px] font-semibold leading-[20px] text-vgray-900";

export function GuideQuestion({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-r3 rounded-br-[8px] bg-vgray-50 px-3.5 py-2.5 text-[14px] leading-[22px] text-vgray-900 text-pretty">
        {text}
      </div>
    </div>
  );
}

/** Skeleton while the Guide is thinking - the answer's own shape, greyed. */
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

function HighlightGrid({ highlights }: { highlights: GuideHighlight[] }) {
  if (!highlights.length) return null;
  const toneClasses = (tone?: GuideHighlight["tone"]) => {
    if (tone === "good") return "border-emerald-500/25 bg-emerald-500/5 text-emerald-600";
    if (tone === "warn") return "border-amber-500/25 bg-amber-500/5 text-amber-600";
    if (tone === "bad") return "border-rose-500/25 bg-rose-500/5 text-rose-600";
    return "border-vgray-100 bg-vgray-50 text-vgray-900";
  };

  return (
    <div className="mt-4 grid grid-cols-2 gap-2">
      {highlights.map((h, i) => (
        <div
          key={i}
          className={`rounded-r3 border px-3 py-2.5 ${toneClasses(h.tone)}`}
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-vgray-500">
            {h.label}
          </p>
          <p className="mt-1 text-[13.5px] font-semibold leading-5">
            {h.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function Section({
  heading,
  body,
  formula,
  bullets,
  steps,
}: {
  heading: string;
  body: ReactNode;
  formula?: string;
  bullets: ReactNode[];
  steps: ReactNode[];
}) {
  return (
    <section className="mt-5 rounded-r3 border border-vgray-100/80 bg-vgray-50/40 px-3.5 py-3">
      <h4 className="text-[14px] font-semibold leading-[20px] text-vgray-900">{heading}</h4>
      <p className="mt-1.5 text-[13.5px] leading-[22px] text-vgray-600 text-pretty">{body}</p>
      {formula && (
        <div
          role="figure"
          aria-label={`Formula: ${formula}`}
          className="mt-3 rounded-r2 border border-violet-400/25 bg-violet-50/60 px-3.5 py-2.5"
        >
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-violet-500">
            Formula
          </p>
          <p className="mt-1 font-mono text-[13px] font-semibold leading-5 text-vgray-900">
            {formula}
          </p>
        </div>
      )}
      {bullets.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-[13.5px] leading-[21px] text-vgray-600">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" aria-hidden />
              <span className="min-w-0 flex-1">{b}</span>
            </li>
          ))}
        </ul>
      )}
      {steps.length > 0 && (
        <ol className="mt-3 flex flex-col gap-2">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[13.5px] leading-[21px] text-vgray-700">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-50 text-[11px] font-semibold text-violet-500">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function CopilotHandoffButton({
  prompt,
  onOpenInCopilot,
}: {
  prompt: string;
  onOpenInCopilot?: (prompt: string) => void;
}) {
  if (!onOpenInCopilot) return null;
  return (
    <div className="mt-4 rounded-r3 border border-violet-400/30 bg-violet-50/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-500">
            Ready to execute?
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-vgray-700">
            “{prompt}”
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenInCopilot(prompt)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-r2 bg-gradient px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          Open in Copilot
          <ArrowUpRight size={13} />
        </button>
      </div>
    </div>
  );
}

export function GuideAnswerView({
  answer,
  onAsk,
  hasPageContext,
  onOpenInCopilot,
}: {
  answer: GuideAnswer;
  onAsk: (question: string) => void;
  hasPageContext: boolean;
  onOpenInCopilot?: (prompt: string) => void;
}) {
  return (
    <article style={{ animation: "cp-in 260ms ease-out forwards" }}>
      {answer.unknown && (
        <span className="mb-2.5 inline-block rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-[var(--cp-warn-fg)]">
          Outside Vanna scope / Not confident
        </span>
      )}

      <p className="text-[14.5px] font-medium leading-[23px] text-vgray-800 text-pretty">
        {answer.summary}
      </p>

      {answer.highlights && answer.highlights.length > 0 && (
        <HighlightGrid highlights={answer.highlights} />
      )}

      {answer.sections.map((s, i) => (
        <Section
          key={i}
          heading={s.heading}
          body={s.body}
          formula={s.formula}
          bullets={s.bullets ?? []}
          steps={s.steps ?? []}
        />
      ))}

      {answer.terms && answer.terms.length > 0 && (
        <section className="mt-5">
          <h4 className={`mb-2 ${SECTION_TITLE}`}>Key terms</h4>
          <div className="flex flex-col gap-1.5">
            {answer.terms.map((t, i) => (
              <div
                key={i}
                className="rounded-r2 border border-vgray-100 bg-vgray-50/70 px-3 py-2 text-[12.5px] leading-[19px]"
              >
                <span className="font-semibold text-vgray-900">{t.term}</span>
                <span className="mx-1.5 text-vgray-400">·</span>
                <span className="text-vgray-600">{t.short}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {answer.copilotHandoffPrompt && (
        <CopilotHandoffButton
          prompt={answer.copilotHandoffPrompt}
          onOpenInCopilot={onOpenInCopilot}
        />
      )}

      {!hasPageContext && (
        <p className="mt-4 rounded-r3 border border-vgray-100 bg-vgray-50 px-3.5 py-2.5 text-[12.5px] leading-[20px] text-vgray-500">
          I couldn&apos;t read a page for this one, so it&apos;s a general answer. Ask again from
          Portfolio or Margin if you want it tied to what you see.
        </p>
      )}

      {answer.followUps.length > 0 && (
        <section className="mt-5">
          <h4 className={`mb-2 ${SECTION_TITLE}`}>Explore next</h4>
          <div className="flex flex-wrap items-start gap-1.5">
            {answer.followUps.map((f, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAsk(f)}
                className="cursor-pointer rounded-full border border-vgray-100 bg-vgray-50 px-3 py-1.5 text-left text-[12.5px] font-medium text-vgray-800 transition-colors hover:border-violet-400/40 hover:bg-violet-50 hover:text-violet-500"
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
