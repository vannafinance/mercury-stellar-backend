"use client";

/**
 * Plan approval card — the checkpoint between a multi-leg plan and the first signature.
 *
 * Ported from the Claude Design `Plan Approval Card.dc.html`. The design's mock data and
 * its own state machine are dropped; this renders the real `plan_preview` payload from
 * /api/copilot and posts it back as `approved_plan`.
 *
 * The card owns its colours through `--pc-*` (see the `.plan-card` block in
 * app/globals.css) rather than the shared `--cp-*` scale. It is the gate in front of
 * transactions that move real money, so it has to be the most legible element on screen
 * in both themes, and it must not be able to lose a colour because a token was declared
 * in one theme block and not the other. Three specific failures this shape prevents:
 *
 *   - No entry animation. An earlier version animated `copilot-in`, a keyframe that only
 *     exists in the design file — a missing keyframe with `forwards` still applies, so the
 *     card sat in an unresolved state and rendered washed out.
 *   - No `opacity`, anywhere. Disabled and busy states change colour instead.
 *   - Busy never repaints the primary button grey. Only an expired or empty plan does,
 *     and it swaps to a solid violet-slate fill with white text, not a surface grey —
 *     grey-on-grey reads as "broken" rather than "not yet".
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
  /**
   * A "read" leg reports a number and is not signed — "…then tell me my health factor".
   * Rendered without an amount block and without an asset, because it has neither, and
   * excluded from the signature count upstream.
   */
  kind?: "write" | "read";
  tool?: string | null;
  op: string;
  asset: string | null;
  amount: number | null;
  /** A share of a live balance ("50%"), when the size was stated that way. */
  fraction?: number | null;
  leverage: number | null;
  /**
   * The loan asset when it differs from the collateral.
   *
   * Carried through the card purely so `approvePlan` can echo it back: it is part of
   * the approved content AND part of the plan fingerprint, so an approval that omits it
   * both replays the wrong trade and fails the hash. The label already renders it.
   */
  borrow_asset?: string | null;
  /**
   * Every executable slot for this step, opaque to the card.
   *
   * The card renders the label; this exists so `approvePlan` can echo the whole record
   * back unread. Echoing a hand-picked subset is what dropped `leverage`, then
   * `borrow_asset`, then `token_out` — the client should not be deciding which parts of
   * an approved trade matter.
   */
  slots?: Record<string, string | number | boolean | null>;
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
  /**
   * A stated HF floor etc., read once when the plan was built. Opaque here — this card
   * only has to carry it back verbatim on approve, not act on it.
   */
  constraints?: { minHf?: number | null } | null;
  lp_input?: {
    sides: [string, string];
    other_per_xlm: number | null;
  } | null;
}

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function venueTokens(venue: PlanVenue) {
  const key = venue === "other" ? "wallet" : venue;
  return {
    fg: `var(--pc-${key}-fg)`,
    bg: `var(--pc-${key}-bg)`,
    bd: `var(--pc-${key}-bd)`,
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
  /** Session signing state used only to explain expected wallet prompts. */
  sessionSigning?: boolean;
}

export function planExecutionSummary(
  plan: {
    steps: ReadonlyArray<{ kind?: "write" | "read" }>;
    signature_count: number;
  },
  sessionSigning = false,
): {
  stepCount: number;
  writeCount: number;
  readCount: number;
  signatureCount: number;
  autoSignEligible: number;
  manualPrompts: number;
} {
  const writeCount = plan.steps.filter((s) => s.kind !== "read").length;
  const readCount = plan.steps.filter((s) => s.kind === "read").length;
  const signatureCount = plan.signature_count || writeCount;
  return {
    stepCount: plan.steps.length,
    writeCount,
    readCount,
    signatureCount,
    autoSignEligible: sessionSigning ? signatureCount : 0,
    manualPrompts: sessionSigning ? 0 : signatureCount,
  };
}

export function PlanApprovalCard({
  plan,
  onApprove,
  onModify,
  onCancel,
  busy = false,
  autoPending = false,
  sessionSigning = false,
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
  const clock = `${String(Math.floor(msLeft / 60_000)).padStart(2, "0")}:${String(
    Math.floor((msLeft % 60_000) / 1000),
  ).padStart(2, "0")}`;

  const meta = useMemo(() => {
    const stepCount = plan.steps.length;
    // Signatures are legs, not steps: a levered farm expands to deposit → borrow →
    // supply, so a 2-step plan can be 4 signatures.
    const sigs = plan.signature_count || stepCount;
    // Venues describe where funds GO. A read leg has no venue, and including its "other"
    // placeholder rendered the chain as "earn → other", which reads like a third product.
    const venues: string[] = [];
    for (const s of plan.steps)
      if (s.kind !== "read" && !venues.includes(s.venue)) venues.push(s.venue);
    return {
      stepsText: stepCount === 1 ? "1 step" : `${stepCount} steps`,
      sigText: sigs === 1 ? "1 signature" : `${sigs} signatures`,
      sigNote: sigs > stepCount ? " (a levered step signs more than once)" : "",
      levered: sigs > stepCount,
      venueText: venues.join(" → "),
    };
  }, [plan.steps, plan.signature_count]);

  const execution = useMemo(
    () => planExecutionSummary(plan, sessionSigning),
    [plan, sessionSigning],
  );

  // Styling is driven by `unusable`, never by `busy`. A running plan keeps its full
  // gradient and says "Running…" — greying it out while the quote is still valid is what
  // made the button look unavailable.
  const unusable = expired || plan.steps.length === 0;
  const approveBlocked = unusable || busy || autoPending;
  const approveLabel = expired
    ? "Plan expired"
    : busy
      ? "Running…"
      : autoPending
        ? "Auto-approving…"
        : "Approve & run";

  const clockColor = expired
    ? "var(--pc-danger-fg)"
    : urgent
      ? "var(--pc-warn-fg)"
      : "var(--pc-heading)";
  const clockLabelColor = expired
    ? "var(--pc-danger-fg)"
    : urgent
      ? "var(--pc-warn-fg)"
      : "var(--pc-muted)";

  const showNotices = expired || plan.warnings.length > 0;

  return (
    <div
      className="plan-card mt-7"
      role="group"
      aria-label="Plan approval"
      style={{
        border: "1px solid var(--pc-line)",
        borderRadius: 14,
        background: "var(--pc-surface)",
        padding: "20px 22px 18px",
      }}
    >
      {/* header: stage label, validity clock */}
      <div className="flex items-center justify-between gap-5">
        <p
          className="m-0 uppercase"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: ".2em",
            color: "var(--pc-muted)",
          }}
        >
          <span style={{ color: "var(--pc-accent)" }}>03</span> · approve plan
        </p>
        <p
          aria-live="polite"
          className="m-0 flex items-baseline gap-2"
          style={{
            fontFamily: MONO,
            fontVariantNumeric: "tabular-nums",
            color: clockColor,
          }}
        >
          <span
            style={{ fontSize: 17, fontWeight: 700, letterSpacing: ".02em" }}
          >
            {clock}
          </span>
          <span
            className="uppercase"
            style={{
              fontSize: 10,
              letterSpacing: ".18em",
              color: clockLabelColor,
            }}
          >
            {expired ? "expired" : "quote valid"}
          </span>
        </p>
      </div>

      <h2
        className="m-0 mt-3.5 font-semibold"
        style={{
          fontSize: 20,
          lineHeight: "29px",
          color: "var(--pc-heading)",
          textWrap: "pretty",
        }}
      >
        {plan.summary}
      </h2>

      {/* execution plan */}
      <div
        className="mt-4"
        style={{
          border: "1px solid var(--pc-line-soft)",
          borderRadius: 12,
          background: "var(--pc-inset)",
          padding: "4px 16px",
        }}
      >
        {plan.steps.map((s, i) => {
          const v = venueTokens(s.venue);
          const last = i === plan.steps.length - 1;
          const amount = formatAmount(s.amount);
          return (
            <div key={`${s.n}-${s.op}`} className="flex items-stretch gap-3.5">
              {/* rail: number + connector */}
              <div className="flex w-[26px] flex-shrink-0 flex-col items-center pt-[15px]">
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 17,
                    lineHeight: "20px",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--pc-accent)",
                  }}
                >
                  {s.n}
                </span>
                <span
                  className="mt-1.5 w-px flex-1"
                  style={{
                    background: last ? "transparent" : "var(--pc-line)",
                  }}
                />
              </div>

              <div
                className="flex min-w-0 flex-1 items-start justify-between gap-[18px]"
                style={{
                  padding: "14px 0",
                  borderBottom: `1px solid ${last ? "transparent" : "var(--pc-line-soft)"}`,
                }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-[9px]">
                    <span
                      className="uppercase"
                      style={{
                        border: `1px solid ${v.bd}`,
                        background: v.bg,
                        color: v.fg,
                        borderRadius: 5,
                        padding: "3px 8px",
                        fontFamily: MONO,
                        fontSize: 9.5,
                        fontWeight: 700,
                        letterSpacing: ".18em",
                      }}
                    >
                      {s.venue}
                    </span>
                    <span
                      className="uppercase"
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: ".14em",
                        color: "var(--pc-muted)",
                      }}
                    >
                      {s.kind === "read" ? "report" : s.op.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p
                    className="m-0 mt-2"
                    style={{
                      fontSize: 14.5,
                      lineHeight: "21px",
                      color: "var(--pc-body)",
                      textWrap: "pretty",
                    }}
                  >
                    {s.label}
                  </p>
                </div>

                <div className="flex-shrink-0 text-right">
                  {/* A read leg has no size and asks for no signature, so it gets neither
                      the amount figure nor the "amount to be confirmed" warning — that
                      warning is about a write that will stop mid-plan to ask. */}
                  {s.kind === "read" ? (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        lineHeight: "26px",
                        fontWeight: 600,
                        letterSpacing: ".12em",
                        color: "var(--pc-muted)",
                      }}
                    >
                      no signature
                    </p>
                  ) : amount ? (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 21,
                        lineHeight: "26px",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--pc-heading)",
                      }}
                    >
                      {amount}
                    </p>
                  ) : s.fraction != null ? (
                    /* A share IS a size. Shown in the amount slot, in the heading colour
                       rather than the warning colour, because nothing is outstanding —
                       the figure is resolved against the live balance when the leg runs,
                       the same way the site's own 10/25/50/100% chips work. */
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 21,
                        lineHeight: "26px",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--pc-heading)",
                      }}
                    >
                      {`${Number((s.fraction * 100).toFixed(2))}%`}
                    </p>
                  ) : (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        lineHeight: "26px",
                        fontWeight: 600,
                        color: "var(--pc-warn-fg)",
                        maxWidth: 124,
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
                        fontSize: 11.5,
                        fontWeight: 600,
                        letterSpacing: ".12em",
                        color: "var(--pc-muted)",
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

      {/* Signature count can exceed step count. That difference is not a typo, so it is
          weighted differently from the rest of the line. */}
      <p
        className="m-0 mt-3"
        style={{
          fontFamily: MONO,
          fontSize: 11.5,
          lineHeight: "18px",
          color: "var(--pc-muted)",
        }}
      >
        {meta.stepsText} ·{" "}
        <span
          style={{
            color: meta.levered ? "var(--pc-accent)" : "var(--pc-body)",
            fontWeight: 700,
          }}
        >
          {meta.sigText}
        </span>
        {meta.sigNote}
        {meta.venueText ? ` · ${meta.venueText}` : ""}
      </p>

      <div
        className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5"
        role="note"
        aria-label="Execution preview"
        style={{
          border: "1px solid var(--pc-line-soft)",
          borderRadius: 9,
          background: "var(--pc-inset)",
          padding: "9px 12px",
          fontFamily: MONO,
          fontSize: 10.5,
          lineHeight: "17px",
          color: "var(--pc-muted)",
        }}
      >
        <span style={{ color: "var(--pc-body)", fontWeight: 700 }}>execution preview</span>
        <span>{execution.stepCount} planned {execution.stepCount === 1 ? "step" : "steps"}</span>
        <span>{execution.signatureCount} possible {execution.signatureCount === 1 ? "signature" : "signatures"}</span>
        {execution.readCount > 0 ? <span>{execution.readCount} read-only</span> : null}
        {sessionSigning ? (
          <span style={{ color: "var(--pc-accent)" }}>
            {execution.autoSignEligible} write {execution.autoSignEligible === 1 ? "leg" : "legs"} eligible for auto-approve
          </span>
        ) : (
          <span>{execution.manualPrompts} manual {execution.manualPrompts === 1 ? "confirmation" : "confirmations"}</span>
        )}
        {sessionSigning && execution.signatureCount > 0 ? (
          <span>risk limits and spend caps can still pause a leg</span>
        ) : null}
      </div>

      {/* Warnings — never dismissable, always above the buttons. One tinted block holding
          compact rows rather than a stack of full-size panels: boxed panels each the
          height of a paragraph pushed Approve below the fold, which made the plan itself
          the smaller element. */}
      {showNotices ? (
        <div
          className="mt-3.5 flex flex-col gap-1.5"
          style={{
            border: `1px solid ${expired ? "var(--pc-danger-bd)" : "var(--pc-warn-bd)"}`,
            background: expired ? "var(--pc-danger-bg)" : "var(--pc-warn-bg)",
            borderRadius: 10,
            padding: "9px 12px",
          }}
        >
          {expired ? (
            <p
              role="alert"
              className="m-0 flex items-start gap-[9px]"
              style={{
                fontSize: 13,
                lineHeight: "19px",
                color: "var(--pc-danger-fg)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: "19px",
                }}
              >
                !
              </span>
              Prices moved while this plan sat idle — ask again for a fresh
              quote.
            </p>
          ) : null}
          {plan.warnings.map((text) => (
            <p
              key={text}
              role="note"
              className="m-0 flex items-start gap-[9px]"
              style={{
                fontSize: 13,
                lineHeight: "19px",
                color: expired ? "var(--pc-danger-fg)" : "var(--pc-warn-fg)",
                textWrap: "pretty",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: "19px",
                }}
              >
                !
              </span>
              {text}
            </p>
          ))}
        </div>
      ) : null}

      {autoPending && !expired ? (
        <p
          className="m-0 mt-3 flex items-center gap-2"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--pc-accent)",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--pc-accent)",
              animation: "pc-pulse 1.4s ease-in-out infinite",
            }}
          />
          session key is signing — no click needed
        </p>
      ) : null}

      {/* actions */}
      <div className="mt-4 flex items-stretch gap-2.5">
        <button
          type="button"
          onClick={() => onApprove(plan)}
          disabled={approveBlocked}
          aria-disabled={approveBlocked ? "true" : "false"}
          className="pc-btn-1 flex-1"
          style={{
            border: "1px solid transparent",
            borderRadius: 10,
            padding: "14px 22px",
            fontFamily: "inherit",
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: ".01em",
            cursor: unusable
              ? "not-allowed"
              : busy || autoPending
                ? "progress"
                : "pointer",
            background: unusable
              ? "var(--pc-btn-off-bg)"
              : "var(--pc-btn-fill)",
            color: unusable ? "var(--pc-btn-off-fg)" : "var(--pc-btn-fg)",
          }}
        >
          {approveLabel}
        </button>
        <button
          type="button"
          onClick={onModify}
          className="pc-btn-2 cursor-pointer transition-colors"
          // Border and colour come from .pc-btn-2 in globals.css — inline values here
          // would outrank the :hover rule and kill the tint.
          style={{
            borderRadius: 10,
            background: "transparent",
            padding: "14px 20px",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Modify
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="pc-btn-3 cursor-pointer transition-colors"
          style={{
            borderRadius: 10,
            background: "transparent",
            padding: "14px",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Cancel
        </button>
      </div>

      {/* plan_id — the proof that what executes is what was shown */}
      <p
        className="m-0 mt-3 text-right"
        title={`plan_id ${plan.plan_id}`}
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: ".04em",
          color: "var(--pc-quiet)",
        }}
      >
        plan {plan.plan_id.slice(0, 10)}…{plan.plan_id.slice(-3)}
      </p>
    </div>
  );
}
