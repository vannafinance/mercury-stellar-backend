"use client";

/**
 * Run execution card — the live view of a multi-leg strategy executing.
 *
 * Ported from the Claude Design `Run Execution Card.dc.html`. The design's mock configs
 * are dropped: this derives every state from the real leg statuses the server sends, so
 * there is one code path and it cannot disagree with what actually happened on chain.
 *
 * Why this exists: before it, the only thing on screen during a run was a step list
 * reading "done / pending / pending". Nothing said leg 1 had settled and leg 2 was going,
 * nothing showed a leg waiting on the user, and nothing announced the run finishing. The
 * user was watching three signed transactions move real money with no narration.
 *
 * It is ONE card that advances in place — not a new card per leg. Three rules it holds to,
 * each of them a bug that has already happened here once:
 *
 *   - A leg never reads as done before it is done. Status is carried by shape (dashed
 *     ring, square, spinner, check, pause bars, cross) as well as colour and label, so a
 *     glance at three rows cannot be mistaken for a finished run.
 *   - No `opacity`. A later leg is a muted colour token; a faded container is what made
 *     an earlier card unreadable.
 *   - Every field survives being null: no amount, no tx hash, no health factor. Never
 *     blank, never 0.
 *
 * Colours come from `--rc-*` (the `.run-card` block in app/globals.css), self-contained
 * so the card cannot lose one to a token that exists in only one theme block.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LEDGER_CONFIRM_HINT } from "./resume-policy";
import { pairedFromSelected, readAmmOtherPerXlm } from "@/lib/copilot/lp-pair";

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/**
 * The design's status set. `lib/copilot/multi-leg-agent.ts` speaks a different vocabulary
 * (`error`, `blocked`, `stopped_hf`, `clarification`); `toRunLegStatus` below maps it.
 */
export type RunLegStatus =
  | "pending"
  | "staged"
  | "needs_sign"
  | "running"
  | "ok"
  | "needs_input"
  | "failed"
  | "skipped";

export type RunVenue = "margin" | "earn" | "farm" | "wallet" | "other";

export interface RunLeg {
  n: number;
  venue: RunVenue;
  op: string;
  label: string;
  /** Pre-formatted for display; null when the server has not resolved it yet. */
  amount: string | null;
  asset: string | null;
  /**
   * Carried so a resume can replay this leg as planned. Not displayed here — the label
   * already says "at 2× leverage" — but dropping it meant answering a missing amount
   * resumed a levered leg unlevered, which is a different transaction from the approved one.
   */
  leverage?: number | null;
  status: RunLegStatus;
  txHash?: string | null;
  elapsed?: string | null;
  error?: string | null;
  /** needs_input: what to ask, and what a safe answer looks like. */
  question?: string | null;
  hint?: string | null;
  maxSafe?: string | null;
  /** Risk gate held this leg pending an acknowledgement. */
  gateReason?: string | null;
  /**
   * A swap leg's current destination — what a paused-on-this-leg question is actually
   * about when the leg is a swap. Lets the composer patch just this field on resume
   * instead of replaying (or being unable to correct) the original token.
   */
  tokenIn?: string | null;
  tokenOut?: string | null;
  /** AMM LP pause: size either side; the other fills from the live pool ratio. */
  lpSides?: [string, string] | null;
  lpOtherPerXlm?: number | null;
  lpPrefillXlm?: number | null;
  lpPrefillOther?: number | null;
}

export interface RunSummaryRow {
  k: string;
  v: string;
  tone?: "ok" | "warn" | "danger" | "accent" | null;
}

export interface RunExecutionCardProps {
  /** Section number in the workspace column, e.g. "02". */
  eyebrow?: string;
  legs: RunLeg[];
  /** Live health factor — same source as the margin page. null when the read failed. */
  hf: number | null;
  /** The user's own floor ("keep me above 1.4"), or the policy default. */
  floor?: number;
  liquidation?: number;
  signerText: string;
  /** Auto-approve is signing without a popup — drives the blinking signer dot. */
  signerLive?: boolean;
  /** A request is in flight. */
  busy?: boolean;
  summaryRows?: RunSummaryRow[];
  footerNote?: string | null;
  footerTone?: "warn" | "danger";
  onCancel?: () => void;
  onRetry?: (leg: RunLeg) => void;
  onStop?: () => void;
  onNewIntent?: () => void;
  onViewTx?: () => void;
  /** needs_input: the user supplied the missing amount; resume from this leg. */
  onSubmitAmount?: (
    leg: RunLeg,
    amount: number,
    selectedAsset?: string,
    pair?: { amount_a: number; amount_b: number },
  ) => void;
  onConfirmGate?: (leg: RunLeg) => void;
}

/**
 * Map the server's leg vocabulary onto the design's.
 *
 * `clarification` becomes `needs_input` — the run is paused on a question. Whether that
 * question gets a NUMERIC FIELD is a separate decision, made per leg from whether an
 * amount is actually missing (see `showInput` below). A clarification that already has
 * its amount is asking about something else — which USDC, usually — and answering it
 * with a number box would be asking the wrong question.
 */
export function toRunLegStatus(raw: string | null | undefined, inFlight = false): RunLegStatus {
  switch (String(raw ?? "")) {
    case "ok":
    case "done":
    case "signed_and_submitted":
      return "ok";
    case "error":
    case "blocked":
    case "preflight_blocked":
    case "stopped":
    case "stopped_hf":
      return "failed";
    case "skipped":
      return "skipped";
    case "needs_sign":
    case "needs_wallet_sign":
    case "needs_auto_sign":
      return inFlight ? "running" : "needs_sign";
    case "staged":
      return "staged";
    // A leg the model could not fill in becomes a clarification turn on the server. That
    // is exactly this card's "paused, needs input" — the run stops for one number.
    case "clarification":
    case "needs_confirmation":
      return "needs_input";
    default:
      return inFlight ? "running" : "pending";
  }
}

const VENUES: readonly RunVenue[] = ["margin", "earn", "farm", "wallet"];

function venueTokens(venue: RunVenue) {
  const key = VENUES.includes(venue) ? venue : "wallet";
  return {
    fg: `var(--rc-${key}-fg)`,
    bg: `var(--rc-${key}-bg)`,
    bd: `var(--rc-${key}-bd)`,
  };
}

interface StatusMeta {
  text: string;
  color: string;
  mark: "hollow" | "staged" | "pause" | "spin" | "check" | "fail";
}

const STATUS: Record<RunLegStatus, StatusMeta> = {
  pending: { text: "pending", color: "var(--rc-quiet)", mark: "hollow" },
  staged: { text: "staged · xdr built", color: "var(--rc-accent)", mark: "staged" },
  needs_sign: { text: "waiting on your signature", color: "var(--rc-warn-fg)", mark: "pause" },
  // Names the expected duration. "waiting on ledger" with no sense of how long
  // reads as hung after about ten seconds, and Soroban testnet routinely takes
  // three to six times that. The hash renders alongside this as soon as the
  // submit returns, so there is something checkable during the wait.
  running: {
    text: `confirming on ledger (${LEDGER_CONFIRM_HINT})`,
    color: "var(--rc-accent)",
    mark: "spin",
  },
  ok: { text: "settled", color: "var(--rc-ok-fg)", mark: "check" },
  needs_input: { text: "paused · needs input", color: "var(--rc-warn-fg)", mark: "pause" },
  failed: { text: "failed", color: "var(--rc-danger-fg)", mark: "fail" },
  skipped: { text: "skipped", color: "var(--rc-quiet)", mark: "hollow" },
};

const TERMINAL: ReadonlySet<RunLegStatus> = new Set(["ok", "failed", "skipped"]);

const TONE: Record<string, string> = {
  ok: "var(--rc-ok-fg)",
  warn: "var(--rc-warn-fg)",
  danger: "var(--rc-danger-fg)",
  accent: "var(--rc-accent)",
};

/** Band the health factor falls in. The middle boundary is the user's own floor. */
function hfBand(v: number | null, floor: number, liquidation: number) {
  if (v == null || !Number.isFinite(v)) {
    return { band: "unavailable", color: "var(--rc-quiet)" };
  }
  if (v < liquidation) return { band: "danger", color: "var(--rc-danger-fg)" };
  if (v < floor) return { band: "warning", color: "var(--rc-warn-fg)" };
  if (v < 2.0) return { band: "caution", color: "var(--rc-farm-fg)" };
  return { band: "healthy", color: "var(--rc-ok-fg)" };
}

/**
 * Meter scale. The design pinned the liquidation and floor ticks at 5% and 20% while
 * scaling the fill by hf/3 — on that scale those marks sit at 0.15 and 0.6, so the
 * liquidation line was drawn nowhere near 1.10. Both the fill and the ticks now come
 * from this one function, so the marks mean what they say.
 */
const HF_TOP = 3;
function hfPct(v: number): number {
  return Math.max(0, Math.min(100, (v / HF_TOP) * 100));
}

function MarkIcon({ mark }: { mark: StatusMeta["mark"] }) {
  const ring = {
    width: 16,
    height: 16,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  } as const;
  switch (mark) {
    case "spin":
      return (
        <span
          aria-hidden="true"
          style={{
            width: 16,
            height: 16,
            borderRadius: 999,
            border: "2px solid var(--rc-accent-bd)",
            borderTopColor: "var(--rc-accent)",
            animation: "rc-spin .9s linear infinite",
          }}
        />
      );
    case "check":
      return (
        <span
          aria-hidden="true"
          style={{
            ...ring,
            background: "var(--rc-ok-bg)",
            border: "1px solid var(--rc-ok-bd)",
            color: "var(--rc-ok-fg)",
          }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      );
    case "pause":
      return (
        <span
          aria-hidden="true"
          style={{
            ...ring,
            background: "var(--rc-warn-bg)",
            border: "1px solid var(--rc-warn-bd)",
            color: "var(--rc-warn-fg)",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        </span>
      );
    case "fail":
      return (
        <span
          aria-hidden="true"
          style={{
            ...ring,
            background: "var(--rc-danger-bg)",
            border: "1px solid var(--rc-danger-bd)",
            color: "var(--rc-danger-fg)",
          }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </span>
      );
    case "staged":
      return (
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            border: "2px solid var(--rc-accent)",
          }}
        />
      );
    default:
      return (
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: 999,
            border: "2px dashed var(--rc-quiet)",
          }}
        />
      );
  }
}

export function RunExecutionCard({
  eyebrow = "02",
  legs,
  hf,
  floor = 1.3,
  liquidation = 1.1,
  signerText,
  signerLive = false,
  busy = false,
  summaryRows,
  footerNote,
  footerTone = "warn",
  onCancel,
  onRetry,
  onStop,
  onNewIntent,
  onViewTx,
  onSubmitAmount,
  onConfirmGate,
}: RunExecutionCardProps) {
  const total = legs.length;

  const shape = useMemo(() => {
    const firstOpen = legs.findIndex((l) => !TERMINAL.has(l.status));
    const complete = total > 0 && legs.every((l) => l.status === "ok");
    return {
      focus: firstOpen === -1 ? Math.max(0, total - 1) : firstOpen,
      complete,
      doneCount: legs.filter((l) => l.status === "ok").length,
      failed: legs.find((l) => l.status === "failed") ?? null,
      needsInput: legs.find((l) => l.status === "needs_input") ?? null,
      gate: legs.find((l) => l.gateReason && !TERMINAL.has(l.status)) ?? null,
      needsSign: legs.find((l) => l.status === "needs_sign") ?? null,
      running: legs.find((l) => l.status === "running") ?? null,
    };
  }, [legs, total]);

  // Elapsed timer for the leg in flight, and the amount being typed for a paused leg.
  // Both reset when their leg changes, so leg 3 never inherits leg 2's clock or draft.
  //
  // The reset happens during render off a tracked key rather than in an effect: resetting
  // in an effect means one frame where the new leg shows the previous leg's elapsed time.
  // This is React's documented "adjust state when a prop changes" pattern.
  const runningKey = shape.running ? shape.running.n : null;
  const inputKey = shape.needsInput ? shape.needsInput.n : null;

  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState("");
  const [lpPick, setLpPick] = useState<string | null>(null);
  const [keys, setKeys] = useState<{ running: number | null; input: number | null }>({
    running: runningKey,
    input: inputKey,
  });
  if (keys.running !== runningKey || keys.input !== inputKey) {
    setKeys({ running: runningKey, input: inputKey });
    if (keys.running !== runningKey) setElapsed(0);
    if (keys.input !== inputKey) {
      setDraft("");
      setLpPick(null);
    }
  }

  useEffect(() => {
    if (runningKey == null) return;
    // Timestamp rather than a tick count: a throttled background tab would otherwise
    // under-count and report a leg as faster than it was.
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [runningKey]);

  const fieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inputKey != null) fieldRef.current?.focus();
  }, [inputKey]);

  const [liveRatio, setLiveRatio] = useState<number | null>(null);
  const [xlmDraft, setXlmDraft] = useState("");
  const [otherDraft, setOtherDraft] = useState("");
  useEffect(() => {
    const leg = shape.needsInput;
    if (!leg || leg.op !== "add_liquidity") {
      setLiveRatio(null);
      return;
    }
    if (leg.lpPrefillXlm != null && leg.lpPrefillXlm > 0) {
      const n = leg.lpPrefillXlm;
      setXlmDraft(
        Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9
          ? String(Math.round(n))
          : n.toFixed(4).replace(/\.?0+$/, ""),
      );
    }
    if (leg.lpPrefillOther != null && leg.lpPrefillOther > 0) {
      const n = leg.lpPrefillOther;
      setOtherDraft(
        Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9
          ? String(Math.round(n))
          : n.toFixed(4).replace(/\.?0+$/, ""),
      );
    }
    if (leg.lpOtherPerXlm != null && leg.lpOtherPerXlm > 0) {
      setLiveRatio(leg.lpOtherPerXlm);
      return;
    }
    const other = leg.lpSides?.[1] || "AQUSDC";
    let cancelled = false;
    void (async () => {
      const r = await readAmmOtherPerXlm(other);
      if (!cancelled && r != null && r > 0) setLiveRatio(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [shape.needsInput]);

  const submitAmount = useCallback(() => {
    const leg = shape.needsInput;
    if (!leg || !onSubmitAmount) return;
    if (leg.op === "add_liquidity" && leg.lpSides && leg.lpSides.length === 2) {
      const xlmN = Number(xlmDraft);
      const otherN = Number(otherDraft);
      if (!(xlmN > 0) || !(otherN > 0)) return;
      onSubmitAmount(leg, xlmN, "XLM", { amount_a: xlmN, amount_b: otherN });
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) return;
    const sides = leg.lpSides;
    const selected =
      lpPick ||
      (sides && leg.asset && sides.includes(leg.asset) ? leg.asset : sides?.[1]) ||
      undefined;
    onSubmitAmount(leg, n, selected);
  }, [draft, lpPick, onSubmitAmount, shape.needsInput, xlmDraft, otherDraft]);

  const dualLp =
    shape.needsInput?.op === "add_liquidity" &&
    !!shape.needsInput.lpSides &&
    shape.needsInput.lpSides.length === 2;
  const draftValid = dualLp
    ? Number(xlmDraft) > 0 && Number(otherDraft) > 0
    : Number.isFinite(Number(draft)) && Number(draft) > 0;

  const band = hfBand(hf, floor, liquidation);
  const hfUnavailable = hf == null || !Number.isFinite(hf);

  /** Headline, beat and the actions row all follow from the leg statuses. */
  const narration = useMemo(() => {
    const { complete, failed, needsInput, gate, needsSign, running, doneCount, focus } = shape;
    const nth = (i: number) => `leg ${i + 1} of ${total}`;

    if (complete) {
      return {
        headline: "run complete",
        headDanger: false,
        beat: "Every leg settled",
        beatTone: "ok" as const,
        /**
         * Legs are not all transactions. A read leg reports a number and never touches
         * the chain, so counting every leg here claimed "2 transactions on chain" on a
         * run whose own TRANSACTIONS field, in the same card, correctly said 1. Counted
         * from the legs that actually produced a hash.
         *
         * The `|| total` fallback below looked harmless — "if nothing has a hash yet,
         * assume the leg count" — and was itself the same bug for the one case that
         * matters most: an all-read strategy. "show me everything about my account" (5
         * read legs, zero signatures, zero writes) said "5 transactions on chain. Nothing
         * is left in flight." — the exact false on-chain claim this card exists to
         * prevent, just arrived at through the fallback instead of the count. Zero on
         * chain must say zero, in words a read run has actually earned.
         */
        beatSub: (() => {
          const onChain = legs.filter((l) => l.txHash).length;
          if (onChain === 0) {
            return "Every leg was a read — nothing signed, nothing on chain.";
          }
          return `${onChain} transaction${onChain === 1 ? "" : "s"} on chain. Nothing is left in flight.`;
        })(),
      };
    }
    if (failed) {
      const settled = legs.filter((l) => l.status === "ok");
      return {
        headline: "run stopped",
        headDanger: true,
        beat: `Leg ${failed.n} failed — the run stopped there`,
        beatTone: "danger" as const,
        beatSub: settled.length
          ? `What is on chain right now: ${settled.map((l) => l.label.toLowerCase()).join(", ")}. Nothing after leg ${failed.n} ran.`
          : "Nothing settled — your position is unchanged.",
      };
    }
    if (needsInput) {
      return {
        headline: "paused · needs you",
        headDanger: false,
        beat: `Paused on ${nth(focus)}`,
        beatTone: "warn" as const,
        beatSub: "I need one number before I can continue. Nothing else is in flight.",
      };
    }
    if (gate) {
      return {
        headline: "paused · confirm",
        headDanger: false,
        beat: `The risk gate wants a confirmation on leg ${gate.n}`,
        beatTone: "warn" as const,
        beatSub: "Everything is priced and built — it just needs your acknowledgement.",
      };
    }
    if (needsSign) {
      return {
        headline: "waiting on your signature",
        headDanger: false,
        beat: `Leg ${needsSign.n} is built and waiting for you to sign`,
        beatTone: "warn" as const,
        beatSub: "Approve it in your wallet and the rest of the run continues on its own.",
      };
    }
    if (running) {
      return {
        headline: signerLive ? "auto-approving" : "executing",
        headDanger: false,
        beat: running.label,
        beatTone: "plain" as const,
        beatSub: signerLive
          ? "Submitted to the ledger — the session key signed it, no wallet popup."
          : "Submitted to the ledger.",
      };
    }
    // Nothing running / signing / gated, but legs remain. "Advancing" is only true
    // while a hop request is on the wire (busy). Without that gate the card said
    // "Leg 2 settled · advancing to leg 3 of 4" forever after the client queue
    // was cleared — UI spinning, no POST.
    if (doneCount > 0) {
      if (busy) {
        return {
          headline: signerLive ? "auto-approving" : "executing",
          headDanger: false,
          beat: `Leg ${doneCount} settled · advancing to ${nth(focus)}`,
          beatTone: "ok" as const,
          beatSub: legs[focus] ? `Next: ${legs[focus].label.toLowerCase()}.` : undefined,
        };
      }
      return {
        headline: "paused · continue",
        headDanger: false,
        beat: `Leg ${doneCount} settled · ${nth(focus)} still pending`,
        beatTone: "warn" as const,
        beatSub: legs[focus]
          ? `Next: ${legs[focus].label.toLowerCase()}. Waiting for auto-resume or Continue.`
          : "Waiting for auto-resume or Continue.",
      };
    }
    if (busy) {
      return {
        headline: signerLive ? "auto-approving" : "executing",
        headDanger: false,
        beat: `Starting ${nth(focus)}`,
        beatTone: "plain" as const,
        beatSub: legs[focus] ? legs[focus].label : undefined,
      };
    }
    return {
      headline: "paused · continue",
      headDanger: false,
      beat: `Ready on ${nth(focus)}`,
      beatTone: "warn" as const,
      beatSub: legs[focus] ? legs[focus].label : undefined,
    };
  }, [shape, legs, total, signerLive, busy]);

  const beatColor =
    narration.beatTone === "danger"
      ? "var(--rc-danger-fg)"
      : narration.beatTone === "warn"
        ? "var(--rc-warn-fg)"
        : narration.beatTone === "ok"
          ? "var(--rc-ok-fg)"
          : "var(--rc-heading)";

  if (total === 0) return null;

  const btnBase = {
    borderRadius: 10,
    fontFamily: "inherit",
    cursor: "pointer",
  } as const;

  return (
    <div
      className="run-card mt-3.5"
      role="group"
      aria-label="Strategy run"
      style={{
        border: "1px solid var(--rc-line)",
        borderRadius: 14,
        background: "var(--rc-surface)",
        padding: "20px 22px 18px",
      }}
    >
      {/* header: stage label, settled count, one pip per leg */}
      <div className="flex items-center justify-between gap-5">
        <p
          className="m-0 flex items-center gap-[9px] uppercase"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: ".2em",
            color: narration.headDanger ? "var(--rc-danger-fg)" : "var(--rc-muted)",
          }}
        >
          <span style={{ color: "var(--rc-accent)" }}>{eyebrow}</span> · {narration.headline}
        </p>
        <p
          className="m-0 flex items-center gap-2.5"
          style={{ fontFamily: MONO, fontSize: 11, color: "var(--rc-muted)" }}
        >
          <span>
            {shape.doneCount} of {total} settled
          </span>
          <span className="flex gap-[3px]">
            {legs.map((l, i) => (
              <span
                key={`pip-${l.n}-${i}`}
                style={{
                  width: 16,
                  height: 4,
                  borderRadius: 2,
                  background:
                    l.status === "ok"
                      ? "var(--rc-ok-fg)"
                      : l.status === "failed"
                        ? "var(--rc-danger-fg)"
                        : l.status === "needs_input" || l.status === "needs_sign"
                          ? "var(--rc-warn-fg)"
                          : i === shape.focus && !shape.complete
                            ? "var(--rc-accent)"
                            : "var(--rc-track)",
                }}
              />
            ))}
          </span>
        </p>
      </div>

      {/* the beat: what is happening right now, in one line */}
      <p
        aria-live="polite"
        className="m-0 mt-3.5 font-semibold"
        style={{ fontSize: 17, lineHeight: "25px", color: beatColor, textWrap: "pretty" }}
      >
        {narration.beat}
      </p>
      {narration.beatSub ? (
        <p
          className="m-0 mt-[5px]"
          style={{
            fontSize: 14,
            lineHeight: "21px",
            color: "var(--rc-muted)",
            textWrap: "pretty",
          }}
        >
          {narration.beatSub}
        </p>
      ) : null}

      {/* the legs */}
      <div
        className="mt-3.5"
        style={{
          border: "1px solid var(--rc-line-soft)",
          borderRadius: 12,
          background: "var(--rc-inset)",
          padding: "5px 14px",
        }}
      >
        {legs.map((l, i) => {
          const meta = STATUS[l.status];
          const v = venueTokens(l.venue);
          const settled = l.status === "ok";
          const isFocus = i === shape.focus && !shape.complete;
          const later = i > shape.focus && !shape.complete;
          const last = i === total - 1;
          /**
           * A read leg has no amount and never will — it reports a number, it does not
           * spend one. Treating a missing amount as "to be confirmed" made a reporting
           * step look like a write the run would stop and ask about. MCP read tools are
           * named `vanna_get_*` / `vanna_list_*`, which is what distinguishes them here.
           */
          const isReadLeg = /^vanna_(get|list|can|resolve)_/.test(String(l.op ?? ""));
          const missing = l.amount == null && !isReadLeg;
          /**
           * One field at a time, and only on the leg the run is actually waiting on.
           *
           * A stopped run can leave several legs `needs_input` at once — the leg that
           * halted it, plus every later leg whose size was also unknown. Rendering a field
           * on each put two live inputs on screen sharing a single draft value, so typing
           * in one filled both and it was ambiguous which leg a number belonged to. Later
           * paused legs show their question without a field; they get one when the run
           * reaches them.
           */
          const isPausedHere = inputKey != null && l.n === inputKey;
          const showInput =
            l.status === "needs_input" &&
            isPausedHere &&
            (missing || (l.op === "add_liquidity" && !!l.lpSides));
          const showQuestionOnly = l.status === "needs_input" && (!missing || !isPausedHere);
          const showGate = !!l.gateReason && !TERMINAL.has(l.status);
          const lpSelected =
            l.lpSides && l.lpSides.length === 2
              ? lpPick ||
                (l.asset && l.lpSides.includes(l.asset) ? l.asset : l.lpSides[1])
              : null;
          const lpDraftN = Number(draft);
          const lpRatio = liveRatio ?? l.lpOtherPerXlm;
          const lpPairPreview =
            showInput &&
            lpSelected &&
            l.lpSides &&
            lpRatio != null &&
            lpRatio > 0 &&
            Number.isFinite(lpDraftN) &&
            lpDraftN > 0
              ? pairedFromSelected(lpSelected, lpDraftN, lpRatio)
              : null;

          return (
            <div
              key={`leg-${l.n}-${i}`}
              className="flex items-stretch gap-3"
              style={{
                background: isFocus ? "var(--rc-focus-bg)" : "transparent",
                borderRadius: isFocus ? 10 : 0,
                margin: isFocus ? "6px -8px" : 0,
                padding: isFocus ? "2px 8px" : 0,
              }}
            >
              {/* status mark + rail */}
              <div
                className="flex w-[22px] flex-shrink-0 flex-col items-center"
                style={{ paddingTop: isFocus ? 16 : 13 }}
              >
                <MarkIcon mark={meta.mark} />
                <span
                  className="mt-1.5 w-px flex-1"
                  style={{
                    background: last
                      ? "transparent"
                      : settled
                        ? "var(--rc-ok-bd)"
                        : "var(--rc-line)",
                  }}
                />
              </div>

              <div
                className="min-w-0 flex-1"
                style={{
                  padding: isFocus ? "12px 0 13px" : settled ? "10px 0" : "11px 0",
                  borderBottom: `1px solid ${last ? "transparent" : "var(--rc-line-soft)"}`,
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="uppercase"
                        style={{
                          border: `1px solid ${v.bd}`,
                          background: v.bg,
                          color: v.fg,
                          borderRadius: 5,
                          padding: "2px 7px",
                          fontFamily: MONO,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: ".18em",
                        }}
                      >
                        {l.venue}
                      </span>
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: ".1em",
                          color: later ? "var(--rc-quiet)" : "var(--rc-muted)",
                        }}
                      >
                        {l.op.replace(/_/g, " ")}
                      </span>
                      <span
                        className="uppercase"
                        style={{
                          fontFamily: MONO,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: ".16em",
                          color: meta.color,
                        }}
                      >
                        {meta.text}
                      </span>
                    </div>

                    <p
                      className="m-0 mt-1.5"
                      style={{
                        fontSize: isFocus ? 15.5 : 14,
                        lineHeight: "20px",
                        fontWeight: isFocus ? 600 : 400,
                        color: later
                          ? "var(--rc-quiet)"
                          : settled
                            ? "var(--rc-body)"
                            : "var(--rc-heading)",
                        textWrap: "pretty",
                      }}
                    >
                      <span style={{ fontFamily: MONO, color: "var(--rc-quiet)" }}>{l.n}.</span>{" "}
                      {l.label}
                    </p>

                    {l.txHash ? (
                      <p
                        className="m-0 mt-1 flex items-center gap-2"
                        style={{ fontFamily: MONO, fontSize: 11, color: "var(--rc-muted)" }}
                      >
                        <span>{l.txHash}</span>
                        {l.elapsed ? (
                          <>
                            <span style={{ color: "var(--rc-quiet)" }}>·</span>
                            <span>{l.elapsed}</span>
                          </>
                        ) : null}
                      </p>
                    ) : null}

                    {l.error ? (
                      <p
                        className="m-0 mt-1.5"
                        style={{
                          fontSize: 13,
                          lineHeight: "19px",
                          color: "var(--rc-danger-fg)",
                          textWrap: "pretty",
                        }}
                      >
                        {l.error}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex-shrink-0 text-right">
                    {missing ? (
                      <p
                        className="m-0"
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          lineHeight: "24px",
                          fontWeight: 600,
                          color: "var(--rc-warn-fg)",
                          maxWidth: 110,
                        }}
                      >
                        {showInput ? "waiting on you" : "amount to be confirmed"}
                      </p>
                    ) : (
                      <p
                        className="m-0"
                        style={{
                          fontFamily: MONO,
                          fontSize: isFocus ? 20 : 16,
                          lineHeight: "24px",
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                          color: later ? "var(--rc-quiet)" : "var(--rc-heading)",
                        }}
                      >
                        {l.amount}
                      </p>
                    )}
                    {l.asset ? (
                      <p
                        className="m-0 mt-px"
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: ".1em",
                          color: later ? "var(--rc-quiet)" : "var(--rc-muted)",
                        }}
                      >
                        {l.asset}
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* in flight: indeterminate bar + this leg's elapsed time */}
                {l.status === "running" ? (
                  <div className="mt-[9px] flex items-center gap-2.5">
                    <span
                      className="flex-1 overflow-hidden"
                      style={{ height: 3, borderRadius: 2, background: "var(--rc-track)" }}
                    >
                      <span
                        className="block"
                        style={{
                          height: 3,
                          width: "30%",
                          borderRadius: 2,
                          background: "var(--rc-accent)",
                          animation: "rc-slide 1.2s ease-in-out infinite",
                        }}
                      />
                    </span>
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--rc-accent)",
                      }}
                    >
                      {elapsed}s
                    </span>
                  </div>
                ) : null}

                {/* paused for a value the plan never carried */}
                {showInput ? (
                  <div
                    className="mt-[11px]"
                    style={{
                      border: "1px solid var(--rc-warn-bd)",
                      background: "var(--rc-warn-bg)",
                      borderRadius: 10,
                      padding: "13px 14px",
                    }}
                  >
                    <p
                      className="m-0 font-bold"
                      style={{ fontSize: 14.5, lineHeight: "21px", color: "var(--rc-warn-fg)" }}
                    >
                      {l.question ||
                        `How much ${l.asset || "of it"} should I ${l.op.replace(/_/g, " ")}?`}
                    </p>
                    {/* The stakes, stated from the real legs — abandoning here is the
                        expensive move, and it must not be a surprise. */}
                    <p
                      className="m-0 mt-1.5"
                      style={{
                        fontSize: 13,
                        lineHeight: "19px",
                        color: "var(--rc-warn-fg)",
                        textWrap: "pretty",
                      }}
                    >
                      {shape.doneCount > 0
                        ? `${shape.doneCount === 1 ? "Leg 1 has" : `Legs 1–${shape.doneCount} have`} already settled on chain. Cancel here and you keep a half-built position.`
                        : "Nothing has settled yet, so cancelling here costs you nothing."}
                    </p>

                    {l.op === "add_liquidity" && l.lpSides && l.lpSides.length === 2 ? (
                      <>
                        {(["XLM", l.lpSides[1]] as const).map((side) => {
                          const isXlm = side === "XLM";
                          const val = isXlm ? xlmDraft : otherDraft;
                          const ratio = liveRatio ?? l.lpOtherPerXlm;
                          return (
                            <div
                              key={side}
                              className="lp-dual-field rc-field mt-[11px]"
                              style={{
                                border: "1px solid var(--rc-field-bd)",
                                borderRadius: 12,
                                background: "var(--rc-field-bg)",
                                padding: "10px 12px",
                              }}
                            >
                              <div className="flex items-center justify-between">
                                <span
                                  style={{
                                    fontFamily: MONO,
                                    fontSize: 11,
                                    letterSpacing: ".08em",
                                    color: "var(--rc-muted)",
                                  }}
                                >
                                  YOU ADD
                                </span>
                                <span
                                  style={{
                                    fontFamily: MONO,
                                    fontSize: 12,
                                    fontWeight: 700,
                                    letterSpacing: ".08em",
                                    color: "var(--rc-heading)",
                                  }}
                                >
                                  {side}
                                </span>
                              </div>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                placeholder="0.00"
                                value={val}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  const n = Number(raw);
                                  const live = ratio != null && ratio > 0 && Number.isFinite(n) && n > 0;
                                  if (isXlm) {
                                    setXlmDraft(raw);
                                    setOtherDraft(live ? (n * ratio).toFixed(4).replace(/\.?0+$/, "") : "");
                                  } else {
                                    setOtherDraft(raw);
                                    setXlmDraft(live ? (n / ratio).toFixed(4).replace(/\.?0+$/, "") : "");
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    submitAmount();
                                  }
                                }}
                                className="mt-1 w-full outline-none ring-0 focus:outline-none focus:ring-0"
                                style={{
                                  border: 0,
                                  outline: "none",
                                  boxShadow: "none",
                                  background: "transparent",
                                  fontFamily: MONO,
                                  fontSize: 26,
                                  fontWeight: 600,
                                  fontVariantNumeric: "tabular-nums",
                                  color: "var(--rc-heading)",
                                  WebkitAppearance: "none",
                                }}
                              />
                            </div>
                          );
                        })}
                        {liveRatio != null && liveRatio > 0 ? (
                          <p
                            className="m-0 mt-2"
                            style={{
                              fontFamily: MONO,
                              fontSize: 12,
                              color: "var(--rc-muted)",
                            }}
                          >
                            1 XLM ≈ {liveRatio.toFixed(4)} {l.lpSides[1]} · 1 {l.lpSides[1]} ≈{" "}
                            {(1 / liveRatio).toFixed(2)} XLM
                          </p>
                        ) : null}
                        <button
                          type="button"
                          className="rc-btn-p mt-[11px] w-full"
                          onClick={submitAmount}
                          disabled={!draftValid || busy}
                          style={{
                            ...btnBase,
                            border: "1px solid transparent",
                            borderRadius: 9,
                            background: "var(--rc-btn-fill)",
                            color: "var(--rc-btn-fg)",
                            padding: "12px 20px",
                            fontSize: 14,
                            fontWeight: 700,
                            cursor: !draftValid || busy ? "not-allowed" : "pointer",
                          }}
                        >
                          Approve & sign
                        </button>
                      </>
                    ) : (
                    <>
                    {l.lpSides && l.lpSides.length === 2 ? (
                      <div className="mt-[11px] flex flex-wrap gap-2">
                        {l.lpSides.map((side) => {
                          const on = lpSelected === side;
                          return (
                            <button
                              key={side}
                              type="button"
                              onClick={() => setLpPick(side)}
                              style={{
                                border: on ? "1px solid transparent" : "1px solid var(--rc-accent-bd)",
                                background: on ? "var(--rc-btn-fill)" : "transparent",
                                color: on ? "var(--rc-btn-fg)" : "var(--rc-heading)",
                                borderRadius: 8,
                                padding: "7px 12px",
                                fontFamily: MONO,
                                fontSize: 12,
                                fontWeight: 700,
                                letterSpacing: ".08em",
                                cursor: "pointer",
                              }}
                            >
                              {side}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="mt-[11px] flex items-stretch gap-[9px]">
                      <label
                        className="rc-field relative flex flex-1 items-center overflow-hidden"
                        style={{
                          border: "1px solid var(--rc-field-bd)",
                          borderRadius: 9,
                          background: "var(--rc-field-bg)",
                          padding: "0 12px",
                        }}
                      >
                        <span className="sr-only">
                          {l.question || `Amount of ${l.asset || "asset"}`}
                        </span>
                        <input
                          ref={fieldRef}
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="any"
                          placeholder="0.00"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              submitAmount();
                            }
                          }}
                          className="min-w-0 flex-1"
                          style={{
                            border: 0,
                            background: "transparent",
                            padding: "11px 0",
                            fontFamily: MONO,
                            fontSize: 19,
                            fontWeight: 600,
                            fontVariantNumeric: "tabular-nums",
                            color: "var(--rc-heading)",
                          }}
                        />
                        {lpSelected || l.asset ? (
                          <span
                            aria-hidden="true"
                            style={{
                              fontFamily: MONO,
                              fontSize: 13,
                              fontWeight: 700,
                              letterSpacing: ".1em",
                              color: "var(--rc-muted)",
                            }}
                          >
                            {lpSelected || l.asset}
                          </span>
                        ) : null}
                      </label>
                      <button
                        type="button"
                        className="rc-btn-p"
                        onClick={submitAmount}
                        disabled={!draftValid || busy}
                        style={{
                          ...btnBase,
                          border: "1px solid transparent",
                          borderRadius: 9,
                          background: "var(--rc-btn-fill)",
                          color: "var(--rc-btn-fg)",
                          padding: "11px 20px",
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: !draftValid || busy ? "not-allowed" : "pointer",
                        }}
                      >
                        Continue
                      </button>
                    </div>

                    {lpPairPreview && l.lpSides ? (
                      <p
                        className="m-0 mt-2"
                        style={{
                          fontFamily: MONO,
                          fontSize: 12,
                          lineHeight: "18px",
                          color: "var(--rc-heading)",
                        }}
                      >
                        {lpSelected === "XLM"
                          ? `≈ ${lpPairPreview.other.toFixed(4)} ${l.lpSides[1]} at the live pool ratio`
                          : `≈ ${lpPairPreview.xlm.toFixed(4)} XLM at the live pool ratio`}
                      </p>
                    ) : null}
                    </>
                    )}

                    <div className="mt-[9px] flex flex-wrap items-center justify-between gap-3">
                      <p
                        className="m-0"
                        style={{
                          fontFamily: MONO,
                          fontSize: 11.5,
                          lineHeight: "17px",
                          color: "var(--rc-warn-fg)",
                        }}
                      >
                        {l.hint || "Enter to continue"}
                      </p>
                      {l.maxSafe ? (
                        <button
                          type="button"
                          className="rc-btn-max transition-colors"
                          onClick={() => setDraft(String(l.maxSafe))}
                          style={{
                            ...btnBase,
                            borderRadius: 7,
                            background: "transparent",
                            padding: "5px 10px",
                            fontFamily: MONO,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          use max safe
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* Paused on a question that is not a number — no field, because there is
                    nothing numeric to type. The answer goes in the composer. */}
                {showQuestionOnly ? (
                  <div
                    className="mt-[11px]"
                    style={{
                      border: "1px solid var(--rc-warn-bd)",
                      background: "var(--rc-warn-bg)",
                      borderRadius: 10,
                      padding: "13px 14px",
                    }}
                  >
                    <p
                      className="m-0 font-bold"
                      style={{ fontSize: 14.5, lineHeight: "21px", color: "var(--rc-warn-fg)" }}
                    >
                      {l.question || "This leg needs one more detail before it can run."}
                    </p>
                    <p
                      className="m-0 mt-1.5"
                      style={{
                        fontSize: 13,
                        lineHeight: "19px",
                        color: "var(--rc-warn-fg)",
                        textWrap: "pretty",
                      }}
                    >
                      {isPausedHere
                        ? "Answer below and the run continues from here."
                        : "I'll ask for this when the run reaches it — finish the leg above first."}
                      {shape.doneCount > 0
                        ? ` ${shape.doneCount === 1 ? "Leg 1 has" : `Legs 1–${shape.doneCount} have`} already settled on chain.`
                        : ""}
                    </p>
                  </div>
                ) : null}

                {/* risk gate held this leg — nothing is being asked FOR, only ABOUT */}
                {showGate ? (
                  <div
                    className="mt-[11px]"
                    style={{
                      border: "1px solid var(--rc-accent-bd)",
                      background: "var(--rc-accent-soft)",
                      borderRadius: 10,
                      padding: "13px 14px",
                    }}
                  >
                    <p
                      className="m-0 uppercase"
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: ".18em",
                        color: "var(--rc-accent)",
                      }}
                    >
                      risk gate · confirm
                    </p>
                    <p
                      className="m-0 mt-[7px] font-semibold"
                      style={{
                        fontSize: 14.5,
                        lineHeight: "21px",
                        color: "var(--rc-body)",
                        textWrap: "pretty",
                      }}
                    >
                      {l.gateReason}
                    </p>
                    <p
                      className="m-0 mt-[5px]"
                      style={{ fontSize: 13, lineHeight: "19px", color: "var(--rc-muted)" }}
                    >
                      Nothing is being asked for — confirm you accept this and the run continues
                      on its own.
                    </p>
                    <div className="mt-[11px] flex gap-[9px]">
                      <button
                        type="button"
                        className="rc-btn-p"
                        onClick={() => onConfirmGate?.(l)}
                        disabled={busy}
                        style={{
                          ...btnBase,
                          border: "1px solid transparent",
                          borderRadius: 9,
                          background: "var(--rc-btn-fill)",
                          color: "var(--rc-btn-fg)",
                          padding: "11px 20px",
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: busy ? "progress" : "pointer",
                        }}
                      >
                        Confirm &amp; continue
                      </button>
                      <button
                        type="button"
                        className="rc-btn-s transition-colors"
                        onClick={onCancel}
                        style={{
                          ...btnBase,
                          borderRadius: 9,
                          background: "transparent",
                          padding: "11px 18px",
                          fontSize: 14,
                          fontWeight: 600,
                        }}
                      >
                        Cancel run
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* health factor — a meter, because the number alone does not say how close this is */}
      <div className="mt-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className="uppercase"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".18em",
              color: "var(--rc-muted)",
            }}
          >
            health factor
          </span>
          <span className="flex items-baseline gap-2">
            <span
              style={{
                fontFamily: MONO,
                fontSize: 19,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: band.color,
              }}
            >
              {hfUnavailable ? "unavailable" : (hf as number).toFixed(2)}
            </span>
            <span
              className="uppercase"
              style={{
                fontFamily: MONO,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".16em",
                color: band.color,
              }}
            >
              {band.band}
            </span>
          </span>
        </div>
        <div
          className="relative mt-[7px]"
          style={{ height: 8, borderRadius: 4, background: "var(--rc-track)" }}
        >
          {/* No fill at all when the read failed — a full green bar would be a lie. */}
          {hfUnavailable ? null : (
            <div
              className="absolute bottom-0 left-0 top-0"
              style={{
                width: `${hfPct(hf as number)}%`,
                borderRadius: 4,
                background: band.color,
              }}
            />
          )}
          <div
            className="absolute"
            style={{
              left: `${hfPct(liquidation)}%`,
              top: -3,
              bottom: -3,
              width: 2,
              background: "var(--rc-danger-fg)",
            }}
          />
          <div
            className="absolute"
            style={{
              left: `${hfPct(floor)}%`,
              top: -3,
              bottom: -3,
              width: 2,
              background: "var(--rc-accent)",
            }}
          />
        </div>
        <div
          className="mt-[5px] flex justify-between"
          style={{ fontFamily: MONO, fontSize: 10, color: "var(--rc-muted)" }}
        >
          <span style={{ color: "var(--rc-danger-fg)" }}>
            {liquidation.toFixed(2)} liquidation
          </span>
          <span style={{ color: "var(--rc-accent)" }}>{floor.toFixed(2)} your floor</span>
          <span>{HF_TOP.toFixed(2)}+</span>
        </div>
        {hfUnavailable ? (
          <p
            className="m-0 mt-[7px]"
            style={{ fontSize: 12.5, lineHeight: "18px", color: "var(--rc-warn-fg)" }}
          >
            Reading your position failed, so this value is unavailable — the figures on the
            margin page are live.
          </p>
        ) : null}
      </div>

      {summaryRows && summaryRows.length > 0 ? (
        <div
          className="mt-3.5 grid grid-cols-1 sm:grid-cols-2"
          style={{
            border: "1px solid var(--rc-line-soft)",
            borderRadius: 12,
            background: "var(--rc-inset)",
            padding: "12px 14px",
            gap: "2px 28px",
          }}
        >
          {summaryRows.map((r) => (
            <div
              key={r.k}
              className="flex items-baseline justify-between gap-3"
              style={{ padding: "6px 0", borderBottom: "1px solid var(--rc-line-soft)" }}
            >
              <span
                className="uppercase"
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  letterSpacing: ".06em",
                  color: "var(--rc-muted)",
                }}
              >
                {r.k}
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 13,
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  color: (r.tone && TONE[r.tone]) || "var(--rc-heading)",
                }}
              >
                {r.v}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {footerNote ? (
        <p
          className="m-0 mt-3"
          style={{
            border: `1px solid ${footerTone === "danger" ? "var(--rc-danger-bd)" : "var(--rc-warn-bd)"}`,
            background:
              footerTone === "danger" ? "var(--rc-danger-bg)" : "var(--rc-warn-bg)",
            borderRadius: 10,
            padding: "10px 13px",
            fontSize: 13,
            lineHeight: "19px",
            color: footerTone === "danger" ? "var(--rc-danger-fg)" : "var(--rc-warn-fg)",
            textWrap: "pretty",
          }}
        >
          {footerNote}
        </p>
      ) : null}

      {/* actions — which ones exist follows from the state, so a finished run cannot
          still be offering "Cancel" and a stopped one cannot be offering "Running…" */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
        {shape.complete ? (
          <>
            {onNewIntent ? (
              <button
                type="button"
                className="rc-btn-p"
                onClick={onNewIntent}
                style={{
                  ...btnBase,
                  border: "1px solid transparent",
                  background: "var(--rc-btn-fill)",
                  color: "var(--rc-btn-fg)",
                  padding: "13px 22px",
                  fontSize: 15,
                  fontWeight: 700,
                }}
              >
                New intent
              </button>
            ) : null}
            {onViewTx ? (
              <button
                type="button"
                className="rc-btn-s transition-colors"
                onClick={onViewTx}
                style={{
                  ...btnBase,
                  background: "transparent",
                  padding: "13px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                View on Stellar Expert ↗
              </button>
            ) : null}
          </>
        ) : shape.failed ? (
          <>
            {onRetry ? (
              <button
                type="button"
                className="rc-btn-p"
                onClick={() => onRetry(shape.failed as RunLeg)}
                disabled={busy}
                style={{
                  ...btnBase,
                  border: "1px solid transparent",
                  background: "var(--rc-btn-fill)",
                  color: "var(--rc-btn-fg)",
                  padding: "13px 22px",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: busy ? "progress" : "pointer",
                }}
              >
                Retry leg {shape.failed.n}
              </button>
            ) : null}
            {onStop ? (
              <button
                type="button"
                className="rc-btn-s transition-colors"
                onClick={onStop}
                style={{
                  ...btnBase,
                  background: "transparent",
                  padding: "13px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Stop here
              </button>
            ) : null}
          </>
        ) : (
          <>
            {/* Busy keeps the full fill and just changes its label. Greying it out here
                is what previously made a live run look broken. */}
            {busy ? (
              <button
                type="button"
                className="rc-btn-p"
                disabled
                style={{
                  ...btnBase,
                  border: "1px solid transparent",
                  background: "var(--rc-btn-fill)",
                  color: "var(--rc-btn-fg)",
                  padding: "13px 22px",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "progress",
                }}
              >
                Running…
              </button>
            ) : null}
            {onCancel && !shape.gate ? (
              <button
                type="button"
                className={busy ? "rc-btn-q transition-colors" : "rc-btn-s transition-colors"}
                onClick={onCancel}
                style={{
                  ...btnBase,
                  background: "transparent",
                  padding: busy ? "13px 12px" : "13px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Cancel run
              </button>
            ) : null}
          </>
        )}

        <span className="flex-1" />

        <span
          className="flex items-center gap-[7px]"
          style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--rc-muted)" }}
        >
          {signerLive && !shape.complete && !shape.failed ? (
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: "var(--rc-accent)",
                animation: "rc-blink 1.4s ease-in-out infinite",
              }}
            />
          ) : null}
          {signerText}
        </span>
      </div>
    </div>
  );
}
