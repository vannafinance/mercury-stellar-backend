"use client";

/**
 * Plan approval card — the checkpoint between a multi-leg plan and the first signature.
 *
 * Ported from the Claude Design `Copilot.dc.html` "03 · Approve plan" section. The
 * design's own state machine and mock data are dropped; this renders the real
 * `plan_preview` payload from /api/copilot and posts it back as `approved_plan`.
 *
 * Two properties the design encodes that matter more than the styling:
 *
 *   - The venue badge per step. Earn / margin / farm are different products, and
 *     confusing them is the most expensive mistake available here, so each step says
 *     which one it touches before the user commits.
 *   - The quote-validity clock. Plans are built on live prices and health, and the
 *     server refuses one older than five minutes. Showing the countdown means expiry
 *     is visible rather than arriving as a rejection after pressing Approve.
 *
 * A missing amount renders as "amount to be confirmed", never blank or 0 — the server
 * will ask for it mid-execution, after earlier legs have already settled.
 */

import { useEffect, useMemo, useState } from "react";

/** Mirrors PLAN_TTL_MS in lib/copilot/plan-approval.ts. */
const PLAN_TTL_MS = 5 * 60_000;

export type PlanVenue = "earn" | "margin" | "farm" | "wallet" | "other";

export interface PlanStepView {
  n: number;
  op: string;
  asset: string | null;
  amount: number | null;
  leverage: number | null;
  label: string;
  venue: PlanVenue;
}

export interface PlanPreview {
  plan_id: string;
  summary: string;
  created_at: number;
  /** On-chain legs the user will sign; exceeds steps.length when a step is levered. */
  signature_count: number;
  warnings: string[];
  steps: PlanStepView[];
}

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Venue tokens are defined on .cp-root so they follow the app's light/dark toggle. */
function venueTokens(venue: PlanVenue) {
  const key = venue === "other" ? "wallet" : venue;
  return {
    fg: `var(--cp-venue-${key}-fg)`,
    bg: `var(--cp-venue-${key}-bg)`,
    bd: `var(--cp-venue-${key}-bd)`,
  };
}

function formatAmount(amount: number | null): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  return amount.toLocaleString(undefined, { maximumFractionDigits: 7 });
}

export interface PlanApprovalCardProps {
  plan: PlanPreview;
  /** Post the plan back as approved_plan. */
  onApprove: (plan: PlanPreview) => void;
  /** Put the original prompt back in the composer for editing. */
  onModify: () => void;
  onCancel: () => void;
  /** True while the approved plan is executing. */
  busy?: boolean;
  /** Auto-approve is on and will submit this without a click. */
  autoPending?: boolean;
}

export function PlanApprovalCard({
  plan,
  onApprove,
  onModify,
  onCancel,
  busy = false,
  autoPending = false,
}: PlanApprovalCardProps) {
  // Tick once a second so the validity clock counts down live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const msLeft = Math.max(0, plan.created_at + PLAN_TTL_MS - now);
  const expired = msLeft <= 0;
  const urgent = !expired && msLeft < 60_000;
  const clock = expired
    ? "--:--"
    : `${String(Math.floor(msLeft / 60_000)).padStart(2, "0")}:${String(
        Math.floor((msLeft % 60_000) / 1000),
      ).padStart(2, "0")}`;

  const meta = useMemo(() => {
    const stepCount = plan.steps.length;
    // Signatures are legs, not steps: a levered farm expands to deposit → borrow →
    // supply, so a 2-step plan can be 4 signatures.
    const sigs = plan.signature_count || stepCount;
    const venues: string[] = [];
    for (const s of plan.steps) if (!venues.includes(s.venue)) venues.push(s.venue);
    const stepPart = stepCount === 1 ? "1 step" : `${stepCount} steps`;
    const sigPart = sigs === 1 ? "1 signature" : `${sigs} signatures`;
    return `${stepPart} · ${sigPart} · ${venues.join(" → ")}`;
  }, [plan.steps, plan.signature_count]);

  const approveDisabled = expired || busy || plan.steps.length === 0;
  const approveLabel = busy
    ? "Running…"
    : expired
      ? "Plan expired"
      : autoPending
        ? "Auto-approving…"
        : "Approve & run";

  return (
    <div className="mt-7" style={{ animation: "copilot-in 300ms ease-out forwards" }}>
      {/* header: stage label, validity clock */}
      <div className="flex items-center justify-between gap-4">
        <p
          className="m-0 uppercase"
          style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".25em", color: "var(--cp-g400)" }}
        >
          <span style={{ color: "var(--cp-violet-500)" }}>03</span> · Approve plan
        </p>
        <span
          aria-live="polite"
          className="flex items-center gap-2 rounded-full"
          style={{
            border: "1px solid var(--cp-g100)",
            padding: "5px 12px",
            fontFamily: MONO,
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            color: expired
              ? "var(--cp-danger-fg)"
              : urgent
                ? "var(--cp-warn-fg)"
                : "var(--cp-g900)",
          }}
        >
          {clock}
          <span
            className="uppercase"
            style={{ fontSize: 10, letterSpacing: ".15em", color: "var(--cp-g400)" }}
          >
            {expired ? "expired" : "quote valid"}
          </span>
        </span>
      </div>

      <p
        className="m-0 mt-3.5 font-semibold"
        style={{ fontSize: 24, lineHeight: "32px", color: "var(--cp-g900)", maxWidth: 520 }}
      >
        {plan.summary}
      </p>

      {/* execution plan */}
      <div
        className="mt-4 rounded-2xl"
        style={{
          border: "1px solid var(--cp-g100)",
          background: "var(--cp-surface)",
          padding: "18px 20px 6px",
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <p
            className="m-0 uppercase"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: ".2em",
              color: "var(--cp-violet-500)",
            }}
          >
            execution plan
          </p>
          <p className="m-0" style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--cp-g400)" }}>
            {meta}
          </p>
        </div>

        <div className="mt-1.5">
          {plan.steps.map((s, i) => {
            const v = venueTokens(s.venue);
            const last = i === plan.steps.length - 1;
            const amount = formatAmount(s.amount);
            return (
              <div key={`${s.n}-${s.op}`} className="flex items-stretch gap-3.5">
                {/* rail: number + connector */}
                <div className="flex w-6 flex-shrink-0 flex-col items-center pt-3.5">
                  <span
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-bold"
                    style={{
                      background: "var(--cp-violet-soft)",
                      color: "var(--cp-violet-500)",
                      fontFamily: MONO,
                      fontSize: 11,
                    }}
                  >
                    {s.n}
                  </span>
                  <span
                    className="mt-1.5 w-px flex-1"
                    style={{ background: last ? "transparent" : "var(--cp-g100)" }}
                  />
                </div>

                <div
                  className="flex min-w-0 flex-1 items-start justify-between gap-4"
                  style={{
                    padding: "13px 0",
                    borderBottom: `1px solid ${last ? "transparent" : "var(--cp-g100)"}`,
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full font-bold uppercase"
                        style={{
                          border: `1px solid ${v.bd}`,
                          background: v.bg,
                          color: v.fg,
                          padding: "3px 10px 3px 8px",
                          fontFamily: MONO,
                          fontSize: 9.5,
                          letterSpacing: ".16em",
                        }}
                      >
                        <span
                          className="h-[5px] w-[5px] rounded-full"
                          style={{ background: v.fg }}
                          aria-hidden="true"
                        />
                        {s.venue}
                      </span>
                      <span
                        className="uppercase"
                        style={{
                          fontFamily: MONO,
                          fontSize: 9.5,
                          letterSpacing: ".14em",
                          color: "var(--cp-g400)",
                        }}
                      >
                        {s.op.replace(/_/g, " ")}
                      </span>
                    </div>
                    <p
                      className="m-0 mt-[7px]"
                      style={{
                        fontSize: 14,
                        lineHeight: "21px",
                        color: "var(--cp-g700)",
                        textWrap: "pretty",
                      }}
                    >
                      {s.label}
                    </p>
                  </div>

                  <div className="flex-shrink-0 text-right">
                    {amount ? (
                      <p
                        className="m-0"
                        style={{
                          fontFamily: MONO,
                          fontSize: 19,
                          lineHeight: "24px",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--cp-g900)",
                        }}
                      >
                        {amount}
                      </p>
                    ) : (
                      <p
                        className="m-0"
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          lineHeight: "24px",
                          color: "var(--cp-warn-fg)",
                          maxWidth: 116,
                        }}
                      >
                        amount to be confirmed
                      </p>
                    )}
                    {s.asset ? (
                      <p
                        className="m-0 mt-0.5"
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          letterSpacing: ".14em",
                          color: "var(--cp-g400)",
                        }}
                      >
                        {s.asset}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Warnings — never dismissable, always above the buttons.
          One tinted block holding compact rows rather than a stack of full-size cards:
          three boxed panels each the height of a paragraph dominated the card and pushed
          Approve below the fold, which made the plan itself the smaller element. */}
      {plan.warnings.length > 0 || expired ? (
        <div
          className="mt-4 flex flex-col gap-1.5 rounded-xl"
          style={{
            border: `1px solid ${expired ? "var(--cp-danger-fg)" : "var(--cp-warn-bd)"}`,
            background: expired ? "rgba(201,51,59,.07)" : "var(--cp-warn-bg)",
            padding: "10px 13px",
          }}
        >
          {expired ? (
            <p
              role="alert"
              className="m-0 flex gap-2"
              style={{ fontSize: 12.5, lineHeight: "18px", color: "var(--cp-danger-fg)" }}
            >
              <span aria-hidden="true" style={{ fontFamily: MONO, fontWeight: 700 }}>
                !
              </span>
              Plan expired — prices and your health factor have moved. Ask again for a fresh one.
            </p>
          ) : null}
          {plan.warnings.map((text) => (
            <p
              key={text}
              role="note"
              className="m-0 flex gap-2"
              style={{
                fontSize: 12.5,
                lineHeight: "18px",
                color: expired ? "var(--cp-g500)" : "var(--cp-warn-fg)",
                textWrap: "pretty",
              }}
            >
              <span aria-hidden="true" style={{ fontFamily: MONO, fontWeight: 700 }}>
                !
              </span>
              {text}
            </p>
          ))}
        </div>
      ) : null}

      {autoPending && !expired ? (
        <p
          className="m-0 mt-4 flex items-center gap-[7px]"
          style={{ fontFamily: MONO, fontSize: 11, color: "var(--cp-violet-500)" }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          auto-approve on — signing and submitting for you, no click needed
        </p>
      ) : null}

      {/* actions */}
      <div className="mt-5 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => onApprove(plan)}
          disabled={approveDisabled}
          className="flex-1 rounded-full font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px]"
          style={{
            border: 0,
            padding: "15px 24px",
            fontSize: 15,
            cursor: approveDisabled ? "not-allowed" : busy ? "progress" : "pointer",
            background: approveDisabled ? "var(--cp-g100)" : "var(--cp-gradient)",
            color: approveDisabled ? "var(--cp-g400)" : "#ffffff",
            boxShadow: approveDisabled ? "none" : "0 12px 30px -10px rgba(112,58,230,.6)",
            outlineColor: "var(--cp-violet-500)",
          }}
        >
          {approveLabel}
        </button>
        <button
          type="button"
          onClick={onModify}
          className="rounded-full font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px]"
          style={{
            border: "1px solid var(--cp-g200)",
            background: "transparent",
            padding: "14px 22px",
            fontSize: 14,
            color: "var(--cp-g600)",
            cursor: "pointer",
            outlineColor: "var(--cp-violet-500)",
          }}
        >
          Modify
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px]"
          style={{
            border: 0,
            background: "transparent",
            padding: "14px 16px",
            fontSize: 14,
            color: "var(--cp-g400)",
            cursor: "pointer",
            outlineColor: "var(--cp-violet-500)",
          }}
        >
          Cancel
        </button>
      </div>

      {/* plan_id — the proof that what executes is what was shown */}
      <p
        className="m-0 mt-3 text-right"
        title={`plan_id ${plan.plan_id}`}
        style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".06em", color: "var(--cp-g500)" }}
      >
        plan {plan.plan_id.slice(0, 6)}…{plan.plan_id.slice(-3)}
      </p>
    </div>
  );
}
