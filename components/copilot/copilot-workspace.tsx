"use client";

// Vanna Copilot workspace — Gemini understands intent; MCP executes.
//
// Layout follows the Copilot design: a full-width intent composer, a turn card
// (agent-run → answer / staged / executed), and account health under that. Auto-approve
// sits in the header next to New chat and History.
//
// Theming: every surface/border/text colour comes from the app's own dark-aware
// tokens (`surface`, `vgray-*`, `shadow-vanna`), so the page follows the global
// light/dark toggle with no per-page theme state. The violet-tinted panels and
// venue colours the app's tokens don't invert come from the `.cp-root` scope in
// globals.css, which also re-themes the violet ramp for dark.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Loader2,
  Check,
  CircleAlert,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import {
  useMarginAccountInfoStore,
  checkUserMarginAccount,
  refreshBorrowedBalances,
  isSnapshotFeedSuppressed,
} from "@/store/margin-account-info-store";
import { setAutoApprove, useCopilotSettingsStore } from "@/store/copilot-settings";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";
import { deriveMarginHealth } from "@/lib/margin-health";
import { executeAction, isExecutable, type CopilotAction, type ExecuteResult } from "./execute";
import type { Simulation as ServerSimulation } from "@/lib/copilot/types";
import { liveUsdLabel, oracleSwapRateLabel } from "@/lib/copilot/swap-quote";
import {
  isBadSequenceError,
  isSignableXdr,
  readEnvelopeSourceSequence,
  signAndSubmitMcpXdr,
  waitForAccountSequenceApplied,
  type SignXdrResult,
} from "./sign-xdr";
import {
  hopAutoSubmitKey,
  promoteSignableAutoSignResponse,
  shouldArmAutoApprove,
  shouldAutoApproveProposedWorkflow,
  shouldSessionAutoSubmit,
  signServiceFromSessionRead,
  preserveLastConclusiveSignState,
} from "./session-auto-sign";
import {
  claimFirstAwaitingLeg,
  ledgerWaitCopy,
  hasMoreLegs,
  isUnsizedAddLiquidity,
  legsFromUnsettledSteps,
  pendingLpStepFromResume,
  farmWriteAlreadySettled,
  pruneDuplicateFarmAdds,
  pickRemainingLegs,
  shouldAutoResume,
  splitResumeBatch,
  strategyIsComplete,
} from "./resume-policy";
import { shouldPauseForHealthFloor } from "@/lib/copilot/hf-pause";
import { executionReceiptFromWorkflowView, localExecutionAnswer, singleWriteReceiptAnswer, type ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import { completionReply } from "@/lib/copilot/investigation/completion";
import { REQUESTED_ACTIONS_ID } from "@/lib/copilot/investigation/candidate-id";
import { buildRunReceipt } from "./run-receipt";
import { answerToText } from "@/lib/copilot/answer-schema";
import { shortWriteLabel } from "@/lib/copilot/execution-copy";
import { executeClientTools } from "@/lib/assistant/client-tools";
import { getPrivyAuthControls, signTransaction as signWorkflowTransaction } from "@/lib/wallet-adapter";
import { PlanApprovalCard, type PlanPreview } from "./plan-approval-card";
import { RunExecutionCard, toRunLegStatus, type RunLeg } from "./run-execution-card";
import { HealthDial } from "./health-dial";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import { PRIVY_TOKEN_HEADER } from "@/lib/copilot/identity-header";
import { VENUE_BY_OP } from "@/lib/copilot/plan-approval";
import { PLAN_TTL_MS } from "@/lib/copilot/plan-ttl";
import { claimDispatch, releaseDispatch } from "@/lib/copilot/dispatch-once";
import { lpSides } from "@/lib/copilot/lp-pair";
import { AssistantMessage, UserBubble, ChatTurns } from "./chat-message";
import { ExecutionStepper } from "./execution-stepper";
import { isUsdcVariantResolution, labelHasAmount, legKey, legKeyLoose } from "./leg-key";
import type { StructuredAnswer } from "@/lib/copilot/answer-schema";
import { useLiveInvestigation } from "@/contexts/investigation-context";
import { CopilotShell } from "./copilot-shell";
import { CopilotRailTop, CopilotRailBody, CopilotRailMini } from "./copilot-rail";
import { useCopilotEntry } from "@/hooks/use-copilot-entry";
import { useLiveWorkflow } from "@/contexts/workflow-context";
import { finished as finishedWorkflow } from "@/hooks/use-workflow";
import { InvestigationCard } from "./investigation-card";
import { ClarifyQuestionnaire } from "./clarify-questionnaire";
import { ConversationMenu } from "./conversation-menu";
import { AutoApproveMenu } from "./auto-approve-menu";
import { runIsOnEarlierTurn, shouldContinueInvestigation, shouldReplacePlan } from "@/lib/copilot/investigation/thread";

interface BrainHealth {
  status: string;
  llm_provider: string;
  mcp_mode: string;
  templates: number;
  in_process?: boolean;
  execution_mode?: string;
  /** "developer_login" means routing depends on this machine's `gcloud auth login`. */
  vertex_auth?:
    | "workload_identity"
    | "service_account"
    | "attached_service_account"
    | "developer_login";
}

interface AutoSignPrompt {
  status: "needs_confirmation" | "needs_enable";
  message: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  pending_write?: CopilotAction | null;
  /** MCP payload (e.g. default_cap_usd) — keep for UI labels, never invent caps. */
  raw?: Record<string, unknown> | null;
}

/**
 * Re-exported from the server's own definition rather than re-declared.
 *
 * This was a second, hand-maintained copy of `Simulation`, which is the same trap
 * `CopilotAction` fell into: a field added on the server (`margin_applicable`) simply did
 * not exist here, so the card could not read what the risk engine had sent. One
 * definition means a new field reaches the UI without this file being edited.
 */
type Simulation = ServerSimulation;

interface ClarifyOption {
  id: string;
  label: string;
  description?: string;
}

interface ChatResponse {
  kind:
    | "answer"
    | "clarification"
    | "unavailable"
    | "blocked"
    | "error"
    | "preview"
    | "executed"
    | "needs_auto_sign"
    | "needs_wallet_sign"
    | "needs_wallet_bind"
    | "plan_preview";
  message: string;
  /** Present on plan_preview — posted back verbatim as approved_plan. */
  plan?: PlanPreview | null;
  /** Structured read answer; `message` holds the same content as plain text. */
  answer?: StructuredAnswer | null;
  preview?: {
    template_id: string;
    human_summary: string;
    action?: CopilotAction | null;
    risk?: { decision: "allow" | "block" | "needs_confirmation"; reasons?: string[] } | null;
    simulation?: Simulation | null;
    allow_session_sign?: boolean;
  } | null;
  data?: Record<string, unknown> | null;
  intent?: { template_id?: string | null } | null;
  request_id?: string | null;
  /** Browser-only tools (navigate, open Create Vanna wallet modal, etc.). */
  client_tools?: Array<{ name: string; args: Record<string, unknown> }> | null;
  clarify_options?: ClarifyOption[] | null;
  pending_write?: {
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    /** The loan slot, independent of the collateral `asset` above. */
    borrow_asset?: string | null;
    borrow_amount?: number | null;
    /** Which asset slot a variant chip answers — see pickClarifyOption. */
    clarify_slot?: "collateral" | "borrow" | "fraction" | null;
    /** Repay share when clarify_slot is fraction (0.1 … 1). */
    fraction?: number | null;
  } | null;
  auto_sign?: AutoSignPrompt | null;
  /**
   * Present on `needs_wallet_bind`: the wallet is connected here but Vanna holds no
   * authority to sign for it server-side. Mirrors WalletBindPrompt in lib/copilot/types.
   */
  wallet_bind?: {
    status: "needs_consent" | "pending" | "bound" | "expired" | "unavailable";
    request_id?: string | null;
    /** Fallback only — the in-app consent below is the normal route. */
    connect_url?: string | null;
    /** Privy signer quorum to authorize in-app. Absent → link fallback only. */
    signer_id?: string | null;
    expires_in?: number | null;
    poll_schedule_seconds?: number[] | null;
    wallet_address?: string | null;
    retry_action?: "use_defaults" | "custom" | "disable" | null;
    max_per_tx_usd?: number | string | null;
    max_per_day_usd?: number | string | null;
  } | null;
  mcp?: {
    tool?: string | null;
    simulation_success?: boolean;
    auto_sign?: string | null;
    auto_sign_error?: string | null;
    has_unsigned_xdr?: boolean;
  } | null;
  unsigned_xdr?: string | null;
  next_step?: {
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    label?: string;
    step?: number;
    total_steps?: number;
    follow_up?: {
      op: string;
      asset?: string | null;
      amount?: number | null;
      leverage?: number | null;
      label?: string;
      step?: number;
      total_steps?: number;
    } | null;
  } | null;
  execution?: {
    status: string;
    tx_hash?: string | null;
    steps?: Array<{ tool: string; label: string; status: string; message: string }>;
  } | null;
}

/** Keep the bind panel's last actionable state when a later poll is less informative. */
export function preserveWalletBindPanelResponse(
  previous: ChatResponse | null,
  incoming: ChatResponse,
): ChatResponse {
  if (previous?.kind !== "needs_wallet_bind" || incoming.kind !== "needs_wallet_bind") {
    return incoming;
  }
  const priorBind = previous.wallet_bind;
  const nextBind = incoming.wallet_bind;
  if (
    !priorBind?.request_id ||
    !nextBind?.request_id ||
    priorBind.request_id !== nextBind.request_id
  ) {
    return incoming;
  }

  const keepTerminalReason =
    nextBind.status === "pending" &&
    (priorBind.status === "unavailable" || priorBind.status === "expired");
  const connectUrl =
    nextBind.status === "expired"
      ? (nextBind.connect_url ?? null)
      : (nextBind.connect_url ?? priorBind.connect_url);

  return {
    ...incoming,
    ...(keepTerminalReason ? { message: previous.message } : {}),
    wallet_bind: {
      ...priorBind,
      ...nextBind,
      ...(keepTerminalReason ? { status: priorBind.status } : {}),
      connect_url: connectUrl,
    },
  };
}

/**
 * Derive an actionable follow-up prompt dynamically from the rendered answer and intent.
 *
 * Rules:
 * 1. Zero hardcoded maps (no canned sentences, no invented amounts).
 * 2. Never suggest a write after a pure read (e.g. wallet balance or price).
 * 3. Never invent magic amounts (e.g. "Deposit 5 XLM" or "Borrow 2 USDC").
 * 4. Only suggest an action when grounded in the live figures of the answer or
 *    the verified amount/asset from an actionable capacity check.
 * 5. If no valid, grounded next step exists, return undefined (show none).
 */
export function followUpFor(
  answer?: StructuredAnswer | null,
  intent?: { template_id?: string | null; slots?: Record<string, unknown> } | null,
): string | undefined {
  if (!intent && !answer) return undefined;

  const slots = (intent?.slots ?? {}) as Record<string, unknown>;
  const templateId = intent?.template_id ?? "";

  // If the user performed an actionable capacity check (e.g. "Can I borrow 20 XLM?"),
  // the amount and asset come directly from their query, never invented.
  if (templateId === "query_can_borrow" || templateId === "vanna_can_borrow") {
    const amount = slots.amount;
    const symbol = slots.symbol ?? slots.asset;
    if (amount != null && amount !== "" && typeof symbol === "string" && symbol) {
      return `Borrow ${amount} ${symbol}`;
    }
  }

  // If checking debt for a single asset with a live debt figure from the answer:
  if (templateId === "query_debt" || templateId === "vanna_get_debt") {
    const symbol = slots.symbol ?? slots.asset;
    if (typeof symbol === "string" && symbol && answer?.facts) {
      const debtFact = answer.facts.find((f) =>
        /\b(?:debt|borrowed)\b/i.test(f.label),
      );
      if (debtFact) {
        const num = parseFloat(debtFact.value.replace(/,/g, ""));
        if (Number.isFinite(num) && num > 0) {
          return `Repay ${debtFact.value} ${symbol}`;
        }
      }
    }
  }

  // If checking max borrow for a single asset with a live max borrow figure:
  if (templateId === "query_max_borrow" || templateId === "vanna_get_max_borrow") {
    const symbol = slots.symbol ?? slots.asset;
    if (typeof symbol === "string" && symbol && answer?.facts) {
      const maxFact = answer.facts.find((f) =>
        /\b(?:max|headroom|available)\b/i.test(f.label),
      );
      if (maxFact) {
        const num = parseFloat(maxFact.value.replace(/,/g, ""));
        if (Number.isFinite(num) && num > 0) {
          return `Borrow ${maxFact.value} ${symbol}`;
        }
      }
    }
  }

  // Otherwise, no canned or invented follow-up
  return undefined;
}

// The surface's four status colours, as tokens rather than literals — read by ~60
// `style` values below, so a literal here is a literal sixty times.
//
// These were hex constants named for their hue (EMERALD / AMBER / IMPERIAL), and the
// hue was the problem twice over.
//
// A literal does not invert: #10b981 / #f59e0b / #703ae6 stayed at their light values
// on a #111 panel, the failure the comment above `BTN_GRADIENT` calls "a literal that
// stayed light-mode-pale".
//
// And the bright hues are not readable as text on a white card: emerald is 2.54:1,
// amber 2.15:1, imperial 3.21:1 — all three fail WCAG AA, and they were painting the
// risk-gate chips, the health-factor figure, the settled badges and ~30 other labels.
// So these now resolve to the palette's status INKS, which is what the names say now.
// Each ink is dark in light mode and bright in dark mode:
//
//   OK_INK    #0b7a63 → #3fc0a3    5.28:1 light · 7.48:1 dark
//   WARN_INK  #8a5a06 → #e0ac5c    5.92:1 light · 8.24:1 dark
//   BAD_INK   #c9333b → #f0666e    5.22:1 light · 5.50:1 dark
//   ACCENT    #703ae6 → #9a72f0    6.11:1 light · 4.87:1 dark  (already passed)
//
// That inversion is also why there is no separate "mark" colour for dots and bars.
// A 5px dot or a gauge fill wants the SAME value: on white the darker ink is more
// visible than the bright hue, and on a dark panel the ink already resolves to the
// bright hue. One value per status, correct in both themes, legible in both roles.
//
// Chip fills pair with these, at ~10% of the same hue, via `TONE_TINT`.
const OK_INK = "var(--cp-ok-fg)";
const WARN_INK = "var(--cp-warn-fg)";
const BAD_INK = "var(--cp-danger-fg)";
const ACCENT = "var(--cp-violet-500)";

/**
 * A status as MEANING, never as a colour. Everything that needs to paint a status
 * looks the colour up from this at render time.
 *
 * Both halves of that matter, and both were bugs:
 *
 * The fills used to be built as `` `${color}18` `` — an alpha byte appended to a
 * 6-digit hex. The moment a colour became `var(--cp-ok-fg)` that produced
 * `var(--cp-ok-fg)18`, which is not a colour, and the fill silently disappeared. An
 * interpolated token cannot carry alpha, so a tint has to be its own token.
 *
 * Worse, the session log PERSISTED its colour into localStorage. Stored history
 * therefore pinned whatever the palette was on the day each row was written — a
 * reader found `#10b981`, `var(--cp-emerald)` and `var(--cp-ok-fg)` side by side in
 * one store, three generations of the same "settled" green, and the oldest rows kept
 * rendering at 2.54:1 where the fix could never reach them. A tone survives a
 * palette change because it does not encode one.
 */
type Tone = "ok" | "active" | "warn" | "bad" | "muted";

const TONE_INK: Record<Tone, string> = {
  ok: OK_INK,
  active: ACCENT,
  warn: WARN_INK,
  bad: BAD_INK,
  muted: "var(--cp-g400)",
};

/** The ~10% fill that pairs with each ink. */
const TONE_TINT: Record<Tone, string> = {
  ok: "var(--cp-ok-bg)",
  active: "var(--cp-violet-soft)",
  warn: "var(--cp-warn-bg)",
  bad: "var(--cp-danger-bg)",
  muted: "var(--cp-g50)",
};

function truncAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function truncHash(h: string | null | undefined): string {
  if (!h) return "—";
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}
function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function prettyKey(k: string): string {
  return k.replace(/_pct$/, " %").replace(/_usd$/, " (USD)").replace(/_human$/, "").replace(/_/g, " ").trim();
}

/** Drop markdown bold/italics so the chat never shows **BLUSDC** stars. */
function stripMarkdownLite(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
function prettyVal(v: unknown): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const s = String(v);
  const n = Number(s);
  if (s !== "" && !Number.isNaN(n) && Math.abs(n) < 1e15) {
    /**
     * Group the integer part for readability, but never round away real precision
     * the source string carried. The readable answer above this card already shows
     * a rounded figure (see `listPositionRows` in handle.ts) — this facts card is
     * where the exact on-chain amount belongs, e.g. a position's "1228.8656935"
     * rather than a lossy "1,228.8657".
     */
    const dot = s.indexOf(".");
    const fracDigits = dot === -1 ? 0 : s.length - dot - 1;
    if (fracDigits > 4) {
      const intPart = s.slice(0, dot);
      const fracPart = s.slice(dot + 1);
      const groupedInt = Number(intPart).toLocaleString(undefined, { maximumFractionDigits: 0 });
      return `${groupedInt}.${fracPart}`;
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return s;
}
/** Health factor → gauge fill. 3.00+ tops the bar, so 1.00 sits at 33.3%. */
function hfPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "0%";
  return `${Math.max(2, Math.min(100, (v / 3) * 100))}%`;
}
function hfColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return OK_INK;
  if (v >= 1.5) return OK_INK;
  if (v >= 1.3) return WARN_INK;
  return BAD_INK;
}
function fmtHf(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "∞";
  return v >= 999 ? "∞" : v.toFixed(2);
}
function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function txUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

/** Key the liquidation guardian stores the user's "keep HF above X" floor under. */
const GUARDIAN_FLOOR_KEY = "vanna_copilot_guardian_min_hf";
/**
 * The floor the guardian actually enforces. Shared with the run card's meter so the tick
 * labelled "your floor" and the level that triggers an auto-repay cannot disagree.
 */
function readGuardianFloor(): number {
  try {
    const raw = localStorage.getItem(GUARDIAN_FLOOR_KEY);
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : 1.3;
  } catch {
    return 1.3;
  }
}

/** Key the auto-sign spend caps the user last confirmed are stored under. */
const AUTO_CAPS_KEY = "vanna_copilot_auto_caps";
/**
 * The caps the Autonomy card reports. Read through one function so the summary chip and
 * the value written after MCP replies cannot drift apart — brief §6.5: two numbers about
 * the same thing must never disagree.
 */
function readAutoCaps(): { tx: number; day: number } | null {
  try {
    const raw = localStorage.getItem(AUTO_CAPS_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { max_per_tx_usd?: number; max_per_day_usd?: number };
    const tx = Number(c.max_per_tx_usd);
    const day = Number(c.max_per_day_usd);
    if (!Number.isFinite(tx) || tx <= 0) return null;
    return { tx, day: Number.isFinite(day) && day > 0 ? day : tx };
  } catch {
    return null;
  }
}

/**
 * Default vs custom spend caps. The default figure is owned by MCP and only
 * reported after enable — this UI must not print a dollar amount before that.
 */
interface LogLeg {
  label: string;
  tool: string;
  status: string;
}

interface LogEntry {
  id: string;
  prompt: string;
  tool: string;
  status: string;
  /**
   * Optional because this is PERSISTED data and rows written before the palette work
   * carry a `color` hex instead — see `entryTone`, which recovers the tone from
   * `status` so an old row picks up the current palette rather than staying frozen in
   * whatever the colours were the day it was written.
   */
  tone?: Tone;
  /** When the turn was recorded. Absent on rows stored before history was persisted. */
  ts?: number;
  /** Multi-leg / agent-chain parent — child hops update this instead of new rows. */
  strategy?: boolean;
  legs?: LogLeg[];
}

/**
 * How many turns the copilot remembers.
 *
 * The log used to hold 8 and live in component state, so it was gone on reload — which is
 * why history had to be added rather than merely surfaced. 40 is enough to cover a working
 * session without the stored blob getting large.
 */
const HISTORY_MAX = 40;

/** localStorage key. Per wallet, because the turns are about that wallet's account. */
const historyKey = (address: string) => `vanna_copilot_history:${address}`;

/**
 * The tone of a stored row. `status` is persisted and carries the same meaning, so a
 * row written before tones existed needs no migration — it just resolves through here
 * and paints with today's palette.
 *
 * The one thing `status` cannot recover on its own is which flavour of "in progress" a
 * strategy is in, so rows that care set `tone` explicitly and this only fills the gap.
 */
function toneFromStatus(status: string): Tone {
  if (status === "executed" || status === "answered") return "ok";
  if (status === "blocked" || status === "error") return "bad";
  if (status === "staged" || status === "needs sign") return "active";
  return "warn";
}
const entryTone = (e: LogEntry): Tone => e.tone ?? toneFromStatus(e.status);
interface ActivityEntry {
  label: string;
  hash: string;
  ts: number;
}
interface Step {
  label: string;
  detail: string;
  state: "done" | "active" | "pending";
}

/**
 * The label above each block of the page.
 *
 * These are headings, and they render as headings: the Assistant builds its picture of
 * the page from h1/h2/h3, so as paragraphs they were invisible to it — asked what this
 * page was, it saw one heading ("Vanna Copilot") and a wall of undifferentiated text,
 * and had nothing to scroll to. `as="p"` is for the kicker above the h1, which labels
 * the page rather than a section within it.
 */
function Eyebrow({
  n,
  as: Tag = "h2",
  children,
}: {
  n?: string;
  as?: "h2" | "p";
  children: React.ReactNode;
}) {
  /**
   * Sentence case, the page's own face, no tracking: an all-caps monospace eyebrow with a
   * middle dot is the commonest tell of a generated page, and it made every panel label
   * look like a data readout. The stage number stays where the panels are a sequence.
   */
  const text = typeof children === "string" ? children.charAt(0).toUpperCase() + children.slice(1) : children;
  return (
    <Tag className="text-[12px] font-semibold text-vgray-500">
      {n ? <span className="mr-1.5 tabular-nums text-violet-500">{n.replace(/^0/, "")}</span> : null}
      {text}
    </Tag>
  );
}

/** Mono key → value row; the repeating unit of every panel in the right rail. */
/**
 * Middle-truncate a value that cannot wrap usefully.
 *
 * A 56-character Stellar address has no natural break point, so it ran straight through
 * the next grid column. Both ends carry the information people actually check, so the
 * middle is what goes; the full value stays in `title` and remains selectable.
 */
/**
 * A full protocol address or tx hash — the values whose whole point is being checkable.
 *
 * Stellar addresses are exactly 56 base32 chars; hashes are 64 hex. Matched precisely so
 * an ordinary long string in a fact value is not laid out as an identifier.
 */
function isFullIdentifier(s: string): boolean {
  return /^[GC][A-Z2-7]{55}$/.test(s) || /^[0-9a-f]{64}$/i.test(s);
}

function shortenValue(v: string): { text: string; full: string | null } {
  const s = v.trim();
  // Long hex that is NOT a 64-char hash (XDR fragments) still gets shortened — nobody
  // verifies an envelope by eye.
  if (!isFullIdentifier(s) && s.length > 34 && /^[0-9a-fA-F]{34,}$/.test(s)) {
    return { text: `${s.slice(0, 10)}…${s.slice(-6)}`, full: s };
  }
  return { text: s, full: null };
}

/**
 * One fact row.
 *
 * A full identifier gets a STACKED row — label above, complete value below, wrapping on
 * `break-all` — because "is this the right contract?" is the only question anyone asks of
 * a protocol address, and `CBBQQULN…5LDXUO` cannot answer it. Callers that genuinely want
 * a compact chip (the wallet pill, a tx-hash receipt) pass an already-shortened string via
 * `truncAddr` / `truncHash`, so they are unaffected.
 */
/**
 * Would the compact side-by-side layout below clip this value?
 *
 * `truncate` (overflow-hidden + ellipsis) was applied to every non-identifier value
 * unconditionally, so a full sentence like a swap's "Swap 10 XLM for at least 1.234
 * SOUSDC (min received after slippage)" silently lost everything past the fold —
 * reported live, more than once, as "half message in summary". A fixed character
 * count is a real, generalized threshold here (not a per-instance patch): anything
 * this long cannot fit a value column beside a label and was never going to, whatever
 * the specific sentence.
 */
const ROW_WRAP_THRESHOLD = 40;

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  const { text, full } = shortenValue(v);
  const ident = isFullIdentifier(text);
  const longProse = !ident && text.length > ROW_WRAP_THRESHOLD;

  if (ident || longProse) {
    return (
      <div className="border-b border-vgray-100 py-2 last:border-0">
        <span className="block font-mono text-[11px] uppercase tracking-wider text-vgray-400">
          {k}
        </span>
        <span
          className={
            ident
              ? "mt-1 block select-all font-mono text-[12px] leading-[17px] text-vgray-900"
              : "mt-1 block font-mono text-[12px] leading-[17px] text-vgray-900"
          }
          style={{ wordBreak: ident ? "break-all" : "break-word", ...(color ? { color } : {}) }}
        >
          {text}
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-baseline justify-between gap-3 border-b border-vgray-100 py-2 last:border-0"
      /**
       * A long key takes the whole row rather than half of it.
       *
       * FactsGrid is a two-column grid and this label is `shrink-0`, so
       * "COLLATERAL LEFT BEFORE LIQUIDATION" filled its half-width cell, ran into the next
       * column's label, and squeezed its own figure down to "1…" — the number the row exists
       * to show. Spanning both columns is cheaper than truncating the value or shattering the
       * label, which are the two failures this surface already fixed once elsewhere.
       */
      style={{ gridColumn: k.length > 22 ? "1 / -1" : undefined }}
    >
      <span className="min-w-0 shrink-0 font-mono text-[11px] uppercase tracking-wider text-vgray-400">
        {k}
      </span>
      <span
        className="min-w-0 truncate font-mono text-[13px] text-vgray-900"
        style={color ? { color } : undefined}
        title={full ?? undefined}
      >
        {text}
      </span>
    </div>
  );
}

/**
 * Short pause after the previous leg is confirmed and its sequence is visible.
 * Sequence wait does the real work; this is just a small buffer for MCP/Horizon.
 */
const CHAIN_DELAY_MS = 1200;

/** Fresh HF from the margin store after a rail refresh — not a React-closure snapshot. */
function readLiveHfFromStore(): number | null {
  const store = useMarginAccountInfoStore.getState();
  if (!store.hasMarginAccount) return null;
  const gross = store.grossCollateralValue ?? 0;
  const debt = store.totalBorrowedValue ?? 0;
  const derived = deriveMarginHealth({
    grossCollateralValue: gross,
    effectiveDebtValue: debt > 0.01 ? debt : 0,
    totalBorrowedValue: debt,
  });
  const hf = derived.avgHealthFactor;
  return Number.isFinite(hf) && hf > 0 ? hf : null;
}

/**
 * Button surfaces from the design: 8px for inline actions, 12px for the commit row.
 *
 * Hover is the violet tint, never a grey. The tint re-themes itself in dark through the
 * `.cp-root` violet ramp, so one class works on both surfaces; the grey it replaced was
 * a literal that stayed light-mode-pale on a #111 panel.
 */
const BTN_QUIET =
  "rounded-r2 border border-vgray-100 bg-transparent text-[13px] font-semibold text-vgray-800 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500 " +
  "disabled:cursor-not-allowed disabled:text-vgray-300 disabled:hover:border-vgray-100 disabled:hover:bg-transparent disabled:hover:text-vgray-300";
const BTN_TINT =
  "rounded-r2 border border-violet-50 bg-violet-50 text-[13px] font-semibold text-violet-500 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50";
/**
 * Secondary action sitting ON a violet-tinted panel (the auto-sign gate).
 *
 * BTN_QUIET is transparent with a violet-50 hover, which is the panel's own colour — on that
 * panel it had no edge and no hover, so "Custom limits" read as a label rather than a button.
 * This one carries the page surface, so it looks raised against the tint in both themes.
 */
const BTN_ON_TINT =
  "rounded-r2 border border-violet-100 bg-surface text-[13px] font-semibold text-vgray-900 transition-colors hover:border-violet-400 hover:text-violet-500 " +
  "disabled:cursor-not-allowed disabled:text-vgray-300";
/**
 * Disabled drops the gradient rather than fading it. A translucent gradient over a dark
 * panel is a muddy brown-violet that reads as a rendering fault, not as "not yet" — the
 * plan card already solves this by swapping to flat grey, and this matches it.
 */
/**
 * Primary action button.
 *
 * The disabled state used to strip the gradient (`disabled:bg-none`) and repaint the
 * button grey with grey text. In dark mode that grey sat almost exactly on the surface
 * colour, so Run looked broken rather than idle — and in light mode it read as
 * permanently unavailable. The design keeps the gradient in every state; a disabled
 * control should look *quiet*, not absent, so it now just loses some opacity and keeps
 * white text, which stays legible against the gradient in both themes.
 */
const BTN_GRADIENT =
  "rounded-r2 bg-gradient text-[13px] font-semibold text-white transition-opacity hover:opacity-90 " +
  "disabled:cursor-not-allowed disabled:opacity-45";

const RISK_TONE = {
  allow: { label: "risk gate · allow", tone: "ok" },
  needs_confirmation: { label: "risk gate · confirm", tone: "warn" },
  block: { label: "risk gate · blocked", tone: "bad" },
} as const satisfies Record<string, { label: string; tone: Tone }>;

function RiskChip({ decision }: { decision: keyof typeof RISK_TONE }) {
  const { label, tone } = RISK_TONE[decision];
  return (
    <span
      className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em]"
      style={{ color: TONE_INK[tone], background: TONE_TINT[tone] }}
    >
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: TONE_INK[tone] }} />
      {label}
    </span>
  );
}

/** The agent-run trace: one line per stage of the turn, with the tool that ran. */
function StepList({ steps, running }: { steps: Step[]; running: boolean }) {
  const complete = steps.filter((step) => step.state === "done").length;
  const active = steps.find((step) => step.state === "active");
  return (
    <p className="mt-3 flex items-center gap-2 text-[13px] leading-[20px] text-vgray-500" role={running ? "status" : undefined}>
      {running ? <Loader2 size={14} className="shrink-0 animate-spin text-violet-500" /> : <Check size={14} className="shrink-0 text-vgray-400" />}
      {running ? (active?.label || "Working…") : `Checked ${complete || steps.length} reads`}
    </p>
  );
}

/**
 * A leg as the server sends it. `multiLegUiData` spreads the whole MultiLegStep, so
 * op/asset/amount arrive too — declared here rather than cast at each use site, because
 * the run card badges legs by `op` and getting that wrong mislabels the venue.
 * `index` is 1-based (handle.ts increments before assigning).
 */
type MultiLegStepUi = {
  index?: number;
  op?: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label?: string;
  status?: string;
  tx_hash?: string | null;
  hf_after?: number | null;
  message?: string;
  /** A swap leg's destination — see RunLeg.tokenOut for why this is carried. */
  token_in?: string | null;
  token_out?: string | null;
  token_a?: string | null;
  token_b?: string | null;
};

type ResumeLeg = {
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label?: string;
  /** A swap leg's destination — carried so a resume replays or corrects it. */
  token_in?: string | null;
  token_out?: string | null;
  token_a?: string | null;
  token_b?: string | null;
  amount_a?: number | null;
  amount_b?: number | null;
};

/** Structured multi-leg strategy card (replaces red wall of text + facts dump). */
function MultiLegStrategyCard({
  data,
  steps: stepsProp,
  headline,
  onResume,
  resumeBusy,
  autoContinues = false,
}: {
  data: Record<string, unknown>;
  /**
   * Accumulated legs across hops (workspace merge via legKey). Prefer this over
   * data.multi_leg_steps, which only contains the current hop.
   */
  steps?: MultiLegStepUi[] | null;
  headline?: string | null;
  onResume?: (legs: ResumeLeg[], summary: string) => void;
  resumeBusy?: boolean;
  /** Auto-approve will continue the chain, so no manual button is offered. */
  autoContinues?: boolean;
}) {
  const fromData = (Array.isArray(data.multi_leg_steps) ? data.multi_leg_steps : []) as MultiLegStepUi[];
  const steps = stepsProp?.length ? stepsProp : fromData;
  if (!steps.length) return null;

  const summary = String(data.strategy_summary || data.plan_summary || "Strategy");
  const minHf = data.min_hf != null ? Number(data.min_hf) : null;
  const finalHf = data.final_hf != null ? Number(data.final_hf) : null;
  const sa = data.smart_account != null ? String(data.smart_account) : null;
  const rawTitle = String(data.headline || headline || "Strategy progress");
  const resumeLegs = (Array.isArray(data.resume_legs) ? data.resume_legs : []) as ResumeLeg[];
  // With auto-approve on, the chain effect continues by itself, so offering a button
  // alongside it invited a double-run and made the card look stalled when it was not.
  const canResume =
    data.can_resume === true && resumeLegs.length > 0 && !!onResume && !autoContinues;

  const anyFail = steps.some((s) =>
    ["error", "blocked", "stopped_hf"].includes(String(s.status || "")),
  );
  const allOk = steps.every((s) => {
    const st = String(s.status || "");
    return st === "ok" || st === "done" || st === "skipped";
  }) && steps.some((s) => {
    const st = String(s.status || "");
    return st === "ok" || st === "done";
  });

  /**
   * Title derived from the card's OWN steps, not from the server headline.
   *
   * The headline is written per hop and describes that hop's moment. Once the client
   * signed the final leg it was never refreshed, so a card whose every step read "done"
   * still announced "Paused for signature — finish signing to continue", and the session
   * log said executed while the card asked for a signature that had already happened.
   *
   * A card can always see its own step list, so it decides from that: nothing here can
   * claim to be waiting while every step says done, whatever arrives in the payload.
   */
  const title = allOk
    ? "All steps completed — strategy is live."
    : anyFail
      ? rawTitle
      : /paused for signature|finish signing/i.test(rawTitle)
        ? autoContinues
          ? "Waiting for auto-sign — your session key is signing this leg."
          : "Needs your signature — approve in your wallet to continue."
        : rawTitle;

  const tone = (status?: string): Tone => {
    if (status === "ok" || status === "done") return "ok";
    if (
      status === "needs_sign" ||
      status === "needs_wallet_sign" ||
      status === "staged" ||
      status === "pending" ||
      status === "clarification"
    )
      return "warn";
    if (status === "error" || status === "blocked" || status === "stopped_hf") return "bad";
    return "muted";
  };
  const mark = (status?: string) => {
    // Never show SIGN on completed legs — only while that leg still needs a signature.
    if (status === "ok" || status === "done") return "Done";
    if (status === "needs_sign" || status === "needs_wallet_sign" || status === "staged") return "Sign";
    if (status === "stopped_hf") return "HF";
    if (status === "skipped") return "Skip";
    if (status === "pending") return "Next";
    if (status === "clarification") return "Ask";
    if (status === "blocked") return "Block";
    if (status === "error") return "Fail";
    return "·";
  };

  // Outcome tints. These were fixed rgba() of the light-mode hues, so on a dark panel
  // a settled strategy was outlined in light-mode green. The tokens invert; the border
  // lands on the palette's standard 30% and the wash on its 10%, up from a hand-picked
  // 35%/6% that only ever existed in light.
  const borderColor = allOk
    ? "var(--cp-ok-bd)"
    : anyFail
      ? "var(--cp-danger-bd)"
      : "var(--color-vgray-100)";

  return (
    <div
      className="mt-4 overflow-hidden rounded-2xl border bg-surface"
      style={{ borderColor }}
    >
      <div
        className="border-b px-5 py-4"
        style={{
          borderColor: "var(--color-vgray-100)",
          background: allOk
            ? "var(--cp-ok-bg)"
            : anyFail
              ? "var(--cp-danger-bg)"
              : "var(--color-vgray-50)",
        }}
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-vgray-400">
          multi-step strategy
        </p>
        <p className="mt-1.5 text-[17px] font-semibold leading-snug text-vgray-900">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-vgray-500">{summary}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {sa && (
            <span className="rounded-full border border-vgray-100 bg-surface px-2.5 py-1 font-mono text-[11px] text-vgray-500">
              {sa.slice(0, 8)}…{sa.slice(-4)}
            </span>
          )}
          {minHf != null && Number.isFinite(minHf) && (
            <span className="rounded-full border border-vgray-100 bg-surface px-2.5 py-1 font-mono text-[11px] text-vgray-500">
              HF floor ≥ {minHf}
            </span>
          )}
          {finalHf != null && Number.isFinite(finalHf) && (
            <span className="rounded-full border border-vgray-100 bg-surface px-2.5 py-1 font-mono text-[11px] text-vgray-500">
              Final HF {finalHf >= 999 ? "∞" : finalHf.toFixed(2)}
            </span>
          )}
        </div>
      </div>

      <ol className="divide-y divide-vgray-100 px-2 py-1 sm:px-3">
        {steps.map((s, i) => {
          const st = String(s.status || "");
          const isOk = st === "ok" || st === "done";
          // XDR byte counts / "do not invent a hash" are model instructions — only show
          // messages that explain a real failure.
          const showDetail =
            !!s.message &&
            (st === "error" || st === "blocked" || st === "stopped_hf");
          return (
            <li key={`${legKey(String(s.label || ""))}-${s.index ?? i}`} className="flex gap-3 px-3 py-3.5">
              <span
                className="mt-0.5 flex h-6 min-w-[3.25rem] shrink-0 items-center justify-center rounded-full px-2 font-mono text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  color: TONE_INK[tone(isOk ? "ok" : st)],
                  background: TONE_TINT[tone(isOk ? "ok" : st)],
                }}
              >
                {mark(st)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-snug text-vgray-900">
                  <span className="mr-1.5 font-mono text-[11px] font-normal text-vgray-400">
                    {s.index ?? i + 1}.
                  </span>
                  {s.label || `Step ${i + 1}`}
                </p>
                {s.tx_hash && (
                  <p className="mt-0.5 font-mono text-[11px] text-vgray-400">
                    tx {s.tx_hash.slice(0, 12)}…
                  </p>
                )}
                {s.hf_after != null && Number.isFinite(s.hf_after) && (
                  <p className="mt-0.5 font-mono text-[11px] text-vgray-500">
                    HF ≈ {s.hf_after >= 999 ? "∞" : s.hf_after.toFixed(2)}
                  </p>
                )}
                {showDetail && (
                  <p
                    className="mt-1.5 text-[12.5px] leading-snug"
                    style={{ color: st === "error" || st === "blocked" ? BAD_INK : "var(--color-vgray-500)" }}
                  >
                    {s.message}
                  </p>
                )}
                {st === "skipped" && (
                  <p className="mt-1 text-[12px] text-vgray-400">Not run</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="border-t border-vgray-100 px-5 py-3">
        {/* Spinner only while legs remain incomplete — never under fully done strategies. */}
        <p className="flex items-center gap-2 text-[12px] leading-relaxed text-vgray-500">
          {allOk ? (
            "All steps completed on-chain."
          ) : anyFail ? (
            "Stopped early. Only steps marked Done are on-chain — nothing later was claimed as done."
          ) : (
            <>
              <Loader2 size={13} className="shrink-0 animate-spin text-violet-500" />
              {autoContinues
                ? "Running the next step — signing with your session key."
                : "In progress or waiting on the next action."}
            </>
          )}
        </p>
        {canResume && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={resumeBusy}
              onClick={() =>
                onResume?.(
                  resumeLegs,
                  `Continue: ${summary}`.slice(0, 120),
                )
              }
              className="rounded-r2 bg-gradient px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {resumeBusy ? "Resuming…" : `Continue remaining (${resumeLegs.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function isMultiLegResponse(data?: Record<string, unknown> | null): boolean {
  return !!(data && (data.multi_leg === true || Array.isArray(data.multi_leg_steps)));
}

function isRealStrategyRun(
  steps: Array<{ op?: string }> | null | undefined,
  data?: Record<string, unknown> | null,
): boolean {
  if (data?.asset_setup === true) return false;
  const rawSteps = steps && steps.length > 0
    ? steps
    : Array.isArray(data?.multi_leg_steps)
      ? (data!.multi_leg_steps as Array<{ op?: string }>)
      : [];
  const nonSetupOps = rawSteps.filter(
    (s) => s.op && s.op !== "ensure_asset_setup" && s.op !== "asset_setup" && s.op !== "report",
  );
  if (rawSteps.length > 0) {
    return nonSetupOps.length > 1;
  }
  return data?.multi_leg === true && ((data?.remaining_legs != null) || ((data?.total_steps as number) ?? 0) > 1);
}

/**
 * Whether a resume hop response means "this leg was accepted by the server and
 * we may advance the client queue to the next leg".
 *
 * Only advance after a real hop lands: staged for signature, already executed,
 * auto-sign gate, or wallet-bind. error / blocked / plain answer mean the leg
 * did not run — keep the full remaining queue for retry.
 */
function isChainableHopResponse(
  hop: Pick<ChatResponse, "kind"> | null | undefined,
): boolean {
  if (!hop) return false;
  return (
    hop.kind === "executed" ||
    hop.kind === "needs_wallet_sign" ||
    hop.kind === "needs_auto_sign" ||
    hop.kind === "needs_wallet_bind"
  );
}

/**
 * Executed write receipt: live fill rate when we have one (DEX swap) + full tx hash.
 * Shown for every on-chain write — not only swaps — so remove-LP etc. are checkable.
 */
function ExecutedTxReceipt({
  action,
  txHash,
}: {
  action?: CopilotAction | null;
  txHash: string | null;
}) {
  const [usdLabel, setUsdLabel] = useState<string | null>(null);

  useEffect(() => {
    const amount = Number(action?.amount);
    const asset = String(action?.asset || action?.token_b || "").trim();
    if (!(amount > 0) || !asset) {
      setUsdLabel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [{ fetchTokenPrices, getCachedTokenPrice }, { oraclePriceSymbol }] = await Promise.all([
        import("@/lib/oracle-price"),
        import("@/lib/copilot/leverage-plan"),
      ]);
      if (action?.op === "swap") {
        const tokenIn = String(action.asset || action.token_a || "XLM");
        const tokenOut = String(action.token_b || "");
        const feeds = [oraclePriceSymbol(tokenIn), oraclePriceSymbol(tokenOut)];
        await fetchTokenPrices(feeds);
        if (cancelled) return;
        setUsdLabel(
          oracleSwapRateLabel(
            tokenIn,
            tokenOut,
            getCachedTokenPrice(feeds[0]),
            getCachedTokenPrice(feeds[1]),
          ),
        );
        return;
      }
      const feed = oraclePriceSymbol(asset);
      await fetchTokenPrices([feed]);
      if (cancelled) return;
      setUsdLabel(liveUsdLabel(amount, asset, getCachedTokenPrice(feed)));
    })();
    return () => {
      cancelled = true;
    };
  }, [action?.amount, action?.asset, action?.token_a, action?.token_b, action?.op]);

  if (!usdLabel && !txHash) return null;
  return (
    <div className="mt-[18px] grid w-full grid-cols-1 gap-x-8 rounded-2xl border border-vgray-100 bg-vgray-50 px-5 py-4">
      {usdLabel ? <Row k="live price" v={usdLabel} /> : null}
      {txHash ? <Row k="tx hash" v={txHash} /> : null}
    </div>
  );
}

function SwapOracleRateLine({ tokenIn, tokenOut }: { tokenIn: string; tokenOut: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!tokenIn || !tokenOut) {
      setLabel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [{ fetchTokenPrices, getCachedTokenPrice }, { oraclePriceSymbol }] = await Promise.all([
        import("@/lib/oracle-price"),
        import("@/lib/copilot/leverage-plan"),
      ]);
      const feeds = [oraclePriceSymbol(tokenIn), oraclePriceSymbol(tokenOut)];
      await fetchTokenPrices(feeds);
      if (cancelled) return;
      setLabel(
        oracleSwapRateLabel(
          tokenIn,
          tokenOut,
          getCachedTokenPrice(feeds[0]),
          getCachedTokenPrice(feeds[1]),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenIn, tokenOut]);
  if (!label) return null;
  return (
    <p className="m-0 mt-2 font-mono text-[15px] leading-6 text-vgray-800">{label}</p>
  );
}

/**
 * Supporting figures for a response.
 *
 * `shown` carries the values the structured answer above has ALREADY rendered. Without it
 * the same six protocol addresses appeared twice on one card — once as answer rows, once
 * again here — which reads as two lists that might disagree rather than one fact stated
 * once. Matched on VALUE, not label: the answer says "REGISTRY" where the payload key is
 * `registry`, and an address is unique enough that value equality is the reliable join.
 */
function FactsGrid({
  data,
  shown,
}: {
  data: Record<string, unknown>;
  shown?: ReadonlySet<string>;
}) {
  const skipKeys = new Set([
    "unsigned_xdr",
    "auth_entries",
    "multi_leg_steps",
    "expanded_legs",
    "remaining_legs",
    "multi_leg_agent",
    "plan_summary",
    // Multi-leg bookkeeping. It rendered a panel of MULTI LEG / STRATEGY SUMMARY /
    // CAN RESUME / TOTAL / PCT / PATTERN / PREFER RESUME MULTI LEG next to the step
    // list that already says all of it more clearly. Internal orchestration state is
    // not information the user needs to act on.
    "multi_leg",
    "strategy_summary",
    "can_resume",
    "resume_legs",
    "total",
    "pct",
    "done",
    "pattern",
    "prefer_resume_multi_leg",
    "headline",
    "min_hf",
    "final_hf",
    "hf_stopped",
    "all_legs_ok",
    // The user's own smart account address, echoed back at them on every turn. It is
    // already in the right-hand rail, and a 56-character C-address earns its space only
    // where it can be acted on.
    "smart_account",
    "smartAccount",
    /**
     * Reported live on an executed receipt: `status` repeated the "02 · Agent run"
     * timeline's own last step verbatim ("Signed & submitted · signed_and_submitted"),
     * `amount_stroops` is the same amount the headline already states, just in the raw
     * on-chain integer unit, and `session_id` is internal bookkeeping nobody acts on.
     * `final_status`/`tx_hash` are what is left, and are what actually answer "did it
     * work and what do I check it against". The server (`factsForUi`, explain.ts) sends
     * keys already humanized to spaces ("tx hash", not "tx_hash") — both spellings are
     * listed since this grid is also handed raw, un-humanized data on some paths.
     */
    "status",
    "amount_stroops",
    "amount stroops",
    "session_id",
    "session id",
    "summary",
    "note",
  ]);
  const already = (val: string) => !!shown && shown.has(val.trim());
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === "" || skipKeys.has(k)) continue;
    if (typeof v === "object") {
      if (Array.isArray(v)) continue;
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv == null || typeof sv === "object") continue;
        const pv = prettyVal(sv);
        if (already(pv)) continue;
        rows.push([prettyKey(sk), pv]);
      }
    } else {
      const pv = prettyVal(v);
      if (already(pv)) continue;
      rows.push([prettyKey(k), pv]);
    }
  }
  if (!rows.length) return null;
  return (
    <div className="mt-[18px] grid w-full grid-cols-1 gap-x-8 border-t border-vgray-100 pt-3 sm:grid-cols-2">
      {/*
       * Reported live: "give my margin account collateral" on a 6-asset account (6
       * summary figures + 6 per-asset amounts = 12 rows) silently lost the two
       * lowest-value assets — this cap cut them with no sign anything was missing, the
       * same class of silent-drop bug already fixed server-side in `factsForUi`
       * (lib/copilot/explain.ts). Raised well past any real account's own asset count
       * (currently ~10 assets, doubled worst-case across collateral + debt) while still
       * bounding a genuinely oversized/unrelated MCP payload.
       */}
      {rows.slice(0, 40).map(([k, v], i) => (
        <Row key={i} k={k} v={v} />
      ))}
    </div>
  );
}

/**
 * Project the served simulation onto the account the user is actually looking at.
 *
 * The server builds a simulation from a snapshot it takes when the card is built. After a
 * transaction settles that snapshot is a lap behind: a withdraw card opened at "49.41 →
 * 54.22" while the rail beside it already read 59.40, and the borrow card before it had
 * finished at 51.36 against a rail of 51.31. Two health factors on one screen, both
 * presented as current.
 *
 * What the simulation contributes is the EFFECT of the action — the collateral and debt
 * deltas — which is the part the client cannot compute. The baseline is the account state,
 * and there is exactly one of those on this page: the store the rail renders from. So the
 * deltas are re-applied to the live figures and the health factor is recomputed with
 * `deriveMarginHealth`, the same function the rail uses, which is what makes the two
 * numbers incapable of disagreeing.
 *
 * Falls back to the served simulation whenever the store has no funded account to rebase
 * onto — an unconnected wallet, or a first paint before the snapshot lands.
 */
function rebaseSimulationOnLiveAccount(sim: Simulation): Simulation {
  // An op that never touches margin has a deliberately empty baseline and its own
  // message; giving it live collateral would turn "None" into a full no-op projection.
  if (sim.margin_applicable === false) return sim;
  const store = useMarginAccountInfoStore.getState();
  if (!store.hasMarginAccount) return sim;
  const gross = store.grossCollateralValue ?? 0;
  const debt = store.totalBorrowedValue ?? 0;
  if (!(gross > 0) && !(debt > 0)) return sim;
  if (!Number.isFinite(sim.collateral_before) || !Number.isFinite(sim.debt_before)) return sim;

  const dCollateral = sim.collateral_after - sim.collateral_before;
  const dDebt = sim.debt_after - sim.debt_before;
  if (!Number.isFinite(dCollateral) || !Number.isFinite(dDebt)) return sim;

  const collateralAfter = Math.max(0, gross + dCollateral);
  const debtAfter = Math.max(0, debt + dDebt);
  const hf = (collateral: number, owed: number): number | null => {
    if (!(owed > 0.01)) return null;
    const derived = deriveMarginHealth({
      grossCollateralValue: collateral,
      effectiveDebtValue: owed,
      totalBorrowedValue: owed,
    });
    return Number.isFinite(derived.avgHealthFactor) ? derived.avgHealthFactor : null;
  };

  return {
    ...sim,
    collateral_before: gross,
    collateral_after: collateralAfter,
    debt_before: debt,
    debt_after: debtAfter,
    hf_before: hf(gross, debt),
    hf_after: hf(collateralAfter, debtAfter),
    ltv_before: gross > 0 ? debt / gross : 0,
    ltv_after: collateralAfter > 0 ? debtAfter / collateralAfter : 0,
  };
}

/**
 * Before→after projection for a staged write. Informational: the binding gates
 * run in the MCP server and the Sign Service, so this panel only appears when
 * the brain managed to read the account and project the impact.
 */
function ImpactPanel({ sim: served }: { sim: Simulation }) {
  const sim = rebaseSimulationOnLiveAccount(served);
  const after = sim.hf_after;
  const color = hfColor(after);
  const rows: Array<{ k: string; before: string; after: string }> = [
    { k: "collateral", before: usd(sim.collateral_before), after: usd(sim.collateral_after) },
    { k: "debt", before: usd(sim.debt_before), after: usd(sim.debt_after) },
  ];

  // A zeroed baseline means the account read failed, not that the position is empty —
  // the two are indistinguishable in this payload. Rendering it drew a full panel of
  // "$0.00 → $0.00" and "∞ → ∞" beside a funded account, which reads as a real
  // projection of nothing happening. Say what we know instead of drawing a false one.
  const noBaseline =
    !(Number.isFinite(sim.collateral_before) && sim.collateral_before > 0) &&
    !(sim.hf_before != null && Number.isFinite(sim.hf_before) && sim.hf_before > 0);
  if (noBaseline) {
    /**
     * An empty baseline has TWO causes and they need different sentences.
     *
     * `margin_applicable: false` means the op never touches margin — an Earn supply or
     * redeem moves wallet tokens and leaves collateral and debt untouched. Saying "reading
     * your current position failed" there reports a failure that did not occur, on a card
     * whose margin numbers were correct moments before. Only a genuinely absent baseline
     * keeps the original wording.
     */
    const notApplicable = sim.margin_applicable === false;
    return (
      <div className="mt-[18px] rounded-2xl border border-vgray-100 bg-vgray-50 px-5 py-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-violet-500">
          projected impact
        </p>
        <p className="text-[13px] leading-[19px] text-vgray-500">
          {notApplicable
            ? "None — this moves tokens in your wallet and doesn't touch your margin account, so your collateral, debt and health factor are unchanged."
            : "Not available — reading your current position failed, so there is no baseline to project from. Your live figures are on the margin page."}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-[18px] rounded-2xl border border-vgray-100 bg-vgray-50 p-5">
      <p className="mb-3.5 font-mono text-[10px] uppercase tracking-[0.2em] text-violet-500">projected impact</p>

      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">health factor</span>
        <span className="flex items-baseline gap-2.5 font-mono">
          <span className="text-[16px] text-vgray-500">{fmtHf(sim.hf_before)}</span>
          <ChevronRight size={13} className="self-center text-vgray-300" />
          <span className="text-[22px] font-bold" style={{ color }}>
            {fmtHf(after)}
          </span>
        </span>
      </div>

      <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-vgray-100">
        <div className="absolute inset-y-0 left-0 bg-vgray-200" style={{ width: hfPct(sim.hf_before) }} />
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
          style={{ width: hfPct(after), background: color }}
        />
        <div className="absolute inset-y-0 left-[33.3%] w-0.5" style={{ background: BAD_INK }} />
        <div className="absolute inset-y-0 left-[43.3%] w-0.5" style={{ background: WARN_INK }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-vgray-400">
        <span style={{ color: BAD_INK }}>1.00 liquidation</span>
        <span style={{ color: WARN_INK }}>1.30 caution</span>
        <span>3.00+</span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-baseline justify-between gap-3 border-b border-vgray-100 py-[7px] last:border-0"
          >
            <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">{r.k}</span>
            <span className="flex items-baseline gap-[7px] font-mono text-[13px]">
              <span className="text-vgray-500">{r.before}</span>
              <span className="text-vgray-300">→</span>
              <span className="font-semibold text-vgray-900">{r.after}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


/** The fewest milliseconds between two background auto-sign status reads (focus, visibility, poll). */
const AUTO_SIGN_STATUS_MIN_GAP_MS = 20_000;

/** How long switching auto-approve on or off may take before the toggle is released again. */
const AUTO_SIGN_SWITCH_TIMEOUT_MS = 30_000;
export function CopilotWorkspace() {
  const address = useUserStore((s) => s.address);
  // Lives in the root layout, not here: an in-flight run must survive leaving this page.
  const investigation = useLiveInvestigation();

  const workflow = useLiveWorkflow();
  const persistedWorkflowReceiptRef = useRef<string | null>(null);
  const walletKind = useUserStore((s) => s.walletKind);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const storeGrossCollateral = useMarginAccountInfoStore((s) => s.grossCollateralValue);
  const storeCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const storeBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const storeCollateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const storeBorrowedBalances = useMarginAccountInfoStore((s) => s.borrowedBalances);

  // Same live snapshot feed as margin / portfolio so the right rail tracks
  // real on-chain HF / collateral / debt instead of a one-shot store paint.
  const { snapshot, refresh: refreshSnapshot } = useAccountSnapshot(address);

  const [intentText, setIntentText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [signingJournal, setSigningJournal] = useState(false);
  /** The prompt the user typed — never replaced by "Approved plan" on resume hops. */
  const originalIntentRef = useRef("");
  /** Collateral/debt tail paused because HF dropped below the stated floor. */
  const [hfPaused, setHfPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  /**
   * After a failed auto-sign for a hop key, stop the spinner for THAT hop only.
   * Storing the key (not a boolean) so hop 2 never inherits hop 1's blocked flag —
   * a boolean stayed true across the first paint of the next leg and looked like
   * "auto-approve on but needs your click" while session signing was still enabled.
   */
  const [autoSubmitBlockedKey, setAutoSubmitBlockedKey] = useState<string | null>(null);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  /** Always read latest response in signWithWallet — avoids stale XDR after hop advance. */
  const responseRef = useRef<ChatResponse | null>(null);
  responseRef.current = response;
  /** One rebuild attempt per txBadSeq (do not loop forever). Cleared on hop success. */
  const badSeqRebuildRef = useRef(false);
  /** Hop keys that already started auto-submit (declared early — used inside signWithWallet). */
  const autoSubmittedRef = useRef<string | null>(null);
  const [health, setHealth] = useState<BrainHealth | null>(null);
  const [customTx, setCustomTx] = useState("500");
  const [customDay, setCustomDay] = useState("2000");
  const [showCustom, setShowCustom] = useState(false);
  const [railCapsMode, setRailCapsMode] = useState<"defaults" | "custom">("defaults");
  const [savedCaps, setSavedCaps] = useState<{ tx: number; day: number } | null>(null);
  /** MCP `default_cap_usd` — shown under Default, never guessed from a custom session. */
  const [mcpDefaultCap, setMcpDefaultCap] = useState<number | null>(null);
  const [log, setLogRaw] = useState<LogEntry[]>([]);

  /**
   * Every log write goes through here so ids stay unique.
   *
   * React warned "two children with the same key" because rows are keyed on entry id, and
   * several writers mint one: the strategy branch reuses the parent id across hops, the
   * hop fold promotes a parent with that same id, and single-turn rows use request_id.
   * Two of those could land on one id, and duplicate keys make React drop or duplicate
   * rows silently. Deduping on write keeps the newest copy — the one carrying the latest
   * leg statuses — rather than papering over it with a composite key in the JSX.
   */
  const setLog = useCallback(
    (updater: LogEntry[] | ((prev: LogEntry[]) => LogEntry[])) => {
      setLogRaw((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        const seen = new Set<string>();
        return next.filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });
      });
    },
    [],
  );

  /**
   * History survives a reload.
   *
   * It did not before: the log lived in component state and the card was called "Session
   * log" because that is genuinely all it was — refresh the page and every turn was gone.
   * Stored per wallet, because a turn is about that wallet's account and showing another
   * wallet's history next to this one's balances would be worse than showing none.
   *
   * Hydration runs once per address and MERGES rather than replaces: a turn can complete
   * before the wallet address arrives from the store, and replacing would drop it.
   */
  /**
   * A run the user walked away from must not read as one still in progress.
   *
   * Owner-reported: "sometimes in session log it still showed in progress when completed."
   * Reproduced 2026-08-10 — a `lend` staged at 08:xx, never signed, still said `staged`
   * SEVEN HOURS later, and only cleared when the same prompt was run again (plan ids are a
   * deterministic fingerprint, so the second run updated the first run's row).
   *
   * Nothing was broken in the status mapping: a row only leaves a pre-terminal state when
   * something reports a terminal one, and an abandoned run never reports anything. A plan
   * can wait for Approve for up to a day (`PLAN_TTL_MS`); a staged row older than that is
   * finished — it just never said so. Applied ONLY on hydration, so a live run in this tab
   * is never relabelled underneath the user.
   */
  const settleAbandonedRow = (e: LogEntry): LogEntry => {
    const PRE_TERMINAL = new Set(["staged", "needs sign", "in progress", "needs authorization"]);
    if (!PRE_TERMINAL.has(String(e.status))) return e;
    // Generous margin over the plan TTL, so a genuine wait-to-Approve is never
    // mislabelled — this only catches rows that outlived any possible in-flight run.
    if (Date.now() - Number(e.ts || 0) < PLAN_TTL_MS + 60 * 60_000) return e;
    return {
      ...e,
      status: "not completed",
      tone: "warn",
      legs: e.legs?.map((l) =>
        l.status === "needs_sign" || l.status === "pending" ? { ...l, status: "not signed" } : l,
      ),
    };
  };

  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!address || hydratedFor.current === address) return;
    hydratedFor.current = address;
    try {
      const raw = localStorage.getItem(historyKey(address));
      if (!raw) return;
      const stored = JSON.parse(raw) as unknown;
      if (!Array.isArray(stored)) return;
      const rows = stored.filter(
        (e): e is LogEntry =>
          !!e && typeof e === "object" && typeof (e as LogEntry).id === "string",
      );
      if (!rows.length) return;
      setLogRaw((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...rows.filter((e) => !seen.has(e.id)).map(settleAbandonedRow)].slice(
          0,
          HISTORY_MAX,
        );
      });
    } catch {
      /* a corrupt blob is not worth failing the page over */
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    try {
      const key = historyKey(address);
      /**
       * THE SAVE PATH MAY NEVER EMPTY A NON-EMPTY STORE.
       *
       * This effect and the hydrate effect above both fire on the commit where `address`
       * first becomes non-null, and effects run in declaration order — so hydrate reads
       * storage and calls setLogRaw, then this runs with `log` still the empty initial
       * state and writes `[]` straight over the history it just read. The rows are
       * normally written back on the next commit and nobody notices. Reload inside that
       * window and the history is gone permanently: a 40-turn log was emptied this way
       * during a run of hard reloads.
       *
       * A "have we hydrated yet" ref does not fix it, because hydrate has already set
       * such a ref by the time this runs in the same commit. The invariant that does
       * hold, whatever the ordering, is the one below. Deliberately clearing the log
       * goes through `clearHistory`, which calls removeItem itself and is unaffected.
       */
      if (log.length === 0) {
        const existing = localStorage.getItem(key);
        if (existing && existing !== "[]") return;
      }
      localStorage.setItem(key, JSON.stringify(log.slice(0, HISTORY_MAX)));
    } catch {
      /* quota / private mode — history is a convenience, not a requirement */
    }
  }, [address, log]);

  const clearHistory = useCallback(() => {
    setLogRaw([]);
    if (!address) return;
    try {
      localStorage.removeItem(historyKey(address));
      localStorage.removeItem(`${historyKey(address)}:tx`);
    } catch {
      /* ignore */
    }
  }, [address]);

  /** Parent strategy prompt for client next_step hops (session log grouping). */
  const strategyParentRef = useRef<{ id: string; prompt: string } | null>(null);
  /**
   * Accumulated multi-leg steps across sequential hop POSTs. Each hop only returns
   * the legs it ran; the session log already merges via legKey — the strategy card
   * must use the same accumulator or it renumbers the last hop as "1.".
   */
  const strategyStepsRef = useRef<MultiLegStepUi[]>([]);
  const [strategySteps, setStrategySteps] = useState<MultiLegStepUi[]>([]);
  /**
   * One id for one run, so every leg updates the SAME receipt.
   *
   * The receipt was keyed by `response.request_id`, which is per REQUEST, and a multi-leg
   * run is many requests. Leg 2 therefore wrote under a new key, failed to find the turn
   * leg 1 had written, and fell through to "first assistant turn with no receipt" — so the
   * run's receipt landed on an earlier turn and stayed frozen at one leg.
   */
  const runReceiptIdRef = useRef<string | null>(null);
  /**
   * Legs this client is holding back so each one gets its own hop.
   *
   * A resume posts only the first remaining leg (splitResumeBatch) so the card
   * repaints between legs instead of freezing while the server runs the whole
   * tail in one request. The server plans only what it is given, so its
   * `remaining_legs` comes back empty and cannot carry the queue — this ref is
   * the queue. See resume-policy.ts.
   */
  const strategyTailRef = useRef<ResumeLeg[]>([]);
  /**
   * Once the active strategy card is fully terminal, lock auto-resume so idle
   * re-renders / summarize hops cannot toast "Running Borrow… (N more)" again.
   * Cleared when a new user turn starts (resetStrategyAccumulator).
   */
  const strategyCompleteRef = useRef(false);
  /** Strategy meta (summary, HF floor, SA) from multi-leg payloads — survives hop clears. */
  const strategyMetaRef = useRef<Record<string, unknown>>({});
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped when enable/disable lands so an in-flight GET /sessions cannot overwrite it. */
  const signReadSeq = useRef(0);
  /** Stops chain effect + in-flight fetch without wiping settled log legs. */
  const cancelledRef = useRef(false);
  /**
   * "New chat" and "open a conversation" both leave the current plan card behind: the
   * journal keeps every proposal server-side, the screen shows one conversation at a time.
   * The direct `/api/copilot` turn lives in this component, not in investigation, so it
   * has to be cleared here or a "fetch failed" note stays on a blank chat.
   */
  const leavePlanCard = useCallback(() => {
    setSigningJournal(false);
    workflow.reset();
    setIntentText("");
    setSubmitted(null);
    setResponse(null);
    setLoading(false);
    cancelledRef.current = false;
    abortRef.current?.abort("workspace reset");
    abortRef.current = null;
  }, [workflow]);
  const startNewChat = useCallback(() => { leavePlanCard(); investigation.newChat(); }, [leavePlanCard, investigation]);
  const openConversation = useCallback((id: string) => { leavePlanCard(); void investigation.open(id); }, [leavePlanCard, investigation]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Grow the intent box to fit its text, capped at six rows.
   *
   * Driven by an effect on `intentText` rather than the change handler, because the text is
   * also set programmatically — a Prompts chip, a reset, restoring the original intent after
   * a run — and those paths would otherwise leave a multi-line value in a one-row box.
   */
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    const lineHeight = 26;
    node.style.height = `${Math.min(node.scrollHeight, lineHeight * 6)}px`;
    node.style.overflowY = node.scrollHeight > lineHeight * 6 ? "auto" : "hidden";
  }, [intentText]);
  const stagedSectionRef = useRef<HTMLDivElement>(null);
  const lpScrollPendingRef = useRef(false);
  useEffect(() => {
    if (!lpScrollPendingRef.current) return;
    const staged =
      response?.kind === "needs_wallet_sign" ||
      (response?.kind === "needs_auto_sign" && isSignableXdr(response.unsigned_xdr));
    if (!staged) return;
    lpScrollPendingRef.current = false;
    requestAnimationFrame(() => {
      stagedSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [response?.kind, response?.unsigned_xdr]);

  /** Merge hop legs into strategySteps with the same legKey rule as pushLog. */
  const absorbStrategySteps = useCallback((incoming: MultiLegStepUi[]) => {
    if (!incoming?.length) return strategyStepsRef.current;
    const merged: MultiLegStepUi[] = strategyStepsRef.current.map((s) => ({ ...s }));
    for (const leg of incoming) {
      const label = String(leg.label || "").trim();
      if (!label && leg.index == null) continue;
      const keyed = label || `step-${leg.index ?? ""}`;
      const k = legKey(keyed);
      let at = merged.findIndex((m) => legKey(String(m.label || "")) === k);

      /**
       * Second chance: the same leg, now that its amount is known.
       *
       * A leg planned without a size is labelled "Borrow XLM"; the executor relabels it
       * "Borrow 15 XLM" once the user supplies one, which changes the exact key. Match the
       * pending original loosely so it is UPDATED rather than duplicated. Restricted to
       * pairing an amount-less existing leg with an amount-bearing incoming one, so two
       * real borrows of different sizes can never collapse into each other.
       */
      if (at < 0 && labelHasAmount(keyed)) {
        const loose = legKeyLoose(keyed);
        at = merged.findIndex(
          (m) =>
            !labelHasAmount(String(m.label || "")) &&
            legKeyLoose(String(m.label || "")) === loose,
        );
      }

      /**
       * Third chance: bare USDC clarified to BLUSDC / AQUSDC / SOUSDC.
       *
       * "Lend 125 USDC on Earn" → "Lend 125 AQUSDC on Earn" changes the asset part of the
       * key, so exact and amount-loose both miss. Without this the clarifying row stayed
       * frozen on needs_input while a duplicate AQUSDC row reported done.
       */
      if (at < 0) {
        at = merged.findIndex((m) =>
          isUsdcVariantResolution(String(m.label || ""), keyed),
        );
      }

      if (at < 0 && ["add_liquidity", "remove_liquidity", "deploy_to_blend", "supply_to_blend", "withdraw_from_blend"].includes(String(leg.op))) {
        at = merged.findIndex((m) => {
          const st = String(m.status || "");
          return (
            String(m.op) === String(leg.op) &&
            st !== "ok" &&
            st !== "done" &&
            st !== "failed" &&
            st !== "error"
          );
        });
      }

      if (at >= 0) {
        merged[at] = {
          ...merged[at],
          // The resolved label wins — the row should read "Borrow 15 XLM", not stay on the
          // amount-less wording it was planned with. Same for USDC → AQUSDC.
          label:
            labelHasAmount(keyed) || isUsdcVariantResolution(String(merged[at].label || ""), keyed)
              ? keyed
              : merged[at].label,
          amount: leg.amount != null ? leg.amount : merged[at].amount,
          asset: leg.asset != null ? leg.asset : merged[at].asset,
          // Position is the original's. A resume is a fresh runPlan whose step counter
          // restarts at 1, so trusting the incoming index renumbered leg 2 as leg 1.
          index: merged[at].index,
          status: leg.status ?? merged[at].status,
          tx_hash: leg.tx_hash != null ? leg.tx_hash : merged[at].tx_hash,
          hf_after: leg.hf_after != null ? leg.hf_after : merged[at].hf_after,
          message: leg.message != null ? leg.message : merged[at].message,
        };
      } else {
        // A genuinely new leg. Never reuse an index already taken, or two rows sort
        // arbitrarily and both display the same number.
        const maxIndex = merged.reduce((m, s) => Math.max(m, Number(s.index) || 0), 0);
        const wanted = Number(leg.index);
        const free =
          Number.isFinite(wanted) && wanted > 0 && !merged.some((s) => Number(s.index) === wanted);
        merged.push({
          ...leg,
          label: label || leg.label,
          index: free ? wanted : maxIndex + 1,
        });
      }
    }
    // Preserve first-seen order (append-only merge); stable sort by index for display.
    merged.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    const pruned = pruneDuplicateFarmAdds(merged);
    const prev = strategyStepsRef.current;
    const unchanged =
      prev.length === pruned.length &&
      prev.every((p, i) => {
        const m = pruned[i];
        return (
          String(p.op || "") === String(m.op || "") &&
          String(p.status || "") === String(m.status || "") &&
          String(p.label || "") === String(m.label || "") &&
          p.amount === m.amount
        );
      });
    if (unchanged) return prev;
    strategyStepsRef.current = pruned;
    setStrategySteps(pruned);
    return pruned;
  }, []);

  const resetStrategyAccumulator = useCallback(() => {
    strategyStepsRef.current = [];
    strategyTailRef.current = [];
    strategyCompleteRef.current = false;
    setStrategySteps([]);
    strategyMetaRef.current = {};
    setHfPaused(false);
  }, []);

  const storedAutoApprove = useCopilotSettingsStore(
    (s) => (address ? Boolean(s.autoApproveByWallet[address]) : false)
  );
  const freighterAutoApprove = walletKind === "freighter" && Boolean(address) && storedAutoApprove;

  // Session signing via Sign Service applies to Privy embedded wallets.
  // For Freighter, auto-approve acts as auto-dispatch directly to the extension popup.
  const sessionSigningAvailable = (walletKind === "privy" || walletKind === "freighter") && !!address;

  const [autoApprovePending, setAutoApprovePending] = useState(false);

  /**
   * What the Sign Service last reported for this wallet (`GET /sessions` on
   * connect, then enable / disable).
   *
   * Auto-approve may arm only when this is `ok`. A client-side cap is not a
   * policy — calling the API directly would bypass it.
   *
   * `unbound` is a third answer, not a flavour of `unavailable`. "The Sign Service
   * refused our credential" is our fault and the user can do nothing about it;
   * "this wallet is not authorized for Vanna to sign" is a consent they have never
   * been asked for, and it has a button.
   */
  const [signServiceState, setSignServiceState] = useState<{
    address: string | null;
    status: "unknown" | "ok" | "unavailable" | "unbound";
    reason: string | null;
  }>({ address: null, status: "unknown", reason: null });

  /**
   * The in-app consent is running (Privy may be showing its own sheet).
   *
   * Rendered as a working state rather than the fallback panel's buttons, so the user
   * never sees "open the authorization page" flash up during the path that is about
   * to make that page unnecessary.
   */
  const [bindingInApp, setBindingInApp] = useState(false);

  /** Whether anything server-side is actually holding the caps. */
  const capsEnforced = signServiceState.address === address && signServiceState.status === "ok";

  /** Whether auto-approve is toggled on in the UI by the user. */
  const autoApproveUiOn = Boolean(address) && storedAutoApprove;

  // The browser value is the user's intent. The Sign Service session is the
  // authority, so a switch changed by MCP or remote session sync updates the store.
  const autoApprove = autoApproveUiOn;

  /**
   * On wallet connect, read the live Sign Service session. Without this the rail
   * stayed `unknown` until a successful enable in this tab, so a session that
   * already existed (another MCP client, or a prior visit) never showed
   * "Budget active".
   */
  useEffect(() => {
    if (!address || !sessionSigningAvailable) {
      setSignServiceState({ address: null, status: "unknown", reason: null });
      return;
    }
    let cancelled = false;
    const seq = ++signReadSeq.current;
    let readController: AbortController | null = null;
    setSignServiceState({ address, status: "unknown", reason: null });
    let attempts = 0;
    const run = async () => {
      readController?.abort();
      const controller = new AbortController();
      readController = controller;
      try {
        const headers = await copilotRequestHeaders();
        if (cancelled || seq !== signReadSeq.current) return;
        if (!headers[PRIVY_TOKEN_HEADER]) {
          if (attempts++ < 12) window.setTimeout(() => { void run(); }, 500);
          return;
        }
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers,
          body: JSON.stringify({
            user_id: address,
            tier: "paid",
            surface: "copilot",
            auto_sign: { action: "status" },
          }),
          signal: controller.signal,
        });
        const data = (await res.json()) as ChatResponse;
        if (cancelled || seq !== signReadSeq.current) return;
        const next = signServiceFromSessionRead(data);
        // An unavailable/transient read is not proof that a previously conclusive
        // wallet-global session was revoked. Keep the last server-confirmed state.
        setSignServiceState((current) => {
          const currentForWallet =
            current.address === address
              ? current
              : { address, status: "unknown" as const, reason: null };
          const stable = preserveLastConclusiveSignState(currentForWallet, next);
          return { address, ...stable };
        });
        if (next.status === "unavailable") return;
        if (address) {
          setAutoApprove(address, next.status === "ok");
        }
        if (next.caps) {
          try {
            localStorage.setItem(
              AUTO_CAPS_KEY,
              JSON.stringify({
                max_per_tx_usd: next.caps.tx,
                max_per_day_usd: next.caps.day,
              }),
            );
          } catch {
            /* ignore */
          }
          setSavedCaps({ tx: next.caps.tx, day: next.caps.day });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // A failed read is not evidence the Sign Service is down — leave unknown
        // so the enable path still works.
      }
    };
    void run();
    /**
     * A hidden tab does not poll, and the interval is 45s rather than 15s.
     *
     * A browser allows ~6 connections per origin, and this page already holds several
     * slow ones: the investigation stream for the whole of a run, and account snapshot
     * reads that take 6-10s each. A 15s poll per open tab on top of that exhausts the
     * pool, and the request that loses the race never leaves the browser at all — the
     * user sees "Sending your request" counting up against a server that logged nothing
     * (17 Sep: three swap tests stalled this way, minutes each, nothing server-side to
     * show for them; §9 of the 16 Sep handover records the same symptom).
     *
     * Nothing is lost by waiting: the session state this reads changes when the user
     * enables or disables auto-sign, and both of those already write it directly. The
     * poll only catches a change made elsewhere — another tab, or MCP — which no one is
     * watching the rail for in a hidden tab. Becoming visible reads immediately, so the
     * rail is never stale by the time it is looked at.
     */
    const visible = () => document.visibilityState === "visible";
    /**
     * Focus and visibility fire together, and on every return to the window — switching to a
     * terminal or taking a screenshot. Each fired a status read, and each read spends the MCP
     * rate-limit budget the investigation needs: 25 Sep, live, a burst of ~20 status reads in
     * 20s left `aquarius_pool_reserves` failing with rate_limited. One read per
     * AUTO_SIGN_STATUS_MIN_GAP_MS is plenty; enable and disable write the state directly.
     */
    let lastRead = Date.now();
    const runIfVisible = () => {
      if (!visible() || Date.now() - lastRead < AUTO_SIGN_STATUS_MIN_GAP_MS) return;
      lastRead = Date.now();
      void run();
    };
    const poll = window.setInterval(runIfVisible, 45_000);
    const onFocus = () => runIfVisible();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      readController?.abort();
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [address, sessionSigningAvailable]);
  /**
   * Auto-approve is armed when the Sign Service is enforcing caps (for Privy),
   * or when the user has enabled auto-dispatch (for Freighter).
   */
  const sessionSigning =
    (walletKind === "freighter" && freighterAutoApprove) ||
    (sessionSigningAvailable && autoApprove && capsEnforced);

  // Feed the shared margin store from /api/account (identical path to margin page).
  useEffect(() => {
    if (!snapshot || isSnapshotFeedSuppressed()) return;
    const store = useMarginAccountInfoStore.getState();
    if (snapshot.hasMarginAccount && snapshot.marginAccountAddress) {
      const snapGross = snapshot.grossCollateralValue ?? 0;
      const degraded = snapGross <= 0.01 && (store.grossCollateralValue ?? 0) > 0.01;
      store.set({
        hasMarginAccount: true,
        marginAccountAddress: snapshot.marginAccountAddress,
        borrowedBalances: snapshot.borrowedBalances ?? {},
        totalBorrowedValue: snapshot.totalBorrowedValue ?? 0,
        totalValue: snapshot.totalValue ?? 0,
        borrowRate: snapshot.borrowRate ?? 0,
        isLoadingBorrowedBalances: false,
        ...(degraded
          ? {}
          : {
              collateralBalances: snapshot.collateralBalances ?? {},
              totalCollateralValue: snapshot.totalCollateralValue ?? 0,
              grossCollateralValue: snapGross,
              avgHealthFactor: snapshot.avgHealthFactor ?? 0,
              collateralLeftBeforeLiquidation: snapshot.collateralLeftBeforeLiquidation ?? 0,
              netAvailableCollateral: snapshot.netAvailableCollateral ?? 0,
              debtLimit: snapshot.debtLimit ?? 0,
            }),
      });
    } else if (snapshot.hasMarginAccount === false) {
      store.set({ hasMarginAccount: false });
    }
  }, [snapshot]);

  // Prefer snapshot numbers (same source as margin/portfolio), fall back to store.
  const effHasAccount = snapshot?.hasMarginAccount ?? hasMarginAccount;
  const effGross = snapshot?.grossCollateralValue ?? storeGrossCollateral;
  const effBorrowed = snapshot?.totalBorrowedValue ?? storeBorrowedValue;
  const effCollateral = snapshot?.totalCollateralValue ?? storeCollateralValue;
  const derivedHealth = deriveMarginHealth({
    grossCollateralValue: effGross || 0,
    effectiveDebtValue: (effBorrowed || 0) > 0.01 ? effBorrowed || 0 : 0,
    totalBorrowedValue: effBorrowed || 0,
  });
  const healthFactor = derivedHealth.avgHealthFactor;
  const collateralValue = effCollateral;
  const borrowedValue = effBorrowed;
  // "net value" = equity (collateral minus debt), NOT `totalValue` — that field is
  // `netAvailableCollateral + totalBorrowedValue`, which algebraically always
  // collapses back to gross collateral (adding debt back cancels the subtraction
  const liveHf = effHasAccount && healthFactor ? healthFactor : null;

  /**
   * Open positions for the rail — same rules as the Margin positions table.
   *
   * Source: `/api/account` snapshot (fallback: store). Farm/LP receipt symbols
   * (`BLEND_*`, `AQ_*`, `SS_*`) live in collateralBalances for HF math but are
   * not margin positions — skip them via `isTrackingSymbol`. Same-token debt is
   * netted out of deposited collateral so borrowed proceeds do not look like a
   * supply. Venue is always `margin` here; Earn/Farm holdings stay on those pages.
   */
  const positionRows = useMemo(() => {
    type Bal = { amount: string; usdValue: string };
    const DUST_USD = 0.01;
    const DUST_AMT = 1e-6;
    const canon = (token: string): string => {
      const u = token.toUpperCase();
      if (u === "BLEND_USDC" || u === "USDC") return "BLUSDC";
      if (u === "AQUIRESUSDC" || u === "AQUARIUS_USDC") return "AQUSDC";
      if (u === "SOROSWAPUSDC" || u === "SOROSWAP_USDC") return "SOUSDC";
      return u;
    };
    const borrowedSrc = snapshot?.borrowedBalances ?? storeBorrowedBalances;
    const collSrc = snapshot?.collateralBalances ?? storeCollateralBalances;

    const borrowedMap = new Map<string, { symbol: string; amount: number; usd: number }>();
    for (const [token, b] of Object.entries(borrowedSrc ?? {}) as [string, Bal][]) {
      const amount = Number.parseFloat(b.amount) || 0;
      const usd = Number.parseFloat(b.usdValue) || 0;
      if (!(amount > DUST_AMT) || !(usd > DUST_USD)) continue;
      const c = canon(token);
      const prev = borrowedMap.get(c);
      if (!prev || amount > prev.amount) borrowedMap.set(c, { symbol: token, amount, usd });
    }

    const collMap = new Map<string, { symbol: string; amount: number; usd: number }>();
    for (const [token, b] of Object.entries(collSrc ?? {}) as [string, Bal][]) {
      if (isTrackingSymbol(token)) continue;
      const grossAmt = Number.parseFloat(b.amount) || 0;
      const grossUsd = Number.parseFloat(b.usdValue) || 0;
      if (!(grossAmt > DUST_AMT) || !(grossUsd > DUST_USD)) continue;
      const c = canon(token);
      const debt = borrowedMap.get(c);
      const amount = Math.max(0, grossAmt - (debt?.amount ?? 0));
      const usd = Math.max(0, grossUsd - (debt?.usd ?? 0));
      if (!(amount > DUST_AMT) || !(usd > DUST_USD)) continue;
      const prev = collMap.get(c);
      if (!prev || usd > prev.usd) collMap.set(c, { symbol: token, amount, usd });
    }

    const fmtAmt = (n: number) =>
      n.toLocaleString(undefined, { maximumFractionDigits: 7 });
    const toList = (m: Map<string, { symbol: string; amount: number; usd: number }>) =>
      Array.from(m.values())
        .sort((a, b) => b.usd - a.usd)
        .map((r) => ({
          symbol: r.symbol,
          amount: fmtAmt(r.amount),
          usd: r.usd,
          venue: "margin" as const,
        }));

    return {
      collateral: toList(collMap),
      borrowed: toList(borrowedMap),
    };
  }, [
    snapshot?.collateralBalances,
    snapshot?.borrowedBalances,
    storeCollateralBalances,
    storeBorrowedBalances,
  ]);

  const positionMeta = useMemo(() => {
    const s = positionRows.collateral.length;
    const b = positionRows.borrowed.length;
    if (s === 0 && b === 0) return "none open";
    const parts: string[] = [];
    if (s > 0) parts.push(`${s} supplied`);
    if (b > 0) parts.push(`${b} borrowed`);
    return parts.join(" · ");
  }, [positionRows]);

  /** Force-refresh rail stats after a prompt/sign so values match margin page. */
  const refreshRailStats = useCallback(
    /**
     * `after` is a settled transaction hash. The snapshot route is cached for 15s on
     * TIME, so a refresh fired the instant a write landed was answered from the body
     * taken before it — which is why the rail held the old health factor until the user
     * reloaded the page. Passing the hash makes the read go past that cache, so the event
     * that changed the account is what invalidates it.
     */
    async (opts?: { force?: boolean; after?: string | null }) => {
      if (!address) return;
      const force = opts?.force !== false;
      try {
        await checkUserMarginAccount(address, force);
        const acct =
          useMarginAccountInfoStore.getState().marginAccountAddress ||
          snapshot?.marginAccountAddress ||
          smartAccount;
        if (acct) {
          await refreshBorrowedBalances(acct, force);
        }
        await refreshSnapshot(opts?.after ?? null);
      } catch {
        // Rail refresh is best-effort — never block the agent turn.
      }
    },
    [address, smartAccount, snapshot?.marginAccountAddress, refreshSnapshot],
  );

  useEffect(() => {
    let alive = true;
    fetch("/api/copilot")
      .then((r) => r.json())
      .then((d) => alive && setHealth(d.health ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Initial + wallet-change paint of the right rail. Intentionally keyed on `address`
  // only — including refreshRailStats would re-run this on every render it changes on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!address) return;
    void refreshRailStats({ force: true });
  }, [address]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusFromKind = (kind: ChatResponse["kind"] | undefined): string => {
    if (kind === "executed") return "executed";
    if (kind === "needs_wallet_sign") return "staged";
    if (kind === "needs_auto_sign") return "needs sign";
    if (kind === "needs_wallet_bind") return "needs authorization";
    if (kind === "blocked") return "blocked";
    if (kind === "error") return "error";
    if (kind === "answer") return "answered";
    return "clarify";
  };

  const toneFromKind = (kind: ChatResponse["kind"] | undefined): Tone => {
    if (kind === "executed" || kind === "answer") return "ok";
    if (kind === "blocked" || kind === "error") return "bad";
    if (kind === "needs_wallet_sign" || kind === "needs_auto_sign") return "active";
    return "warn";
  };

  /**
   * Session log: multi-leg / agent-chain hops update ONE parent row instead of
   * flooding the log with “Lend…”, “Deposit…”, “Borrow…” as separate turns.
   */
  const pushLog = useCallback(
    (
      prompt: string,
      data: ChatResponse,
      opts?: { chainHop?: boolean; hopLabel?: string },
    ) => {
      const status = statusFromKind(data.kind);
      const tone = toneFromKind(data.kind);
      const tool = data.mcp?.tool || data.intent?.template_id || "router";
      const multi =
        !!(data.data && (data.data as Record<string, unknown>).multi_leg) ||
        Array.isArray((data.data as Record<string, unknown> | undefined)?.multi_leg_steps);
      const multiSteps = Array.isArray((data.data as any)?.multi_leg_steps)
        ? ((data.data as any).multi_leg_steps as Array<{
            label?: string;
            op?: string;
            status?: string;
          }>)
        : null;

      // Parent multi-leg strategy response from server
      if (multi && multiSteps?.length) {
        // Reuse the strategy's own id across chained hops. Keying on data.request_id
        // meant every continuation — a fresh POST with a fresh request_id — produced
        // another "Approved plan" row, so one four-leg strategy filled the log with five
        // near-identical entries that each told a partial story.
        const id =
          (opts?.chainHop && strategyParentRef.current?.id) ||
          data.request_id ||
          `strat-${Date.now()}`;
        const parentPrompt =
          (opts?.chainHop && strategyParentRef.current?.prompt) ||
          String((data.data as any)?.strategy_summary || "").trim() ||
          prompt ||
          "Multi-step strategy";
        strategyParentRef.current = { id, prompt: parentPrompt };
        const legs: LogLeg[] = multiSteps.map((s) => ({
          label: s.label || s.op || "step",
          tool: s.op || "leg",
          status: s.status === "ok" ? "done" : s.status === "skipped" ? "skip" : s.status || "…",
        }));
        const overall =
          multiSteps.every((s) => s.status === "ok")
            ? "executed"
            : multiSteps.some((s) => s.status === "error" || s.status === "blocked")
              ? status
              : status;
        setLog((prev) => {
          const existing = prev.find((e) => e.id === id);
          // Each hop only reports the legs it ran, so replacing wholesale made completed
          // legs vanish and the row read as if the strategy had restarted. Merge by
          // label: keep the original order, take the newer status, append anything new.
          const merged: LogLeg[] = existing?.legs ? [...existing.legs] : [];
          for (const leg of legs) {
            const k = legKey(leg.label);
            let at = merged.findIndex((m) => legKey(m.label) === k);
            // Same USDC→variant reconcile as absorbStrategySteps — otherwise the session
            // log kept "Lend 125 USDC" on clarification and appended "Lend 125 AQUSDC" done.
            if (at < 0) {
              at = merged.findIndex((m) => isUsdcVariantResolution(m.label, leg.label));
            }
            if (at >= 0) {
              // Prefer the resolved label (USDC → AQUSDC) so the row matches the card.
              const resolved =
                isUsdcVariantResolution(merged[at].label, leg.label) ||
                labelHasAmount(leg.label);
              merged[at] = {
                ...merged[at],
                status: leg.status,
                ...(resolved ? { label: leg.label } : {}),
              };
            } else {
              merged.push(leg);
            }
          }
          const finalLegs = merged.length ? merged : legs;
          const allDone = finalLegs.every((l) => l.status === "done" || l.status === "skip");
          // Also drop the plan_preview row for this same prompt. It was the placeholder
          // that led to this strategy, and leaving it next to the executing row showed
          // the same request twice with two different statuses.
          const without = prev.filter(
            (e) => e.id !== id && !(!e.strategy && e.prompt === parentPrompt),
          );
          return [
            {
              id,
              prompt: parentPrompt,
              tool: "multi_leg",
              ts: existing?.ts ?? Date.now(),
              status: allDone ? "executed" : overall,
              tone: allDone || overall === "executed" ? "ok" : tone,
              strategy: true,
              legs: finalLegs,
            },
            ...without,
          ].slice(0, HISTORY_MAX);
        });
        return;
      }

      // Client next_step / wallet-sign hop — fold into parent strategy if any
      if (opts?.chainHop && strategyParentRef.current) {
        const parentId = strategyParentRef.current.id;
        const hopLabel = opts.hopLabel || prompt;
        setLog((prev) => {
          const idx = prev.findIndex((e) => e.id === parentId || e.strategy);
          if (idx < 0) {
            // Promote hop into a strategy parent row
            return [
              {
                id: parentId,
                prompt: strategyParentRef.current!.prompt,
                tool: "multi_leg",
                ts: Date.now(),
                status: status === "executed" ? "in progress" : status,
                color: WARN_INK,
                strategy: true,
                legs: [
                  {
                    label: hopLabel,
                    tool,
                    status: status === "executed" ? "done" : status,
                  },
                ],
              },
              ...prev,
            ].slice(0, HISTORY_MAX);
          }
          const copy = [...prev];
          const parent = { ...copy[idx] };
          const legs = [...(parent.legs || [])];
          // Same identity rule as the strategy branch. This used a looser match — equal
          // labels, or equal tool, or either string containing the other — which is why a
          // leg could stay frozen at needs_sign while a near-identically worded duplicate
          // was appended reporting done. `l.tool === tool` was the worst of it: with two
          // deposit legs it matched whichever came first, regardless of amount or asset.
          const hopKey = legKey(hopLabel);
          let legIdx = legs.findIndex((l) => legKey(l.label) === hopKey);
          if (legIdx < 0) {
            legIdx = legs.findIndex((l) => isUsdcVariantResolution(l.label, hopLabel));
          }
          if (legIdx >= 0) {
            legs[legIdx] = {
              ...legs[legIdx],
              // Prefer the resolved wording when USDC → AQUSDC (etc.).
              label: isUsdcVariantResolution(legs[legIdx].label, hopLabel)
                ? hopLabel
                : legs[legIdx].label,
              status: status === "executed" ? "done" : status,
              tool,
            };
          } else {
            legs.push({
              label: hopLabel,
              tool,
              status: status === "executed" ? "done" : status,
            });
          }
          parent.legs = legs;
          parent.status =
            status === "executed" && legs.every((l) => l.status === "done" || l.status === "skip")
              ? "executed"
              : status === "staged" || status === "needs sign"
                ? "in progress"
                : "in progress";
          parent.tone =
            parent.status === "executed" ? "ok" : status === "staged" ? "active" : "warn";
          parent.tool = "multi_leg";
          parent.strategy = true;
          copy[idx] = parent;
          return copy;
        });
        return;
      }

      // First response that will continue via next_step — open a strategy parent row
      if (data.next_step && !opts?.chainHop) {
        const id = data.request_id || `strat-${Date.now()}`;
        strategyParentRef.current = { id, prompt };
        setLog((prev) =>
          [
            {
              id,
              prompt,
              tool: "multi_leg",
              ts: Date.now(),
              status: status === "executed" ? "in progress" : status,
              tone: status === "executed" ? "warn" : tone,
              strategy: true,
              legs: [
                {
                  label: prompt.length > 60 ? tool.replace(/^vanna_/, "").replace(/_/g, " ") : prompt,
                  tool,
                  status: status === "executed" ? "done" : status,
                },
              ],
            },
            ...prev,
          ].slice(0, HISTORY_MAX),
        );
        return;
      }

      // Plain single-op turn
      if (!opts?.chainHop) strategyParentRef.current = null;
      setLog((prev) =>
        [
          {
            id: data.request_id || `turn-${Date.now()}`,
            prompt,
            tool,
            ts: Date.now(),
            status,
            tone,
          },
          ...prev,
        ].slice(0, HISTORY_MAX),
      );
    },
    [],
  );

  const pushActivity = useCallback((label: string, hash: string | null | undefined) => {
    if (!hash) return;
    setActivity((prev) =>
      // De-dupe on hash: a chained leg can report the same transaction twice as it settles,
      // and the same hash listed twice reads as two transfers.
      [{ label, hash, ts: Date.now() }, ...prev.filter((a) => a.hash !== hash)].slice(0, 10),
    );
  }, []);

  /**
   * Signed transactions persist alongside the turn history.
   *
   * A transaction hash is the one thing on this page the user may need hours later, and
   * "On-chain this session" meant it was discarded on refresh. Same key namespace as the
   * history so `clear` removes both.
   */
  const hydratedTxFor = useRef<string | null>(null);
  useEffect(() => {
    if (!address || hydratedTxFor.current === address) return;
    hydratedTxFor.current = address;
    try {
      const raw = localStorage.getItem(`${historyKey(address)}:tx`);
      if (!raw) return;
      const stored = JSON.parse(raw) as unknown;
      if (!Array.isArray(stored)) return;
      const rows = stored.filter(
        (a): a is ActivityEntry =>
          !!a && typeof a === "object" && typeof (a as ActivityEntry).hash === "string",
      );
      if (!rows.length) return;
      setActivity((prev) => {
        const seen = new Set(prev.map((a) => a.hash));
        return [...prev, ...rows.filter((a) => !seen.has(a.hash))].slice(0, 10);
      });
    } catch {
      /* ignore */
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    try {
      localStorage.setItem(`${historyKey(address)}:tx`, JSON.stringify(activity.slice(0, 10)));
    } catch {
      /* ignore */
    }
  }, [address, activity]);

  const postCopilot = useCallback(
    async (
      body: Record<string, unknown>,
      promptLabel: string,
      opts?: { chainHop?: boolean; background?: boolean; signal?: AbortSignal },
    ) => {
      const silent = !!opts?.background;
      /** Header auto-approve on/off: toast only — do not steal the turn card or abort a run. */
      const quiet = silent && !opts?.chainHop && !body.summarize_execution;
      /**
       * A fresh typed turn is allowed even if the previous one was cancelled.
       * `cancelledRef` is a latch for chain hops / background work after Cancel —
       * without clearing it here, every later prompt still POSTed, then threw the
       * JSON away, so the server looked idle and the thread kept the last error.
       */
      if (!opts?.chainHop && !silent) {
        cancelledRef.current = false;
      } else if (cancelledRef.current && (opts?.chainHop || opts?.background) && !quiet) {
        return null;
      }
      const ac = new AbortController();
      if (!quiet) {
        abortRef.current?.abort("workspace superseded");
        abortRef.current = ac;
      }

      if (!silent) setLoading(true);
      // Keep last response on chain hops so the strategy card doesn't flash empty;
      // full new prompts still clear.
      if (!quiet && !opts?.chainHop && !body.summarize_execution) {
        setResponse(null);
      }
      setShowCustom(false);
      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          // Carries the Privy session as the end-user assertion, which is what
          // lets a risk-cleared write auto-sign instead of asking for a signature.
          headers: await copilotRequestHeaders(),
          body: JSON.stringify({
            user_id: address ?? "guest",
            tier: "paid",
            smart_account: smartAccount ?? null,
            surface: "copilot",
            session_signing: autoApprove,
            ...body,
          }),
          signal: opts?.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal,
        });
        if (cancelledRef.current) {
          return null;
        }
        let data = (await res.json()) as ChatResponse;
        // Strip markdown stars so the UI never shows **BLUSDC**
        if (data.message) data.message = stripMarkdownLite(data.message);
        if (data.preview?.human_summary) {
          data.preview.human_summary = stripMarkdownLite(data.preview.human_summary);
        }
        // needs_auto_sign + XDR → treat as staged wallet-sign so app auto-approve
        // can silent-sign every hop (Sign Service enable gate must not interrupt).
        data = promoteSignableAutoSignResponse(data, isSignableXdr(data.unsigned_xdr));
        // G-wallet create/connect and page tools run in the browser only.
        if (Array.isArray(data.client_tools) && data.client_tools.length) {
          executeClientTools(data.client_tools);
        }

        // Absorb multi-leg hop legs into the shared accumulator (same legKey as log).
        const d = (data.data ?? null) as Record<string, unknown> | null;

        /**
         * MCP reports the Sign Service's real active cap on ANY auto-sign-related turn —
         * "enable auto-approve", or a plain sentence a keyword match mistook for a cap
         * change (the injection this closes: "auto-approve a 100 BLUSDC borrow" set the
         * cap to 100 server-side without ever calling `applyAutoSignOutcome`, which only
         * runs from the deliberate Defaults/Custom buttons). The Autonomy card's "Budget
         * active" chip read stale `localStorage` in both cases, disagreeing with the
         * account's real limit until the user happened to click Edit. Synced here, once,
         * off whatever MCP actually reports, so the chip can never drift from it.
         */
        const reportedTx = Number((d as { max_per_tx_usd?: unknown } | null)?.max_per_tx_usd);
        const reportedDay = Number((d as { max_per_day_usd?: unknown } | null)?.max_per_day_usd);
        if (Number.isFinite(reportedTx) && reportedTx > 0) {
          const caps = {
            max_per_tx_usd: reportedTx,
            max_per_day_usd: Number.isFinite(reportedDay) && reportedDay > 0 ? reportedDay : reportedTx,
          };
          try {
            localStorage.setItem(AUTO_CAPS_KEY, JSON.stringify(caps));
          } catch {
            /* ignore */
          }
          setSavedCaps({ tx: caps.max_per_tx_usd, day: caps.max_per_day_usd });
        }

        /**
         * Same gap, the more dangerous direction: "disable auto-sign" typed as a plain
         * message revokes the Sign Service session server-side (S-06 reports "Auto-sign
         * disabled... 0 session(s) revoked" correctly) but never called `setAutoApprove`,
         * which only runs from the dedicated enable/disable buttons. The client's OWN
         * local auto-approve flag — which is what actually lets `promoteSignableAutoSignResponse`
         * sign a `needs_wallet_sign` with the embedded Privy session key — stayed on, so
         * every write after "disable auto-sign" kept auto-signing anyway (S-07 failure).
         * Synced generically off the same message text MCP already returns, in both
         * directions, so this can't drift from whichever path changed it.
         */
        if (address) {
          if (/\bauto-sign disabled\b/i.test(data.message || "")) {
            setAutoApprove(address, false);
            setSignServiceState({ address, status: "unknown", reason: null });
          } else if (/\bauto-sign (?:already active|enabled)\b/i.test(data.message || "")) {
            setSignServiceState({ address, status: "ok", reason: null });
            setAutoApprove(address, true);
          }
        }

        const hopSteps = Array.isArray(d?.multi_leg_steps)
          ? (d!.multi_leg_steps as MultiLegStepUi[])
          : null;
        if (hopSteps?.length) {
          absorbStrategySteps(hopSteps);
          strategyMetaRef.current = {
            ...strategyMetaRef.current,
            ...(d || {}),
            multi_leg_steps: strategyStepsRef.current,
            strategy_summary:
              d?.strategy_summary ??
              d?.plan_summary ??
              strategyMetaRef.current.strategy_summary,
          };
        }

        // Summarize round-trip has answer only — keep strategy meta for the card.
        // Strip resume queue fields so the receipt cannot re-arm auto-chain.
        if (body.summarize_execution && strategyStepsRef.current.length) {
          strategyCompleteRef.current = true;
          strategyTailRef.current = [];
          data.data = {
            ...strategyMetaRef.current,
            multi_leg: true,
            multi_leg_steps: strategyStepsRef.current,
            ...(data.data && typeof data.data === "object" ? data.data : {}),
            remaining_legs: null,
            resume_legs: null,
            prefer_resume_multi_leg: false,
            can_resume: false,
            strategy_complete: true,
          };
          data.next_step = null;
          if (data.execution) {
            data.execution = { ...data.execution, status: data.execution.status || "completed" };
          }
        }

        if (silent && body.summarize_execution) {
          setResponse((prev) => {
            if (!prev) return data;
            return {
              ...prev,
              ...data,
              answer: data.answer ?? prev.answer,
              data: {
                ...(typeof prev.data === "object" && prev.data ? prev.data : {}),
                ...(typeof data.data === "object" && data.data ? data.data : {}),
                multi_leg_steps: strategyStepsRef.current,
              },
            };
          });
        } else if (!quiet || data.kind === "needs_wallet_bind") {
          setResponse((previous) => preserveWalletBindPanelResponse(previous, data));
        }
        // Agent-chain hops (pending_write / explicit chain) fold into the parent log row.
        // Full multi_leg payloads create/refresh the parent strategy row.
        // Do not log pure summarize receipts as a new turn noise — still fold if multi.
        if (!quiet && !body.summarize_execution) {
          pushLog(promptLabel, data, {
            chainHop: !!(opts?.chainHop || body.pending_write || body.resume_multi_leg),
            hopLabel: promptLabel,
          });
        }
        if (data.kind === "executed" && !body.summarize_execution) {
          toast.success(data.execution?.tx_hash ? `Submitted · ${data.execution.tx_hash.slice(0, 10)}…` : "Done");
          pushActivity(data.preview?.human_summary || promptLabel, data.execution?.tx_hash);
        }
        // Keep right-rail HF / collateral / debt in sync with margin page after
        // every prompt (reads + writes). Force after on-chain executions.
        const force =
          data.kind === "executed" ||
          data.kind === "needs_wallet_sign" ||
          Boolean(data.execution?.tx_hash);
        void refreshRailStats({ force, after: data.execution?.tx_hash ?? null });
        return data;
      } catch (e) {
        // Cancel must leave already-executed legs in the log and on the card.
        if (
          (e instanceof DOMException && e.name === "AbortError") ||
          (e instanceof Error && e.name === "AbortError") ||
          cancelledRef.current
        ) {
          return null;
        }
        /**
         * Say what failed.
         *
         * This catch replaced every reply with one sentence, so a session-append
         * rejected by Google (`invalid_grant` / `invalid_rapt`, in the same minute as
         * the reported turn), a network drop and a JSON parse error were all "Copilot
         * request failed." — and the actual reason was only ever in the console. The
         * thrown value already carries it; nothing needed to be invented, only kept.
         */
        const detail = e instanceof Error ? e.message.trim() : String(e ?? "").trim();
        const failed: ChatResponse = {
          kind: "error",
          message: detail
            ? `That request failed before it could answer: ${detail}`
            : "That request failed before it could answer, and returned no reason.",
        };
        if (!silent) {
          setResponse(failed);
          pushLog(promptLabel, failed);
        }
        return silent ? null : failed;
      } finally {
        if (!quiet && abortRef.current === ac) abortRef.current = null;
        if (!silent) setLoading(false);
      }
    },
    [address, smartAccount, autoApprove, pushLog, pushActivity, refreshRailStats, absorbStrategySteps],
  );

  /**
   * Write an outcome into the conversation, not just a toast.
   *
   * Cancel flipped `cancelledRef` and raised a toast; nothing reached the thread, so a
   * stopped run left the last thing the copilot said standing as if it were still true —
   * a staged panel asking for a signature the user had just refused. A toast is gone in
   * three seconds and is not a record.
   *
   * Appends when the prompt has no turn yet (cancelled mid-request, before the reply was
   * recorded) and replaces the pending assistant line when it does (cancelled at the
   * signature, where that line is the staged request being answered).
   */
  const noteOutcome = useCallback(
    (text: string) => {
      const prompt = (submitted || originalIntentRef.current || "").trim();
      const recorded =
        !!prompt && investigation.turns.some((t) => t.role === "user" && t.text === prompt);
      if (recorded) void investigation.updateLastAssistantText(text);
      else if (prompt) void investigation.recordDirect(prompt, text);
    },
    [investigation, submitted],
  );

  const cancelInFlight = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort("cancel pressed");
    abortRef.current = null;
    setLoading(false);
    setSigning(false);
    // Drop the queued legs. cancelledRef already stops the chain, but leaving a
    // tail behind means a later hop could find it and resume a run the user
    // explicitly stopped — these legs move funds, so they die with the cancel.
    // Settled legs stay on screen; only the unsent queue is discarded.
    strategyTailRef.current = [];
    setHfPaused(false);
    if (originalIntentRef.current) setIntentText(originalIntentRef.current);
    toast("Request cancelled — completed steps stay in the log. Nothing further will be submitted.", {
      duration: 3500,
    });
    noteOutcome(
      "Cancelled. Nothing was submitted — any step that had already settled stays on-chain.",
    );
  }, [noteOutcome]);

  const { run: investigate } = investigation;
  const resetWorkflow = workflow.reset;
  const runInvestigation = useCallback(async (text: string, signal?: AbortSignal) => {
    const continuing = shouldContinueInvestigation(text, investigation.result);
    if (shouldReplacePlan(text, investigation.result)) {
      setSigningJournal(false);
      resetWorkflow();
      resetStrategyAccumulator();
      setResponse(null);
    } else if (!(continuing && investigation.result?.question)) {
      setResponse(null);
    }
    setSubmitted(text);
    setIntentText("");
    await investigate(text, signal);
  }, [resetStrategyAccumulator, investigate, resetWorkflow, investigation.result]);
  const runDirect = useCallback(async (text: string, signal: AbortSignal) => {
    const continuing = shouldContinueInvestigation(text, investigation.result);
    if (shouldReplacePlan(text, investigation.result)) {
      setSigningJournal(false);
      resetWorkflow();
      resetStrategyAccumulator();
    } else if (!(continuing && investigation.result?.question)) {
      setResponse(null);
    }
    setSubmitted(text);
    setIntentText("");
    const direct = await postCopilot({ message: text }, text, { signal });
    /**
     * A write's turn is what it is about to do, not the signing boilerplate.
     *
     * `message` on a staged write is `readyToSignMessage` — "Built and ready — approve to
     * sign it with your wallet." — which is chrome for a card, and it was what the
     * conversation kept as the record of the turn. `human_summary` is the sentence the
     * write actually names ("Supply 50 XLM to Blend"), and it is replaced by the receipt
     * once the transaction settles.
     */
    const actionSummary = direct?.preview?.action
      ? shortWriteLabel({
          op: direct.preview.action.op,
          amount: direct.preview.action.amount,
          asset: direct.preview.action.asset,
          token_a: direct.preview.action.token_a,
          token_b: direct.preview.action.token_b,
          venue: direct.preview.action.venue,
        })
      : null;
    const rawLine = (direct?.preview?.human_summary || "").trim() || (direct?.message || "").trim();
    const line = /built and ready/i.test(rawLine) ? (actionSummary || text) : (rawLine || actionSummary || text);
    if (line) await investigation.recordDirect(text, line);
  }, [investigation, postCopilot, resetStrategyAccumulator, resetWorkflow]);
  const entry = useCopilotEntry({
    wallet: address,
    onInvestigate: runInvestigation,
    onDirect: runDirect,
  });

  const { run: dispatchRun } = entry;

  /**
   * Sized Blend options go through the workflow journal (`/propose`, `/approve`,
   * `/advance`) so the amounts the card showed are the ones held for approval.
   * This runs only when the investigation reached a conclusion with a candidate.
   */
  const proposePlan = workflow.propose;
  const confirmWorkflow = workflow.confirm;
  /** Set when a prepared plan should be approved as soon as it arrives (see approveCandidate). */
  const approveWhenProposedRef = useRef(false);
  /** Which candidate the running plan came from, so the finished reply can quote its rate and health. */
  const approvedCandidateRef = useRef<string | null>(null);
  const updateExecutionReceipt = investigation.updateExecutionReceipt;
  useEffect(() => {
    const view = workflow.view;
    const network = investigation.result?.scope.network;
    if (!view || !network || !investigation.conversationId) return;
    /**
     * A receipt records what HAPPENED to a run, so there is nothing to record until one
     * starts.
     *
     * This fired on any workflow view, including `proposed` — the state a plan sits in while
     * it waits for Approve. The turn therefore grew an EXECUTION PROGRESS card whose only leg
     * read "Queued", and because the turn renders above the investigation card, that card sat
     * ABOVE the approval it had not been given yet. Reported 23 Sep on "lend 50 xlm".
     *
     * `proposed` and `validating` are the two positions before approval in the status machine
     * (`WorkflowRecord["status"]`); every other position describes a run that has begun or
     * finished, and those still write their receipt as before.
     */
    if (view.status === "proposed" || view.status === "validating") return;
    const receipt = executionReceiptFromWorkflowView(view, network);
    const key = JSON.stringify(receipt);
    if (persistedWorkflowReceiptRef.current === key) return;
    persistedWorkflowReceiptRef.current = key;
    void updateExecutionReceipt(receipt).then((saved) => {
      if (!saved && persistedWorkflowReceiptRef.current === key) persistedWorkflowReceiptRef.current = null;
    });
  }, [workflow.view, investigation.result?.scope.network, investigation.conversationId, updateExecutionReceipt]);
  useEffect(() => {
    const view = investigation.result;
    if (!view || investigation.loading || investigation.error) return;
    if (view.status !== "researched" || view.question) return;
    /**
     * Only what the server NOMINATED is prepared without a click. It nominates a candidate
     * only when there is exactly one — several competing strategies are the user's choice
     * to make, and this effect feeds the auto-approve effect below, which with session
     * signing on signs and broadcasts (15 Sep, S4: the first of two options was executed
     * before it could be read). The `?? feasible[0]` fallback that used to sit here
     * re-nominated exactly what the server had declined to, which is why the server-side
     * rule alone did nothing.
     */
    const candidateId = view.proposalCandidateId;
    if (view.pendingWrite?.op || !candidateId || !view.continuation) return;
    if (workflow.view || workflow.loading) return;
    /**
     * A failed propose waits for the user; it does not try again by itself.
     *
     * A failure releases the dispatch claim (so the same plan CAN be retried) and resets
     * `workflow.view`/`workflow.loading` — which are this effect's own dependencies. So the
     * effect re-ran at once, found the claim free and proposed again, forever: live 23 Sep, a
     * broken route answered 404 and the terminal filled with `POST /workflow/propose 404`
     * several times a second. The error is already on screen saying "please try again"; a
     * retry is the user resending, which is a new continuation and so a new claim anyway.
     */
    if (workflow.error) return;
    /**
     * A turn this page ran carries on by itself; a turn read back from the thread does not.
     * Both arrive in the same `result`, so the two are told apart by where it came from —
     * and the claim makes the dispatch survive a remount, which the old ref could not.
     */
    if (investigation.resultOrigin !== "live") return;
    const proposeKey = `propose:${view.continuation}:${candidateId}`;
    if (!claimDispatch(address, proposeKey)) return;
    /**
     * Owner rule (24 Sep, via Sanujit): an action the user STATED (single or multi-leg) gets
     * no plan card. It is prepared and approved here, and the execution card shows it running.
     * With auto-approve ON the session signer submits each leg; with it OFF every leg still
     * waits for the user's own wallet signature, so nothing is signed without them. A strategy
     * the model chose is nominated by its own candidate id, never REQUESTED_ACTIONS_ID, and
     * keeps its plan card. A swap still stops at its review card (the approve effect below).
     */
    const direct = candidateId === REQUESTED_ACTIONS_ID;
    approveWhenProposedRef.current = direct;
    approvedCandidateRef.current = candidateId;
    void proposePlan(view.continuation, candidateId).then((prepared) => {
      if (!prepared) {
        approveWhenProposedRef.current = false;
        releaseDispatch(address, proposeKey);
      }
    });
  }, [investigation.result, investigation.resultOrigin, investigation.loading, investigation.error, proposePlan, workflow.view, workflow.loading, workflow.error, address]);
  useEffect(() => {
    const view = investigation.result;
    if (!view || investigation.loading || investigation.error) return;
    const op = view.pendingWrite?.op;
    if (!op) return;
    if (investigation.resultOrigin !== "live") return;
    const key = `write:${view.continuation}:${op}`;
    if (!claimDispatch(address, key)) return;
    void postCopilot({ pending_write: { op }, message: view.originalRequest }, view.originalRequest).then((sent) => {
      if (!sent) releaseDispatch(address, key);
    });
  }, [investigation.result, investigation.resultOrigin, investigation.loading, investigation.error, postCopilot, address]);

  const signJournalXdr = useCallback(async (auto = false) => {
    const view = workflow.view;
    if (!view || workflow.loading || signingJournal) return;
    const step = view.steps.find((entry) => entry.status === "awaiting_signature" && entry.unsignedXdr);
    if (!step?.unsignedXdr) return;
    const signKey = `sign:${view.id}:${step.id}`;
    if (auto && !claimDispatch(address, signKey)) return;
    setSigningJournal(true);
    try {
      const result = await signWorkflowTransaction(step.unsignedXdr, { networkPassphrase: "Test SDF Network ; September 2015", address: address ?? undefined });
      if (result.error || !result.signedTxXdr || result.signerAddress && result.signerAddress !== address) {
        toast.error("The approved transaction could not be signed by the connected wallet.");
        if (auto) releaseDispatch(address, signKey);
        return;
      }
      await confirmWorkflow(result.signedTxXdr);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The transaction could not be signed.");
      if (auto) releaseDispatch(address, signKey);
    } finally {
      setSigningJournal(false);
    }
  }, [workflow.view, workflow.loading, signingJournal, address, confirmWorkflow]);

  /**
   * Auto-approve ON means the journal should not wait for a second click.
   * Propose no longer does the live price/balance pass — Approve does. The Sign
   * Service still enforces caps; this only presses Approve the way the user already armed.
   * A transient risk miss leaves the journal `proposed`; the one-shot claim stops a loop.
   *
   * A journal read back on mount is not an armed click either: `restored` keeps Approve
   * waiting for the person, so returning to the page cannot broadcast what they left alone.
   */
  useEffect(() => {
    if (!sessionSigning) return;
    const view = workflow.view;
    // A plan the live re-check withdrew is not one an armed session may press Approve on.
    if (!view || workflow.loading || workflow.error || workflow.restored || workflow.stale) return;
    if (
      !shouldAutoApproveProposedWorkflow({
        sessionSigning,
        status: view.status,
        steps: view.steps,
        slippageAccepted: view.slippageAccepted,
      })
    ) {
      return;
    }
    const approveKey = `approve:${view.id}:${view.revision}`;
    if (!claimDispatch(address, approveKey)) return;
    void workflow.approve().then((approved) => {
      if (!approved) releaseDispatch(address, approveKey);
    });
  }, [sessionSigning, workflow.view, workflow.loading, workflow.error, workflow.restored, workflow.stale, workflow.approve, address]);

  /**
   * A plan card's Approve (owner layout, 23 Sep): one click prepares the plan and, once it
   * is prepared, approves it. The server still re-checks funds, prices and health at
   * Approve, exactly as a second click would have. A swap is the exception: it keeps its
   * own review card and Confirm (another developer's design), so it stops at prepared.
   */
  const approveCandidate = useCallback((candidateId: string) => {
    const continuation = investigation.result?.continuation;
    if (!continuation) return;
    const proposeKey = `propose:${continuation}:${candidateId}`;
    if (!claimDispatch(address, proposeKey)) return;
    approveWhenProposedRef.current = true;
    approvedCandidateRef.current = candidateId;
    void proposePlan(continuation, candidateId).then((prepared) => {
      if (!prepared) {
        approveWhenProposedRef.current = false;
        releaseDispatch(address, proposeKey);
      }
    });
  }, [investigation.result?.continuation, proposePlan, address]);
  useEffect(() => {
    if (!approveWhenProposedRef.current) return;
    const view = workflow.view;
    if (!view || workflow.loading) return;
    approveWhenProposedRef.current = false;
    if (workflow.error || workflow.stale || view.status !== "proposed") return;
    if (view.swap || view.steps.some((step) => step.op === "swap")) return;
    const approveKey = `approve:${view.id}:${view.revision}`;
    if (!claimDispatch(address, approveKey)) return;
    void workflow.approve().then((approved) => {
      if (!approved) releaseDispatch(address, approveKey);
    });
  }, [workflow.view, workflow.loading, workflow.error, workflow.stale, workflow.approve, address]);

  useEffect(() => {
    if (!sessionSigning) return;
    const view = workflow.view;
    if (!view || workflow.loading || signingJournal || workflow.restored) return;
    if (!view.steps.some((step) => step.status === "awaiting_signature" && step.unsignedXdr)) return;
    void signJournalXdr(true);
  }, [sessionSigning, workflow.view, workflow.loading, workflow.restored, signingJournal, signJournalXdr]);

  const run = useCallback(async (text: string) => {
    if (signing) return;
    /**
     * Supersede the in-flight turn without latching Cancel. `cancelInFlight()` sets
     * `cancelledRef`, and the replacement POST then discarded its own response.
     */
    cancelledRef.current = false;
    if (loading) {
      abortRef.current?.abort("superseded by a new send");
      abortRef.current = null;
      setLoading(false);
    }
    setIntentText(text);
    await dispatchRun(text);
  }, [loading, signing, dispatchRun]);

  /**
   * Send an approved plan back for execution.
   *
   * Posts the plan verbatim — same plan_id, same created_at, same steps. The server
   * re-hashes the steps and refuses anything that no longer matches what was shown, so
   * this must not normalise, reorder or "tidy" the payload on the way out.
   */
  const approvePlan = useCallback(
    async (plan: PlanPreview, lpFill?: { asset: string; amount: number; token_b?: string | null }) => {
      if (loading) return;
      const label = submitted || plan.summary || `Approve ${plan.steps.length} steps`;
      strategyParentRef.current = { id: `plan-${plan.plan_id}`, prompt: label };
      await postCopilot(
        {
          message: "approve plan",
          approved_plan: {
            plan_id: plan.plan_id,
            created_at: plan.created_at,
            steps: plan.steps.map((s) => ({
              kind: s.kind,
              tool: s.tool ?? null,
              op: s.op,
              slots: s.slots,
              asset: s.asset,
              amount: s.amount,
              leverage: s.leverage,
              borrow_asset: s.borrow_asset ?? null,
            })),
            constraints: plan.constraints ?? null,
          },
          lp_fill: lpFill
            ? { asset: lpFill.asset, amount: lpFill.amount, token_b: lpFill.token_b ?? null }
            : null,
        },
        label,
        // chainHop so the strategy row merges into the parent set just above rather
        // than starting a fresh entry.
        { chainHop: true },
      );
    },
    [loading, postCopilot, submitted],
  );

  const resumeMultiLeg = useCallback(
    async (legs: ResumeLeg[], summary: string) => {
      if (!legs.length || loading) return;
      const label = originalIntentRef.current || submitted || summary || `Resume ${legs.length} steps`;
      setHfPaused(false);
      await postCopilot(
        {
          message: label,
          resume_multi_leg: { summary: label, legs },
        },
        label,
        { chainHop: true },
      );
    },
    [loading, postCopilot],
  );

  /**
   * Record what an auto-sign attempt actually achieved.
   *
   * Shared by the enable buttons and by the retry that runs once a signing-authority
   * consent completes, so both write the same rail state. When they diverged, a bind
   * that ended in a working session still left the rail reading "unavailable".
   */
  const applyAutoSignOutcome = useCallback(
    (action: "use_defaults" | "custom" | "disable", data: ChatResponse) => {
      if (!address) return;

      // The wallet is connected here but Vanna holds no signing authority for it.
      // Distinct from "the Sign Service rejected our token" (a fault on our side the
      // user cannot act on) and from success — this one has a specific user action.
      if (data.kind === "needs_wallet_bind") {
        signReadSeq.current += 1;
        if (action === "disable") setAutoApprove(address, false);
        setSignServiceState({ address, status: "unbound", reason: null });
        return;
      }

      if (action === "disable") {
        signReadSeq.current += 1;
        setAutoApprove(address, false);
        setSignServiceState({ address, status: "unknown", reason: null });
        return;
      }
      if (data.kind === "needs_auto_sign") return;

      const facts = (data.data ?? {}) as {
        default_cap_usd?: number;
        error?: string;
        detail?: { detail?: string };
      };
      const mcpEnabled = data.kind !== "error" && !facts.error;
      const reason =
        facts.detail?.detail ||
        facts.error ||
        (data.kind === "error" ? data.message : null) ||
        null;
      signReadSeq.current += 1;
      setSignServiceState({
        address,
        ...(mcpEnabled ? { status: "ok", reason: null } : { status: "unavailable", reason }),
      });

      const fromMcp = Number(facts.default_cap_usd);
      if (Number.isFinite(fromMcp) && fromMcp > 0) setMcpDefaultCap(fromMcp);
      const mcpDef = Number.isFinite(fromMcp) && fromMcp > 0 ? fromMcp : mcpDefaultCap ?? 1000;
      const txCap = action === "custom" ? Number(customTx) || mcpDef : mcpDef;
      const dayCap = action === "custom" ? Number(customDay || customTx) || txCap : mcpDef;
      try {
        localStorage.setItem(
          AUTO_CAPS_KEY,
          JSON.stringify({ max_per_tx_usd: txCap, max_per_day_usd: dayCap }),
        );
      } catch {
        /* ignore */
      }
      setSavedCaps({ tx: txCap, day: dayCap });

      const arm = shouldArmAutoApprove({ mcpEnabled, sessionSigningAvailable });
      if (!arm.arm) {
        setAutoApprove(address, false);
        toast.error(
          arm.reason === "sign_service_not_enforcing"
            ? "Auto-approve refused — the Sign Service is not enforcing spend caps. " +
              "A limit that only lives in this browser can be bypassed."
            : "Auto-approve unavailable for this wallet — every write still needs a signature.",
        );
        return;
      }
      setAutoApprove(address, true);
      toast.success(`Auto-approve on · $${txCap}/tx · $${dayCap}/day`);
    },
    [address, customTx, customDay, sessionSigningAvailable, mcpDefaultCap],
  );

  /**
   * Finish the signing-authority binding here, in the gesture that started it.
   *
   * ## Why this is the primary path
   *
   * Turning auto-sign on IS the user's consent to the thing being asked for. Bouncing
   * them to an external page to click "authorize", then back to click "I've approved
   * it", is a second quest for a decision they already made — and it reads as broken
   * next to a switch they just flipped. Everything needed is already in this tab: they
   * are authenticated with Privy, and Privy's own SDK is the only thing that CAN grant
   * the consent. So the only step this page cannot do is the register callback, which
   * is cross-origin — and the server does that (see lib/copilot/wallet-bind.ts).
   *
   * Nothing here is trusted. `addSigners` succeeding is not what makes the binding
   * real: register makes the Sign Service re-verify quorum-is-signer against Privy,
   * and the enable that follows is the same gated call it always was.
   *
   * Returns false when the silent path cannot run or did not complete, and the caller
   * then leaves the fallback panel on screen. Any `false` here is a real fallback, not
   * a swallowed failure — the reason is surfaced as a toast.
   */
  const completeWalletBindInApp = useCallback(
    async (wb: NonNullable<ChatResponse["wallet_bind"]>): Promise<boolean> => {
      // Only a fresh consent can be completed silently; expired/unavailable need the panel.
      if (wb.status !== "needs_consent" || !wb.request_id) return false;
      // No signer id → the gateway never published one and we must not guess which
      // quorum to authorize. Fallback page carries its own copy.
      if (!wb.signer_id) return false;

      const controls = getPrivyAuthControls();
      if (!controls?.authenticated || typeof controls.authorizeVannaSigner !== "function") {
        return false;
      }

      let authorized: { address: string; delegated: boolean };
      setBindingInApp(true);
      try {
        authorized = await controls.authorizeVannaSigner(wb.signer_id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Includes the user dismissing Privy's own sheet — a legitimate "no", so this
        // is not an error state, just the end of the silent path.
        toast.error(`Could not authorize Vanna as a signer (${msg}).`);
        return false;
      } finally {
        setBindingInApp(false);
      }

      if (!authorized.delegated) {
        toast.error("Privy did not confirm Vanna as a signer on your wallet.");
        return false;
      }

      const data = await postCopilot(
        {
          message: "finish signing authorization",
          auto_sign: {
            action: "bind_register",
            request_id: wb.request_id,
            wallet_address: authorized.address,
            ...(wb.retry_action ? { retry_action: wb.retry_action } : {}),
            ...(wb.max_per_tx_usd != null ? { max_per_tx_usd: wb.max_per_tx_usd } : {}),
            ...(wb.max_per_day_usd != null ? { max_per_day_usd: wb.max_per_day_usd } : {}),
          },
        },
        "Authorize Vanna as an additional signer",
        { chainHop: true },
      );

      // Still unbound → the server left a bind gate on screen with its own reason.
      if (!data || data.kind === "needs_wallet_bind") return false;

      if (wb.retry_action) applyAutoSignOutcome(wb.retry_action, data);
      return true;
    },
    [postCopilot, applyAutoSignOutcome],
  );

  const enableAutoSign = useCallback(
    async (
      action: "start" | "use_defaults" | "custom" | "disable",
      opts?: { quiet?: boolean },
    ) => {
      const label =
        action === "disable"
          ? "Disable auto-sign"
          : action === "use_defaults"
            ? "Enable auto-sign (MCP defaults)"
            : action === "custom"
              ? `Enable auto-sign ($${customTx}/$${customDay || customTx})`
              : "Enable auto-sign";
      if (!opts?.quiet) setSubmitted(submitted ?? label);
      const data = await postCopilot(
        {
          message:
            action === "disable"
              ? "disable auto-sign"
              : action === "use_defaults"
                ? "enable auto-sign with default caps"
                : action === "custom"
                  ? `set auto-sign cap to ${customTx} per tx and ${customDay || customTx} per day`
                  : "enable auto-sign",
          auto_sign: {
            action,
            ...(action === "custom"
              ? { max_per_tx_usd: customTx, max_per_day_usd: customDay || customTx }
              : {}),
          },
          pending_write: response?.auto_sign?.pending_write
            ? {
                op: response.auto_sign.pending_write.op,
                asset: response.auto_sign.pending_write.asset ?? null,
                amount: response.auto_sign.pending_write.amount ?? null,
              }
            : null,
        },
        label,
        // A background switch gets a deadline, so a request that never answers releases the
        // toggle instead of holding `autoApprovePending` forever.
        opts?.quiet ? { background: true, signal: AbortSignal.timeout(AUTO_SIGN_SWITCH_TIMEOUT_MS) } : undefined,
      );
      // Sync local auto-approve with the Sign Service session. Caps that only
      // live in this browser are not a policy — applyAutoSignOutcome refuses to
      // arm unless MCP actually enabled a server-side session.
      if (data?.kind === "needs_wallet_bind" && data.wallet_bind) {
        if (opts?.quiet) setSubmitted(label);
        const finished = await completeWalletBindInApp(data.wallet_bind);
        if (finished) return;
        if (address) setAutoApprove(address, false);
      }

      if (address && data && action !== "start") {
        applyAutoSignOutcome(action, data);
      } else if (address && !data && action !== "disable") {
        setAutoApprove(address, false);
      }
      // No answer at all (the deadline passed, or the request failed): say so, rather than
      // leaving the toggle looking switched while nothing changed on the server.
      if (!data && opts?.quiet) {
        toast.error(action === "disable" ? "Auto-approve did not switch off. Try again." : "Auto-approve did not switch on. Try again.");
      }
    },
    [
      postCopilot,
      customTx,
      customDay,
      response,
      submitted,
      address,
      applyAutoSignOutcome,
      completeWalletBindInApp,
    ],
  );

  const handleAutoApproveToggle = useCallback(() => {
    /**
     * A click while the previous switch is still in flight used to vanish without a word,
     * and that request had no deadline — one that hung left the toggle dead until a server
     * restart (24 Sep, live: turned off, could not turn back on). Say why nothing happened.
     */
    if (autoApprovePending) {
      toast("Still switching auto-approve. One moment.");
      return;
    }
    if (loading) {
      toast("Wait for the current reply to finish, then switch auto-approve.");
      return;
    }
    if (!address) {
      toast.error("Connect a wallet first.");
      return;
    }
    if (walletKind === "freighter") {
      const next = !freighterAutoApprove;
      setAutoApprove(address, next);
      if (next) {
        toast.success("Auto-dispatch on — transactions will open directly in Freighter");
      } else {
        toast.success("Auto-dispatch off");
      }
      return;
    }
    if (autoApproveUiOn) {
      setAutoApprove(address, false);
      setSignServiceState((prev) => ({ ...prev, status: "unknown" }));
      setAutoApprovePending(true);
      void enableAutoSign("disable", { quiet: true }).finally(() => {
        setAutoApprovePending(false);
      });
      toast.success("Auto-approve off");
      return;
    }
    if (!sessionSigningAvailable) {
      toast.error("Connect a wallet first.");
      return;
    }
    if (capsEnforced) {
      setAutoApprove(address, true);
      toast.success(
        savedCaps ? `Auto-approve on · $${savedCaps.tx}/tx · $${savedCaps.day}/day` : "Auto-approve on",
      );
      return;
    }
    if (railCapsMode === "custom" && Number(customTx) <= 0) {
      toast.error("Enter a per-tx cap above 0.");
      return;
    }
    setAutoApprove(address, true);
    setAutoApprovePending(true);
    void enableAutoSign(railCapsMode === "custom" ? "custom" : "use_defaults", { quiet: true }).finally(() => {
      setAutoApprovePending(false);
    });
  }, [
    loading,
    autoApprovePending,
    address,
    walletKind,
    freighterAutoApprove,
    autoApproveUiOn,
    sessionSigningAvailable,
    capsEnforced,
    savedCaps,
    railCapsMode,
    customTx,
    enableAutoSign,
  ]);

  /**
   * Poll the pending additional-signer consent, and let the server finish the job.
   *
   * `retry_action` travels with the poll so the enable the user originally asked for is
   * re-run server-side the instant the binding lands. Without it the happy path ends at
   * "authorized" — true, but one silent step short of the toggle they were trying to
   * flip, which reads as the same failure they started with.
   */
  const checkWalletBind = useCallback(
    async (wb: NonNullable<ChatResponse["wallet_bind"]>) => {
      if (!wb.request_id) return;
      const data = await postCopilot(
        {
          message: "check signing authority",
          auto_sign: {
            action: "bind_status",
            request_id: wb.request_id,
            ...(wb.retry_action ? { retry_action: wb.retry_action } : {}),
            ...(wb.max_per_tx_usd != null ? { max_per_tx_usd: wb.max_per_tx_usd } : {}),
            ...(wb.max_per_day_usd != null ? { max_per_day_usd: wb.max_per_day_usd } : {}),
          },
        },
        "Check signing authority",
        { chainHop: true },
      );
      if (data && wb.retry_action && data.kind !== "needs_wallet_bind") {
        applyAutoSignOutcome(wb.retry_action, data);
      }
    },
    [postCopilot, applyAutoSignOutcome],
  );

  /**
   * Auto-poll a consent the user is in the middle of granting.
   *
   * Bounded by MCP's own backoff schedule rather than a loop of our own: when it is
   * exhausted the panel falls back to an explicit "I've approved it" button. Polling
   * forever would keep a request in flight behind a window the user may have closed.
   */
  const bindPollRef = useRef<{ id: string; attempt: number } | null>(null);
  useEffect(() => {
    const wb = response?.kind === "needs_wallet_bind" ? response.wallet_bind : null;
    if (!wb?.request_id || (wb.status !== "needs_consent" && wb.status !== "pending")) {
      bindPollRef.current = null;
      return;
    }
    // The in-app consent owns the flow while it runs; polling underneath it would
    // race its own register call for the same single-use request.
    if (loading || bindingInApp) return;
    const schedule =
      wb.poll_schedule_seconds?.length ? wb.poll_schedule_seconds : [2, 4, 8, 16, 32];
    const cur = bindPollRef.current;
    const attempt = cur && cur.id === wb.request_id ? cur.attempt : 0;
    if (attempt >= schedule.length) return;
    bindPollRef.current = { id: wb.request_id, attempt: attempt + 1 };
    const t = setTimeout(
      () => {
        void checkWalletBind(wb);
      },
      Math.max(1, Number(schedule[attempt]) || 2) * 1000,
    );
    return () => clearTimeout(t);
  }, [response, loading, bindingInApp, checkWalletBind]);

  /** Mint a fresh consent link (first time, or after one expired). */
  const startWalletBind = useCallback(
    async (retryAction?: "use_defaults" | "custom" | "disable") => {
      await postCopilot(
        {
          message: "authorize vanna to sign for my wallet",
          auto_sign: {
            action: "bind_start",
            ...(retryAction ? { retry_action: retryAction } : {}),
          },
        },
        "Authorize Vanna as an additional signer",
      );
    },
    [postCopilot],
  );

  /**
   * Resume a write after the user picks a USDC variant (BLUSDC / AQUSDC / SOUSDC).
   * Server stored the pending op+amount; we inject the chosen asset and re-run.
   *
   * Mid multi-leg this must resume the paused leg + every still-outstanding leg — the
   * same pattern as submitLegAmount. A bare pending_write alone ran the op as a new hop
   * ("lend 125 AQUSDC"), left the clarifying "Lend 125 USDC on Earn" stuck forever, and
   * orphaned every skipped leg behind it.
   */
  const pickClarifyOption = useCallback(
    async (opt: ClarifyOption) => {
      const pw = response?.pending_write;
      const steps = strategyStepsRef.current;
      const clarifyingIdx = steps.findIndex((s) => {
        const st = String(s.status || "");
        return st === "clarification" || st === "needs_input";
      });
      if (clarifyingIdx >= 0 && steps.length > 0) {
        const clarifying = steps[clarifyingIdx];
        const amount =
          clarifying.amount != null && Number(clarifying.amount) > 0
            ? Number(clarifying.amount)
            : pw?.amount != null
              ? Number(pw.amount)
              : null;
        const carry = (s: MultiLegStepUi) => ({
          op: String(s.op || "step"),
          asset: s.asset ?? null,
          amount: s.amount != null && Number(s.amount) > 0 ? Number(s.amount) : null,
          leverage: s.leverage ?? null,
          label: s.label,
        });
        const first = {
          op: String(clarifying.op || pw?.op || "lend"),
          asset: opt.id,
          amount: amount != null && Number.isFinite(amount) && amount > 0 ? amount : null,
          leverage: clarifying.leverage ?? pw?.leverage ?? null,
          label: clarifying.label,
        };
        const rest = steps
          .slice(clarifyingIdx + 1)
          .filter((s) => !["ok", "done"].includes(String(s.status || "")))
          .map(carry);
        const summary = String(
          strategyMetaRef.current.strategy_summary || submitted || "Continue strategy",
        );
        void resumeMultiLeg([first, ...rest], summary);
        return;
      }
      if (!pw?.op) {
        /**
         * "Which USDC do you mean?" can originate from a READ (`can_borrow`/
         * `can_withdraw`), not just a write — there is no `pending_write` to resume
         * here at all, so this must never fall into the pending-write resumption
         * path below. Substitute the chosen variant into the ORIGINAL message text
         * ("Can i borrow 20 USDC?" → "Can i borrow 20 AQUSDC?") and resubmit it as a
         * fresh message, through the exact same routing a typed message gets — a
         * bare `run(opt.id)` used to submit just the ticker alone, losing the amount
         * and the verb, and answering something unrelated.
         */
        if (response?.intent?.template_id === "clarify_usdc_variant" && submitted) {
          const substituted = submitted.replace(/\busdc\b/i, opt.id);
          await run(substituted !== submitted ? substituted : opt.id);
          return;
        }
        if (response?.intent?.template_id === "clarify_pool_venue" && submitted) {
          const withVenue = /\bpool\b/i.test(submitted)
            ? submitted.replace(/\bpool\b/i, `${opt.id} pool`)
            : `${submitted} ${opt.id}`;
          await run(withVenue);
          return;
        }
        // Fallback: rephrase as a full message
        await run(`${opt.id}`);
        return;
      }
      // Margin-style repay share chip (10% / 25% / 50% / 100%).
      if (pw.clarify_slot === "fraction") {
        const frac = Number(opt.id);
        if (!Number.isFinite(frac) || !(frac > 0)) {
          await run(opt.label || opt.id);
          return;
        }
        const label =
          frac >= 1
            ? `Repay all my ${pw.asset || "debt"}`
            : `Repay ${Math.round(frac * 100)}% of my ${pw.asset || ""} debt`.trim();
        setSubmitted(label);
        setIntentText(label);
        await postCopilot(
          {
            message: label,
            pending_write: {
              op: pw.op,
              asset: pw.asset ?? null,
              amount: null,
              fraction: frac,
              leverage: pw.leverage ?? null,
              borrow_asset: pw.borrow_asset ?? null,
              borrow_amount: pw.borrow_amount ?? null,
            },
          },
          label,
        );
        return;
      }
      // The chip answers ONE slot. A leveraged write has two, and writing the pick
      // into `asset` regardless would overwrite a collateral choice the user already
      // made when the question was about the borrow side. The server says which slot
      // it asked about; everything not asked about is carried through untouched.
      const forBorrowSlot = pw.clarify_slot === "borrow";
      const label = `${pw.op.replace(/_/g, " ")} ${pw.amount ?? ""} ${opt.id}`.trim();
      setSubmitted(label);
      setIntentText(label);
      await postCopilot(
        {
          message: label,
          pending_write: {
            op: pw.op,
            asset: forBorrowSlot ? (pw.asset ?? null) : opt.id,
            amount: pw.amount ?? null,
            leverage: pw.leverage ?? null,
            borrow_asset: forBorrowSlot ? opt.id : (pw.borrow_asset ?? null),
            borrow_amount: pw.borrow_amount ?? null,
            fraction: pw.fraction ?? null,
          },
        },
        label,
      );
    },
    [response, postCopilot, run, resumeMultiLeg, submitted],
  );

  /**
   * Client wallet sign for the transaction MCP already built (used when Sign
   * Service auto-sign has no bound user identity).
   *
   * Order matters. If MCP handed back an `unsigned_xdr`, that envelope is already
   * simulated and resource-assembled for this exact call — we sign and submit it
   * as-is. Rebuilding the same operation locally would re-run the app's Registry
   * and collateral pre-flight, which is what produced the misleading "XLM not set
   * in the Registry" and "Failed to get user address" toasts even though MCP's own
   * simulation had succeeded. The local `executeAction` path stays only as a
   * fallback for turns where no XDR came back.
   */
  const signWithWallet = useCallback(async () => {
    // Prefer live response — after multi-leg hop advance a closed-over `response`
    // can still be the previous leg (no borrow XDR), which auto-blocked the spinner.
    const response = responseRef.current;
    const hopKey = response
      ? hopAutoSubmitKey({
          requestId: response.request_id,
          op: response.preview?.action?.op,
          amount: response.preview?.action?.amount,
          asset: response.preview?.action?.asset,
          summary: response.preview?.human_summary,
        })
      : null;
    const markHopAutoFailed = () => {
      if (hopKey) setAutoSubmitBlockedKey(hopKey);
    };

    const action = response?.preview?.action;
    const nextStep = response?.next_step ?? null;
    // A mock-mode or garbled envelope falls back to the local rebuild rather than
    // erroring at the sign step (see `isSignableXdr`).
    const xdr = isSignableXdr(response?.unsigned_xdr) ? response!.unsigned_xdr! : null;
    if (!xdr && (!action || !isExecutable(action))) {
      toast.error("Nothing to sign — re-run the request.");
      markHopAutoFailed();
      return;
    }
    if (cancelledRef.current) {
      return;
    }
    if (!address) {
      toast.error("Connect your wallet first.");
      markHopAutoFailed();
      return;
    }
    setSigning(true);
    try {
      const amount = typeof action?.amount === "number" && action.amount > 0 ? action.amount : 0;
      const result: ExecuteResult | SignXdrResult = xdr
        ? await signAndSubmitMcpXdr(
            xdr,
            address,
            (hash) => {
            // Submitted, not yet confirmed. Stamp the hash on the leg that is
            // awaiting signature so the card shows something checkable during
            // the 30–60s ledger wait instead of a bare spinner. Status stays
            // pre-terminal, so toRunLegStatus keeps rendering it as running —
            // this must NOT mark the leg ok, the ledger has not answered yet.
            const { steps: withHash, claimed: stamped } = claimFirstAwaitingLeg(
              strategyStepsRef.current,
              (s) => ({ ...s, tx_hash: s.tx_hash ?? hash, message: ledgerWaitCopy(hash) }),
            );
            if (stamped) {
              strategyStepsRef.current = withHash;
              setStrategySteps(withHash);
            }
            toast(ledgerWaitCopy(hash), { duration: 6000 });
            },
            () => cancelledRef.current,
          )
        : await executeAction(action!, {
            amount,
            walletAddress: address,
            smartAccount,
          });
      if (cancelledRef.current && !(result.ok && result.hash)) {
        setSigning(false);
        return;
      }
      if (result.ok) {
        // This hop signed — only THIS key was blocked, if any.
        badSeqRebuildRef.current = false;
        if (hopKey) {
          setAutoSubmitBlockedKey((k) => (k === hopKey ? null : k));
        }
        toast.success(result.hash ? `Submitted · ${result.hash.slice(0, 10)}…` : "Submitted");
        const summary = response?.preview?.human_summary || submitted || "Write submitted";
        // Fold wallet-sign success into strategy parent log when chaining; else one row.
        pushLog(
          strategyParentRef.current?.prompt || summary,
          {
            kind: "executed",
            message: summary,
            mcp: response?.mcp ?? null,
            request_id: response?.request_id,
            data: strategyParentRef.current ? undefined : null,
          } as ChatResponse,
          {
            chainHop: !!strategyParentRef.current || !!nextStep,
            hopLabel: summary,
          },
        );
        pushActivity(summary, result.hash);
        await refreshRailStats({ force: true, after: result.hash ?? null });
        if (result.hash) {
          const runLegs = strategyStepsRef.current;
          const isRun = isRealStrategyRun(runLegs, response?.data ?? null);
          if (isRun && !runReceiptIdRef.current) {
            runReceiptIdRef.current = `run-${result.hash.slice(0, 8)}`;
          }
          const receipt = buildRunReceipt({
            legs: runLegs,
            isRun,
            runId: runReceiptIdRef.current,
            requestId: response?.request_id ?? null,
            network: investigation.result?.scope.network || "testnet",
            single: action ?? null,
            txHash: result.hash,
          });
          void updateExecutionReceipt(receipt);
        }
        if (investigation.turns.length > 0) {
          /**
           * The turn becomes the receipt, not the request.
           *
           * `response.message` is the sentence written before the signature — it describes
           * a signature still being waited for. It was kept as the turn text unless it
           * contained one of two exact phrases, so every other pre-signature wording
           * survived as the record of a settled transaction. Built from what happened
           * instead: what was signed, its hash, the health factor the rail now shows.
           */
          void investigation.updateLastAssistantText(
            answerToText(
              singleWriteReceiptAnswer({
                summary,
                op: action?.op ?? null,
                asset: action?.asset ?? null,
                amount: action?.amount ?? null,
                txHash: result.hash ?? null,
                hf: readLiveHfFromStore(),
              }),
            ),
          );
        }

        // Wait until Horizon shows this tx's sequence as applied before asking MCP
        // to build the next leg. Otherwise hop 2 is simulated against a stale seq and
        // submit fails with txBadSeq (classic multi-leg race after deposit→borrow).
        if (xdr) {
          const seqInfo = readEnvelopeSourceSequence(xdr);
          if (seqInfo) {
            await waitForAccountSequenceApplied(seqInfo.source, seqInfo.sequence);
          }
        }

        // Multi-leg: resume full remaining plan (not 2-deep follow_up only).
        //
        // Both field names carry the same thing: `remaining_legs` is the older next_step
        // chain, `resume_legs` (with `can_resume`) is what the plan / MultiLegAgent path
        // returns. The `executed` chain effect below was fixed to read both; THIS path —
        // the one taken after a client wallet signature — still read only the first. So an
        // approved plan signed in the wallet found `remainingFromData` null, skipped the
        // resume, and fell through to the "final leg" branch, which announced the strategy
        // was live after a single leg had settled.
        const legsFromData = (key: string) =>
          Array.isArray((response?.data as any)?.[key])
            ? ((response!.data as any)[key] as Array<{
                op: string;
                asset?: string | null;
                amount?: number | null;
                leverage?: number | null;
                label?: string;
              }>)
            : null;

        // Settle the signed leg BEFORE deciding what still remains.
        //
        // Computing `remainingFromData` while this leg still read `needs_sign` made
        // `legsFromUnsettledSteps` re-queue the same borrow. Live: one "50 AQUSDC at 2x
        // borrow XLM" plan called vanna_borrow ~15 times (~309 XLM each) until debt
        // piled up. Claim first, then pick remaining from the updated card.
        const d0 = (response?.data ?? {}) as Record<string, unknown>;
        const raw = Array.isArray(d0.multi_leg_steps)
          ? (d0.multi_leg_steps as MultiLegStepUi[])
          : strategyStepsRef.current.length
            ? strategyStepsRef.current
            : null;
        // Exactly ONE leg is settled by one signature: the one that was awaiting it.
        // Including "pending" here, and stamping every match with this hash, made a single
        // signature mark legs 3 and 4 as "DONE tx c7ec9aa…" — leg 2's hash — while only
        // two transactions existed on-chain. Claiming a transaction that never happened is
        // the worst thing this UI can do, so pending legs are never touched and only the
        // first awaiting leg takes the hash.
        const patched: MultiLegStepUi[] = claimFirstAwaitingLeg(raw, (s) => ({
          ...s,
          status: "ok",
          tx_hash: result.hash ?? s.tx_hash ?? null,
          // Drop the "confirming on ledger" line the submit-time stamp left —
          // the ledger has answered, so it is no longer true.
          message: undefined,
        })).steps;
        if (patched.length) {
          absorbStrategySteps(patched);
          strategyMetaRef.current = {
            ...strategyMetaRef.current,
            ...d0,
            multi_leg_steps: strategyStepsRef.current,
          };
        }

        // The server only ever plans what we hand it, and we now hand it ONE leg
        // per hop, so once it stops reporting later legs the client's own queue
        // is the authority. Without this fallback the strategy would silently
        // stop after leg 2 instead of continuing.
        const serverRemaining =
          legsFromData("remaining_legs") ?? legsFromData("resume_legs");
        const cardUnsettled = legsFromUnsettledSteps(strategyStepsRef.current);
        // Complete = the FULL strategy card, never the hop's 1-row patch.
        // Live bug: deposit hop returned multi_leg_steps:[deposit]; claiming it
        // made patched.every(ok) true → complete → cleared the borrow/supply
        // tail and locked strategyCompleteRef while the card still showed
        // "Borrow PENDING" forever ("Leg 2 settled · advancing to leg 3").
        const complete =
          strategyCompleteRef.current ||
          strategyIsComplete(strategyStepsRef.current);
        const remainingFromData = pickRemainingLegs(
          serverRemaining,
          strategyTailRef.current,
          complete ? [] : cardUnsettled,
        ).filter((r) => !farmWriteAlreadySettled(r.op, strategyStepsRef.current));

        const targetFloor =
          strategyMetaRef.current.min_hf != null &&
          Number.isFinite(Number(strategyMetaRef.current.min_hf))
            ? Number(strategyMetaRef.current.min_hf)
            : null;

        const currentHf = readLiveHfFromStore() ?? (liveHf != null && Number.isFinite(liveHf) ? liveHf : null);
        const hfFloorPause = shouldPauseForHealthFloor({
          floor: targetFloor,
          hf: currentHf,
          remainingOps: remainingFromData.map((r) => r.op),
          settledOps: strategyStepsRef.current.map((s) => s.op),
        });

        if (hfFloorPause) {
          strategyTailRef.current = remainingFromData;
          strategyCompleteRef.current = false;
          setHfPaused(true);
          if (originalIntentRef.current) setIntentText(originalIntentRef.current);
          const floor = targetFloor as number;
          const hf = currentHf as number;
          setResponse({
            kind: "executed",
            message:
              `HF ≈ ${hf.toFixed(2)} is below your floor of ${floor.toFixed(2)}. ` +
              `Further collateral/debt steps are paused — continue or stop here.`,
            answer: localExecutionAnswer({
              intent: originalIntentRef.current || submitted,
              legs: strategyStepsRef.current,
              hf,
              floor,
              pausedHf: true,
            }),
            preview: response?.preview ?? null,
            execution: { status: "paused_hf", tx_hash: result.hash ?? null },
            request_id: response?.request_id,
            data: {
              ...(response?.data || {}),
              multi_leg: true,
              multi_leg_steps: strategyStepsRef.current,
              headline: `Paused — HF ${hf.toFixed(2)} below floor ${floor.toFixed(2)}`,
              strategy_complete: false,
              hf_paused: true,
              can_resume: true,
              remaining_legs: remainingFromData,
              prefer_resume_multi_leg: false,
            },
          });
          return;
        }
        const pauseForLp =
          isUnsizedAddLiquidity(remainingFromData[0]) &&
          !farmWriteAlreadySettled(remainingFromData[0]?.op, strategyStepsRef.current);
        if (pauseForLp) {
          absorbStrategySteps(
            remainingFromData.filter(isUnsizedAddLiquidity).map(pendingLpStepFromResume),
          );
          strategyTailRef.current = remainingFromData;
          setResponse({
            kind: "executed",
            message: "Swap settled. How much liquidity should I add?",
            mcp: response?.mcp ?? null,
            preview: response?.preview ?? null,
            execution: { status: "signed_and_submitted", tx_hash: result.hash ?? null },
            request_id: response?.request_id,
            data: {
              ...strategyMetaRef.current,
              ...(response?.data || {}),
              multi_leg: true,
              multi_leg_steps: strategyStepsRef.current,
              remaining_legs: remainingFromData,
              prefer_resume_multi_leg: false,
              strategy_complete: false,
              lp_input: (() => {
                const r0 = remainingFromData[0] as {
                  token_a?: string | null;
                  token_b?: string | null;
                  token_in?: string | null;
                  token_out?: string | null;
                  asset?: string | null;
                } | undefined;
                const a = String(r0?.token_a || r0?.token_in || "").toUpperCase();
                const b = String(r0?.token_b || r0?.token_out || r0?.asset || "").toUpperCase();
                return a && b ? { sides: [a, b] } : undefined;
              })(),
            },
          });
          return;
        }
        /**
         * Same rule as the resume effect below: advancing is not signing.
         *
         * This is the hop that runs the instant a leg is signed and submitted, so with
         * `!!autoApprove` here a run with the switch off stalled at exactly the moment
         * it should have moved on - leg 1 on chain, the queue never asked for leg 2.
         * Gating both sites made the stall survive fixing either one alone.
         */
        const preferResume =
          !complete &&
          !pauseForLp &&
          (shouldAutoResume({
            complete: false,
            serverRemaining,
            clientTail: strategyTailRef.current,
            preferFlag: (response?.data as any)?.prefer_resume_multi_leg === true,
            canResumeWithAutoApprove:
              (response?.data as any)?.can_resume === true && autoApprove,
          }) ||
            remainingFromData.length > 0);

        // Done only when the full card is terminal AND nothing is queued.
        // Do not use `!preferResume` here — with a false complete that would
        // clear the tail while borrow/supply were still pending.
        const done = complete && remainingFromData.length === 0;
        if (done) {
          strategyTailRef.current = [];
          strategyCompleteRef.current = true;
        }

        setResponse((prev) => {
          if (!prev) return prev;
          const d = (prev.data ?? {}) as Record<string, unknown>;
          return {
            ...prev,
            kind: "executed",
            next_step: done ? null : prev.next_step,
            data: {
              ...d,
              multi_leg_steps: strategyStepsRef.current.length
                ? strategyStepsRef.current
                : patched,
              headline: done ? "All steps completed — strategy is live." : undefined,
              can_resume: done ? false : d.can_resume,
              prefer_resume_multi_leg: done ? false : d.prefer_resume_multi_leg,
              remaining_legs: done ? null : d.remaining_legs,
              resume_legs: done ? null : d.resume_legs,
              strategy_complete: done ? true : d.strategy_complete,
            },
            execution: {
              status: done ? "completed" : "partial",
              tx_hash: result.hash ?? prev.execution?.tx_hash ?? null,
              steps: prev.execution?.steps,
            },
          } as ChatResponse;
        });

        if (preferResume && remainingFromData.length > 0) {
          if (cancelledRef.current) return;
          const parentPrompt =
            originalIntentRef.current ||
            strategyParentRef.current?.prompt ||
            submitted ||
            "Continue strategy";
          if (!strategyParentRef.current) {
            strategyParentRef.current = {
              id: response?.request_id || `strat-${Date.now()}`,
              prompt: parentPrompt,
            };
          }
          // ONE leg per hop. Do NOT drop `head` from the queue until the hop
          // actually returns — advancing early + an aborted fetch lost borrow and
          // the run summarized after deposit alone.
          const { head, tail } = splitResumeBatch(remainingFromData);
          if (!head.length) return;
          const resumeKey = `${response?.request_id ?? "exec"}:resume:${remainingFromData.map((l) => l.op).join(",")}`;
          nextStepFiredRef.current = resumeKey;
          // Keep the full remaining list until postCopilot succeeds.
          strategyTailRef.current = remainingFromData;
          toast.success(
            `Step confirmed — running ${head[0]?.label || head[0]?.op || "next leg"}` +
              (tail.length ? ` (${tail.length} more after this)…` : "…"),
            { duration: 3500 },
          );
          setLoading(true);
          await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
          if (cancelledRef.current) return;
          await refreshRailStats({ force: true, after: result.hash ?? null });
          const hop = await postCopilot(
            {
              message: parentPrompt,
              resume_multi_leg: {
                summary: parentPrompt,
                legs: head,
              },
            },
            parentPrompt,
            { chainHop: true },
          );
          // Only drop the head from the client queue after the hop returns a
          // usable next response (staged / executed / auto-sign / bind). error,
          // blocked, or null means this leg never advanced — keep the full tail
          // so the user can retry without losing supply after a failed borrow POST.
          if (!hop || !isChainableHopResponse(hop)) {
            strategyTailRef.current = remainingFromData;
            nextStepFiredRef.current = null;
            return;
          }
          strategyTailRef.current = tail;
          return;
        }

        // Legacy 2-hop next_step chain (deposit→borrow only) — never after hard-stop.
        if (!done && nextStep?.op && nextStep.amount != null && nextStep.amount > 0) {
          if (cancelledRef.current) return;
          const label =
            nextStep.label ||
            `Auto step ${nextStep.step ?? 2}: ${nextStep.op} ${nextStep.amount} ${nextStep.asset || ""}`.trim();
          toast.success("Step confirmed — running next step automatically…", { duration: 4000 });
          if (!strategyParentRef.current) {
            strategyParentRef.current = {
              id: response?.request_id || `strat-${Date.now()}`,
              prompt: submitted || summary,
            };
          }
          setResponse({
            kind: "executed",
            message:
              `Step done${result.hash ? ` · ${result.hash.slice(0, 12)}…` : ""}.\n` +
              `Waiting a few seconds for the ledger, then automatically: ${label}.`,
            mcp: response?.mcp ?? null,
            preview: response?.preview ?? null,
            execution: { status: "signed_and_submitted", tx_hash: result.hash ?? null },
            request_id: response?.request_id,
            next_step: nextStep,
            data: {
              ...(response?.data || {}),
              multi_leg_steps: strategyStepsRef.current,
            },
          });
          setLoading(true);
          await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
          if (cancelledRef.current) return;
          await refreshRailStats({ force: true, after: result.hash ?? null });
          const hop = await postCopilot(
            {
              message: `${nextStep.op.replace(/_/g, " ")} ${nextStep.amount} ${nextStep.asset || ""}`.trim(),
              pending_write: {
                op: nextStep.op,
                asset: nextStep.asset ?? null,
                amount: nextStep.amount ?? null,
                leverage: nextStep.leverage ?? null,
                follow_up: nextStep.follow_up ?? null,
              },
            },
            label,
            { chainHop: true },
          );
          if (hop?.message) {
            void investigation.updateLastAssistantText(hop.message);
          }
          return;
        }

        // Final client-signed leg: request a model receipt (server only summarizes when
        // it runs the last leg itself). Legs + hashes only — never invent HF/balances.
        const finalLegs = strategyStepsRef.current;
        const hasStrategy = finalLegs.length > 0;
        const ranLegs = finalLegs
          .filter((s) => {
            const st = String(s.status || "");
            return (
              st === "ok" ||
              st === "done" ||
              st === "error" ||
              st === "blocked" ||
              st === "stopped_hf" ||
              !!s.tx_hash
            );
          })
          .map((s) => ({
            action: String(s.label || `Step ${s.index ?? ""}`),
            status: String(s.status || "unknown"),
            tx_hash: s.tx_hash != null ? String(s.tx_hash) : null,
          }));
        const intent =
          originalIntentRef.current ||
          strategyParentRef.current?.prompt ||
          submitted ||
          summary;

        if (hasStrategy && ranLegs.some((l) => l.status === "ok" || l.status === "done")) {
          /**
           * "All steps completed" only when they are. This branch is reached after the
           * last signature the CLIENT was asked for, which is not the same as the last
           * leg of the strategy: a leg still waiting on an amount was never staged, so it
           * never asked for a signature. Announcing completion there told the user a
           * delta-neutral carry was live when only its collateral leg had settled.
           */
          const unfinished = strategyStepsRef.current.filter(
            (s) => !["ok", "done", "skipped"].includes(String(s.status ?? "")),
          );
          const settled = strategyIsComplete(strategyStepsRef.current);
          const stillQueued =
            !settled &&
            hasMoreLegs(
              null,
              strategyTailRef.current,
              legsFromUnsettledSteps(strategyStepsRef.current),
            );
          if (settled && !stillQueued) {
            strategyCompleteRef.current = true;
            strategyTailRef.current = [];
          }
          setResponse({
            kind: "executed",
            message: `Submitted with your wallet${result.hash ? ` · ${result.hash}` : ""}.`,
            mcp: response?.mcp ?? null,
            preview: response?.preview ?? null,
            answer:
              settled && !stillQueued
                ? localExecutionAnswer({
                    intent,
                    legs: strategyStepsRef.current,
                    hf: readLiveHfFromStore() ?? liveHf,
                    floor:
                      strategyMetaRef.current.min_hf != null
                        ? Number(strategyMetaRef.current.min_hf)
                        : null,
                  })
                : undefined,
            execution: {
              status: settled && !stillQueued ? "completed" : "signed_and_submitted",
              tx_hash: result.hash ?? null,
            },
            request_id: response?.request_id,
            next_step: settled && !stillQueued ? null : response?.next_step,
            data: {
              ...strategyMetaRef.current,
              multi_leg: true,
              multi_leg_steps: strategyStepsRef.current,
              headline: unfinished.length || stillQueued
                ? `${strategyStepsRef.current.length - unfinished.length} of ${strategyStepsRef.current.length} steps settled — ${unfinished.length || "more"} still to run.`
                : "All steps completed — strategy is live.",
              ...(settled && !stillQueued
                ? {
                    strategy_complete: true,
                    remaining_legs: null,
                    resume_legs: null,
                    prefer_resume_multi_leg: false,
                    can_resume: false,
                  }
                : {}),
            },
          });
          if (settled && !stillQueued && originalIntentRef.current) {
            setIntentText(originalIntentRef.current);
          }
          // Receipt is already on screen. Vertex may enrich the headline in the
          // background — do not keep the run in "Running…" while it thinks.
          if (!cancelledRef.current && settled && !stillQueued) {
            const stratId = strategyParentRef.current?.id || response?.request_id || "exec";
            const sumKey = `${stratId}:summarize:${finalLegs.length}`;
            if (nextStepFiredRef.current !== sumKey) {
              nextStepFiredRef.current = sumKey;
              void postCopilot(
                {
                  message: intent,
                  summarize_execution: {
                    intent: originalIntentRef.current || response?.preview?.human_summary || intent,
                    legs: ranLegs,
                    final_health_factor: readLiveHfFromStore() ?? liveHf,
                    health_factor_floor:
                      strategyMetaRef.current.min_hf != null
                        ? Number(strategyMetaRef.current.min_hf)
                        : null,
                  },
                },
                intent,
                { chainHop: true, background: true },
              );
            }
          }
          return;
        }

        setResponse({
          kind: "executed",
          message: `Submitted with your wallet${result.hash ? ` · ${result.hash}` : ""}.`,
          mcp: response?.mcp ?? null,
          preview: response?.preview ?? null,
          execution: { status: "signed_and_submitted", tx_hash: result.hash ?? null },
          request_id: response?.request_id,
          data: response?.data
            ? {
                ...response.data,
                multi_leg_steps: strategyStepsRef.current.length
                  ? strategyStepsRef.current
                  : (response.data as any).multi_leg_steps,
              }
            : null,
        });
      } else {
        const errText = result.error || "Sign failed";
        const badSeq =
          ("code" in result && result.code === "BAD_SEQ") ||
          ("code" in result && result.code === "ALREADY_SUBMITTED") ||
          isBadSequenceError(errText);

        // Stale sequence: never re-sign the same XDR — rebuild one hop and try once.
        // One rebuild only (flag stays true until a hop succeeds). Re-signing the
        // same XDR after txBadSeq always fails — sequence is already past it.
        if (badSeq && action?.op && !badSeqRebuildRef.current) {
          badSeqRebuildRef.current = true;
          toast("Sequence outdated — rebuilding a fresh transaction…", { duration: 4000 });
          try {
            const parentPrompt =
              strategyParentRef.current?.prompt ||
              String((response?.data as any)?.strategy_summary || submitted || action.op);
            const leg = {
              op: action.op,
              asset: action.asset ?? null,
              amount:
                typeof action.amount === "number" && action.amount > 0 ? action.amount : null,
              leverage: action.leverage ?? null,
              label: response?.preview?.human_summary || undefined,
            };
            // Clear so the rebuilt hop can auto-submit again.
            if (hopKey) {
              if (autoSubmittedRef.current === hopKey) autoSubmittedRef.current = null;
              setAutoSubmitBlockedKey((k) => (k === hopKey ? null : k));
            }
            setSigning(false);
            const rebuilt = await postCopilot(
              {
                message: parentPrompt,
                resume_multi_leg: {
                  summary: parentPrompt,
                  legs: [leg],
                },
              },
              parentPrompt,
              { chainHop: true },
            );
            if (
              rebuilt &&
              (rebuilt.kind === "needs_wallet_sign" ||
                (rebuilt.kind === "needs_auto_sign" && isSignableXdr(rebuilt.unsigned_xdr)))
            ) {
              toast.success("Transaction rebuilt — signing…", { duration: 2500 });
              // Direct re-sign (flag still true → no second rebuild loop if this fails).
              if (sessionSigning) {
                await new Promise((r) => setTimeout(r, 50));
                void signWithWallet();
              }
              return;
            }
            toast.error(
              rebuilt?.kind === "error"
                ? rebuilt.message || errText
                : `${errText} Rebuild did not return a new envelope — try the step again.`,
            );
            markHopAutoFailed();
            return;
          } catch {
            toast.error(errText);
            markHopAutoFailed();
            return;
          }
        }

        toast.error(errText);
        // The refusal belongs in the thread, not only in a toast — see noteOutcome.
        // A rejected signature that leaves no record reads, on the next scroll, like a
        // request that is still waiting.
        if (!("hash" in result && result.hash)) {
          noteOutcome(`The signature was not completed — nothing was submitted. ${errText}`);
        }
        // Sign/submit failed: stay on needs_wallet_sign (same staged panel) but stop
        // the auto-submit spinner for THIS hop so Approve & sign is available.
        // Do not advance multi-leg queue on a failed signature.
        markHopAutoFailed();
        // A failed-but-submitted turn (confirmation timeout) still has a hash worth
        // keeping, so the user gets an explorer link instead of a dead end.
        if ("hash" in result && result.hash) {
          pushActivity(response?.preview?.human_summary || submitted || "Submitted", result.hash);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign failed");
      markHopAutoFailed();
    } finally {
      setSigning(false);
    }
  }, [
    address,
    smartAccount,
    submitted,
    noteOutcome,
    pushActivity,
    postCopilot,
    refreshRailStats,
    absorbStrategySteps,
    sessionSigning,
    // Read inside `preferResume`. Omitting it would capture the toggle's value from the
    // render this callback was created in, so turning auto-approve on mid-strategy would
    // not take effect until something else re-created the callback.
    autoApprove,
  ]);

  /**
   * Session signing: submit a staged write without the manual approve click.
   *
   * Client Privy silent-sign of MCP XDR — every hop, including multi-leg borrow after
   * deposit. risk "needs_confirmation" is normal staged policy copy, NOT a click gate.
   * Only risk "block" skips auto-submit.
   *
   * Scheduling via setTimeout(0) + cleanup: React Strict Mode double-mount used to
   * set autoSubmittedRef on the first invoke and skip the second, so hop 2 never
   * signed while the UI said "needs your click".
   */
  const nextStepFiredRef = useRef<string | null>(null);

  const sessionAutoSignKey = useMemo(() => {
    if (!response) return null;
    if (
      response.kind !== "needs_wallet_sign" &&
      !(response.kind === "needs_auto_sign" && isSignableXdr(response.unsigned_xdr))
    ) {
      return null;
    }
    const action = response.preview?.action;
    return hopAutoSubmitKey({
      requestId: response.request_id,
      op: action?.op,
      amount: action?.amount,
      asset: action?.asset,
      summary: response.preview?.human_summary,
    });
  }, [response]);

  // Blocked only when THIS hop's key failed — not a sticky boolean across legs.
  const autoSubmitBlocked =
    !!sessionAutoSignKey && autoSubmitBlockedKey === sessionAutoSignKey;

  useEffect(() => {
    if (!response || !sessionAutoSignKey) return;
    if (signing) return;
    if (
      !shouldSessionAutoSubmit({
        kind: response.kind,
        sessionSigning,
        riskDecision: response.preview?.risk?.decision,
        autoSubmitBlocked,
        hasSignableXdr: isSignableXdr(response.unsigned_xdr),
        allowSessionSign: response.preview?.allow_session_sign,
      })
    ) {
      return;
    }
    if (autoSubmittedRef.current === sessionAutoSignKey) return;

    const key = sessionAutoSignKey;
    let cancelled = false;
    // setTimeout(0)+cancel: Strict Mode runs effect→cleanup→effect; clearing the
    // timer on cleanup means only the second mount's timer fires. Setting
    // autoSubmittedRef synchronously (old code) made the remount skip forever.
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (autoSubmittedRef.current === key) return;
      autoSubmittedRef.current = key;
      void signWithWallet();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    response,
    sessionAutoSignKey,
    sessionSigning,
    signing,
    signWithWallet,
    autoSubmitBlocked,
  ]);

  /**
   * Agent chain when step 1 already landed as `executed` (server auto-sign or
   * open_account). Previously next_step only ran after client wallet sign, so
   * deposit→borrow got stuck after "Deposit 20 BLUSDC done" with auto-approve on.
   */
  useEffect(() => {
    if (response?.kind !== "executed") return;
    if (loading || signing) return;
    if (cancelledRef.current) return;

    // Two field names carry the same thing. `remaining_legs` came from the older
    // next_step chain; the plan/MultiLegAgent path returns `resume_legs` with
    // `can_resume`, which is what powers the manual "Continue remaining" button. Only
    // the first was checked here, so an approved plan executed one leg, offered a button,
    // and waited — even with auto-approve on, which is exactly what it is meant to avoid.
    const legsFrom = (key: string) =>
      Array.isArray((response.data as any)?.[key])
        ? ((response.data as any)[key] as Array<{
            op: string;
            asset?: string | null;
            amount?: number | null;
            leverage?: number | null;
            label?: string;
          }>)
        : null;
    // Same authority rule as the wallet-sign path: the server stops reporting
    // later legs once it is only handed one, so the client's queue takes over.
    // Card unsettled rows are only a fallback while the strategy is incomplete —
    // never after 4/4 terminal (orphans from a prior STAGED plan must not rebuild).
    //
    // Do NOT trust hop `execution.status === "completed"` or hop `strategy_complete`.
    // A resume hop hands the server one leg; when that leg settles the server reports
    // allOk/completed for THAT hop only. Using that flag here cleared the client tail
    // after deposit and locked strategyCompleteRef while borrow/supply stayed PENDING
    // (same trap as patched.every on the wallet-sign path).
    const serverRemaining = legsFrom("remaining_legs") ?? legsFrom("resume_legs");
    const prunedNow = pruneDuplicateFarmAdds(strategyStepsRef.current);
    if (prunedNow.length !== strategyStepsRef.current.length) {
      strategyStepsRef.current = prunedNow;
      setStrategySteps(prunedNow);
    }
    const cardComplete =
      strategyCompleteRef.current ||
      strategyIsComplete(strategyStepsRef.current);
    const remaining = pickRemainingLegs(
      serverRemaining,
      strategyTailRef.current,
      cardComplete ? [] : legsFromUnsettledSteps(strategyStepsRef.current),
    ).filter((r) => !farmWriteAlreadySettled(r.op, strategyStepsRef.current));
    const targetFloor =
      strategyMetaRef.current.min_hf != null &&
      Number.isFinite(Number(strategyMetaRef.current.min_hf))
        ? Number(strategyMetaRef.current.min_hf)
        : null;
    const liveNow = readLiveHfFromStore() ?? liveHf;
    const hfFloorPause =
      hfPaused ||
      shouldPauseForHealthFloor({
        floor: targetFloor,
        hf: liveNow,
        remainingOps: remaining.map((r) => r.op),
        settledOps: strategyStepsRef.current.map((s) => s.op),
      });
    if (hfFloorPause && remaining.length > 0 && !cardComplete) {
      strategyTailRef.current = remaining;
      strategyCompleteRef.current = false;
      if (!hfPaused) {
        setHfPaused(true);
        if (originalIntentRef.current) setIntentText(originalIntentRef.current);
        setResponse((prev) => {
          if (!prev) return prev;
          const d = (prev.data ?? {}) as Record<string, unknown>;
          const hf = liveNow;
          const floor = targetFloor;
          return {
            ...prev,
            message:
              hf != null && floor != null
                ? `HF ≈ ${hf.toFixed(2)} is below your floor of ${floor.toFixed(2)}. Further collateral/debt steps are paused — continue or stop here.`
                : prev.message,
            answer: localExecutionAnswer({
              intent: originalIntentRef.current || submitted,
              legs: strategyStepsRef.current,
              hf: liveNow,
              floor: targetFloor,
              pausedHf: true,
            }),
            data: {
              ...d,
              hf_paused: true,
              prefer_resume_multi_leg: false,
              can_resume: true,
              remaining_legs: remaining,
              strategy_complete: false,
            },
          } as ChatResponse;
        });
      }
      return;
    }
    const pauseForLp =
      isUnsizedAddLiquidity(remaining[0]) &&
      !farmWriteAlreadySettled(remaining[0]?.op, strategyStepsRef.current);
    if (pauseForLp) {
      const alreadyPinned = strategyStepsRef.current.some(
        (s) =>
          isUnsizedAddLiquidity(s) &&
          String(s.status) !== "ok" &&
          String(s.status) !== "done",
      );
      if (!alreadyPinned) {
        absorbStrategySteps(remaining.filter(isUnsizedAddLiquidity).map(pendingLpStepFromResume));
      }
      strategyTailRef.current = remaining;
      strategyCompleteRef.current = false;
      return;
    }
    // Hard-stop only when the full card is terminal AND nothing is still queued.
    // Prefer-resume alone must not decide completion (false complete + empty
    // remaining was the old shortcut that killed the queue mid-run).
    const done = cardComplete && remaining.length === 0;
    /**
     * Auto-approve skips the SIGNING PROMPT, not the plan.
     *
     * `!!autoApprove` used to gate this, so with the switch off a run simply stopped
     * after the first leg settled: the queue never advanced, no signature was ever
     * requested, and the card sat on "waiting to advance" with legs 2..n PENDING
     * forever. Reported as the run being dropped after a step or two, and reproduced
     * live on 21 Sep with "deposit 100 XLM into margin account" - leg 1 on chain,
     * legs 2-5 stranded.
     *
     * Advancing is not signing. The hop returns `needs_wallet_sign` and the card shows
     * Approve & sign; `shouldSessionAutoSubmit` still requires `sessionSigning`, so
     * with auto-approve off nothing is ever signed without the user. The real pauses -
     * an unsized LP leg and a breached HF floor - keep their own gates below.
     *
     * `shouldAutoResume` was already auto-approve-agnostic; only this call site was not.
     */
    const preferResume =
      !cardComplete &&
      !pauseForLp &&
      !hfFloorPause &&
      (shouldAutoResume({
        complete: false,
        serverRemaining,
        clientTail: strategyTailRef.current,
        preferFlag: (response.data as any)?.prefer_resume_multi_leg === true,
        canResumeWithAutoApprove:
          (response.data as any)?.can_resume === true && autoApprove,
        hfPaused: hfFloorPause,
      }) ||
        remaining.length > 0);

    if (done) {
      strategyTailRef.current = [];
      strategyCompleteRef.current = true;
      // Strip resume fields so a re-render cannot rebuild the queue from a hop
      // that still carried remaining_legs / can_resume for a partial plan.
      setResponse((prev) => {
        if (!prev || prev.kind !== "executed") return prev;
        const d = (prev.data ?? {}) as Record<string, unknown>;
        if (
          !prev.next_step &&
          !d.remaining_legs &&
          !d.resume_legs &&
          d.prefer_resume_multi_leg !== true &&
          d.can_resume !== true &&
          d.strategy_complete === true &&
          prev.execution?.status === "completed"
        ) {
          return prev;
        }
        return {
          ...prev,
          next_step: null,
          data: {
            ...d,
            remaining_legs: null,
            resume_legs: null,
            prefer_resume_multi_leg: false,
            can_resume: false,
            strategy_complete: true,
          },
          execution: {
            ...(prev.execution ?? {}),
            status: "completed",
            tx_hash: prev.execution?.tx_hash ?? null,
          },
        } as ChatResponse;
      });
    }

    if (preferResume && remaining.length > 0) {
      const key = `${response.request_id ?? "exec"}:resume:${remaining.map((l) => l.op).join(",")}`;
      if (nextStepFiredRef.current === key) return;
      nextStepFiredRef.current = key;
      const parentPrompt =
        originalIntentRef.current ||
        strategyParentRef.current?.prompt ||
        submitted ||
        "Continue strategy";
      if (!strategyParentRef.current) {
        strategyParentRef.current = {
          id: response.request_id || `strat-${Date.now()}`,
          prompt: parentPrompt,
        };
      }
      // ONE leg per hop — see splitResumeBatch. Hold the full remaining list until
      // the hop returns so an aborted fetch cannot drop the head leg.
      const { head, tail } = splitResumeBatch(remaining);
      if (!head.length) return;
      strategyTailRef.current = remaining;
      toast.success(
        `Running ${head[0]?.label || head[0]?.op || "next step"}` +
          (tail.length ? ` (${tail.length} more after this)…` : "…"),
        { duration: 3000 },
      );
      void (async () => {
        setLoading(true);
        await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
        if (cancelledRef.current) return;
        await refreshRailStats({ force: true, after: response.execution?.tx_hash ?? null });
        if (cancelledRef.current) return;
        const hop = await postCopilot(
          {
            message: parentPrompt,
            resume_multi_leg: { summary: parentPrompt, legs: head },
          },
          parentPrompt,
          { chainHop: true },
        );
        // Wait for the hop response before advancing the queue — never drop
        // borrow/supply because a POST failed or returned blocked mid-chain.
        if (!hop || !isChainableHopResponse(hop)) {
          strategyTailRef.current = remaining;
          nextStepFiredRef.current = null;
          return;
        }
        strategyTailRef.current = tail;
      })();
      return;
    }

    const next = response.next_step;
    // Legacy next_step chain only when the full strategy is not already terminal.
    // Hop `execution.status === "completed"` must not block next_step while the
    // accumulated card still has pending legs (or a client tail).
    if (done || !next?.op || next.amount == null || !(next.amount > 0)) {
      // Last resume hop often returns executed with only that hop's legs. Summarize
      // here with the FULL strategy card so facts say "4 of 4", not "1 of 1", and the
      // model does not invent that earlier legs "did not run".
      const card = strategyStepsRef.current;
      const allSettled = strategyIsComplete(card);
      const stillQueued =
        !allSettled &&
        hasMoreLegs(null, strategyTailRef.current, legsFromUnsettledSteps(card));
      const needsClientSummary =
        (response.data as any)?.needs_client_summary === true || allSettled;
      // Never summarize on hop-only "allOk" while later legs remain.
      if (needsClientSummary && allSettled && !stillQueued) {
        strategyCompleteRef.current = true;
        strategyTailRef.current = [];
        const stratId = strategyParentRef.current?.id || response.request_id || "exec";
        const sumKey = `${stratId}:summarize:${card.length}`;
        if (nextStepFiredRef.current === sumKey) return;
        nextStepFiredRef.current = sumKey;
        const intent =
          originalIntentRef.current ||
          strategyParentRef.current?.prompt ||
          submitted ||
          "strategy";
        const ranLegs = card.map((s) => ({
          action: String(s.label || `Step ${s.index ?? ""}`),
          status: String(s.status || "unknown"),
          tx_hash: s.tx_hash != null ? String(s.tx_hash) : null,
        }));
        const hfRaw = (response.data as any)?.final_hf ?? strategyMetaRef.current.final_hf;
        const floorRaw =
          (response.data as any)?.min_hf ?? strategyMetaRef.current.min_hf;
        const finalHf =
          hfRaw != null && Number.isFinite(Number(hfRaw))
            ? Number(hfRaw)
            : readLiveHfFromStore() ?? liveHf;
        const floorHf =
          floorRaw != null && Number.isFinite(Number(floorRaw)) ? Number(floorRaw) : null;
        if (originalIntentRef.current) setIntentText(originalIntentRef.current);
        setResponse((prev) => {
          if (!prev) return prev;
          if (prev.answer) return prev;
          return {
            ...prev,
            answer: localExecutionAnswer({
              intent,
              legs: card,
              hf: finalHf,
              floor: floorHf,
            }),
          } as ChatResponse;
        });
        void (async () => {
          if (cancelledRef.current) return;
          await postCopilot(
            {
              message: intent,
              summarize_execution: {
                intent: originalIntentRef.current || response.preview?.human_summary || intent,
                legs: ranLegs,
                final_health_factor: finalHf,
                health_factor_floor: floorHf,
              },
            },
            intent,
            { chainHop: true, background: true },
          );
        })();
      }
      return;
    }
    const key = `${response.request_id ?? "exec"}:${next.op}:${next.amount}:${next.asset ?? ""}`;
    if (nextStepFiredRef.current === key) return;
    nextStepFiredRef.current = key;

    const label =
      next.label ||
      `Auto step ${next.step ?? 2}: ${next.op} ${next.amount} ${next.asset || ""}`.trim();
    toast.success("Step confirmed — next leg in ~2s…", { duration: 3000 });
    void (async () => {
      setLoading(true);
      await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
      if (cancelledRef.current) return;
      await refreshRailStats({ force: true });
      if (cancelledRef.current) return;
      if (!strategyParentRef.current && submitted) {
        strategyParentRef.current = {
          id: response.request_id || `strat-${Date.now()}`,
          prompt: submitted,
        };
      }
      const hop = await postCopilot(
        {
          message: `${next.op.replace(/_/g, " ")} ${next.amount} ${next.asset || ""}`.trim(),
          pending_write: {
            op: next.op,
            asset: next.asset ?? null,
            amount: next.amount ?? null,
            leverage: next.leverage ?? null,
            follow_up: next.follow_up ?? null,
          },
        },
        label,
        { chainHop: true },
      );
      if (hop?.message) {
        void investigation.updateLastAssistantText(hop.message);
      }
    })();
  }, [response, loading, signing, postCopilot, refreshRailStats, submitted, autoApprove, absorbStrategySteps, hfPaused, liveHf, investigation]);

  /**
   * Liquidation guardian (auto-approve / session signing only).
   * When the user has set a HF floor (e.g. “keep HF above 1.4”) and auto-approve
   * is on, poll account health and auto-repay a slice of the largest debt if HF
   * drops under the floor. Does nothing when auto-approve is off (no silent moves).
   */
  const guardianFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionSigning || !address || !effHasAccount) return;
    if (loading || signing) return;

    const readFloor = readGuardianFloor;

    const tick = async () => {
      await refreshRailStats({ force: true });
      const store = useMarginAccountInfoStore.getState();
      const gross = store.grossCollateralValue ?? 0;
      const debt = store.totalBorrowedValue ?? 0;
      if (debt < 0.5) return; // no meaningful debt
      const derived = deriveMarginHealth({
        grossCollateralValue: gross,
        effectiveDebtValue: debt > 0.01 ? debt : 0,
        totalBorrowedValue: debt,
      });
      const hf = derived.avgHealthFactor;
      const floor = readFloor();
      if (!(hf > 0) || hf >= floor) return;

      // Cooldown: one auto-repay per floor breach window (5 min).
      const key = `${Math.floor(Date.now() / 300_000)}:${floor.toFixed(2)}`;
      if (guardianFiredRef.current === key) return;
      guardianFiredRef.current = key;

      const debts = store.borrowedBalances || {};
      let bestAsset = "USDC";
      let bestAmt = 0;
      for (const [sym, row] of Object.entries(debts)) {
        // BorrowedBalance.amount is a decimal string from the store — always Number().
        const amt = Number(row?.amount ?? 0);
        if (Number.isFinite(amt) && amt > bestAmt) {
          bestAmt = amt;
          bestAsset = sym;
        }
      }
      if (bestAmt <= 0) {
        // Fall back to value-based repay of ~15% of debt in USDC family.
        bestAmt = Math.max(1, debt * 0.15);
        bestAsset = "AQUSDC";
      }
      // Repay ~20% of that debt line (min 1) to lift HF without wiping the book.
      const repayAmt = Math.max(1, Math.min(bestAmt, bestAmt * 0.2));
      const label = `Guardian: repay ${repayAmt.toFixed(4)} ${bestAsset} (HF ${hf.toFixed(2)} < ${floor})`;
      toast.error(`Health factor ${hf.toFixed(2)} below floor ${floor} — auto-repaying…`, {
        duration: 6000,
      });
      setSubmitted(label);
      await postCopilot(
        {
          message: `repay ${repayAmt} ${bestAsset} to protect health factor above ${floor}`,
          pending_write: {
            op: "repay",
            asset: bestAsset,
            amount: repayAmt,
            leverage: null,
          },
        },
        label,
      );
    };

    const id = window.setInterval(() => {
      void tick();
    }, 45_000);
    // First check shortly after enable.
    const t0 = window.setTimeout(() => void tick(), 8_000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(t0);
    };
  }, [
    sessionSigning,
    address,
    effHasAccount,
    loading,
    signing,
    refreshRailStats,
    postCopilot,
  ]);

  // Persist HF floor whenever the user states one in a prompt.
  useEffect(() => {
    if (!submitted) return;
    const m =
      submitted.match(
        /(?:above|over|at least|>=?)\s*(\d+(?:\.\d+)?)/i,
      ) ||
      submitted.match(/health factor[^\d]*(\d+(?:\.\d+)?)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 1 && n < 20) {
        try {
          localStorage.setItem("vanna_copilot_guardian_min_hf", String(n));
        } catch {
          /* ignore */
        }
      }
    }
  }, [submitted]);

  /** Clear current answer / staged action but keep session log. */
  const reset = () => {
    cancelledRef.current = true;
    abortRef.current?.abort("composer reset");
    abortRef.current = null;
    setLoading(false);
    setSigning(false);
    setAutoSubmitBlockedKey(null);
    badSeqRebuildRef.current = false;
    setSubmitted(null);
    setResponse(null);
    originalIntentRef.current = "";
    setIntentText("");
    setHfPaused(false);
    setShowCustom(false);
    autoSubmittedRef.current = null;
    nextStepFiredRef.current = null;
    strategyParentRef.current = null;
    resetStrategyAccumulator();
    inputRef.current?.focus();
  };

  const stopRemainingLegs = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort("remaining legs stopped");
    abortRef.current = null;
    setLoading(false);
    setSigning(false);
    setHfPaused(false);
    strategyTailRef.current = [];
    strategyCompleteRef.current = true;
    const stopped = strategyStepsRef.current.map((s) => {
      const st = String(s.status ?? "").toLowerCase();
      if (["ok", "done", "signed_and_submitted", "error", "blocked", "failed"].includes(st)) {
        return s;
      }
      return { ...s, status: "skipped", message: "Stopped here" };
    });
    strategyStepsRef.current = stopped;
    setStrategySteps(stopped);
    const floor =
      strategyMetaRef.current.min_hf != null ? Number(strategyMetaRef.current.min_hf) : null;
    const hf = readLiveHfFromStore() ?? liveHf;
    const intent = originalIntentRef.current || submitted;
    if (originalIntentRef.current) setIntentText(originalIntentRef.current);
    setResponse({
      kind: "executed",
      message: "Stopped here. Settled legs stay on-chain; nothing further will be submitted.",
      answer: localExecutionAnswer({ intent, legs: stopped, hf, floor }),
      execution: { status: "stopped", tx_hash: null },
      data: {
        ...strategyMetaRef.current,
        multi_leg: true,
        multi_leg_steps: stopped,
        strategy_complete: true,
        can_resume: false,
        remaining_legs: null,
        prefer_resume_multi_leg: false,
        hf_paused: false,
      },
    });
  }, [liveHf, submitted]);

  const multiLeg =
    isRealStrategyRun(strategySteps, response?.data ?? null);
  const strategyOpen = (() => {
    const src = strategySteps.length
      ? strategySteps
      : Array.isArray((response?.data as { multi_leg_steps?: unknown })?.multi_leg_steps)
        ? ((response!.data as { multi_leg_steps: Array<{ status?: unknown; op?: string }> }).multi_leg_steps)
        : [];
    const cardOpen = src.some((s) => {
      const st = String(s?.status ?? "").toLowerCase();
      return !["ok", "done", "skipped", "error", "blocked", "failed", "stopped", "stopped_hf", "signed_and_submitted"].includes(st);
    });
    const remaining = (response?.data as { remaining_legs?: unknown })?.remaining_legs;
    const queuedLp =
      Array.isArray(remaining) &&
      remaining.some((l) => isUnsizedAddLiquidity(l as { op?: string; amount?: number | null }));
    return cardOpen || queuedLp;
  })();
  const strategyCardData: Record<string, unknown> = {
    ...strategyMetaRef.current,
    ...(response?.data && typeof response.data === "object" ? response.data : {}),
    multi_leg: true,
    multi_leg_steps: strategySteps.length
      ? strategySteps
      : (response?.data as any)?.multi_leg_steps,
  };
  // Multi-leg uses a structured card — don't paint the whole turn imperial red.
  const isError =
    !multiLeg && (response?.kind === "error" || response?.kind === "blocked");
  /**
   * The open signing-authority consent, if one is in progress.
   *
   * Held separately from `phase` below because it must OUTRANK `loading`: the consent
   * poll runs as a chain hop every few seconds, and if a poll's loading state hid the
   * panel, the link the user is supposed to click would blink out from under them.
   */
  const bindGate =
    response?.kind === "needs_wallet_bind" ? (response.wallet_bind ?? null) : null;
  /**
   * A signature that has already been given is not a signature still being waited on.
   *
   * The staged panel — "Approve & sign", the impact projection, the Step-by-Step Approval
   * header — is derived from `response.kind`, and the kind stays `needs_wallet_sign` on
   * any path that stamps the hash without rewriting it. So a plain "Deposit 5 AQUSDC" left
   * its approval card on screen after the transaction had settled, asking for a signature
   * the chain already had, while the receipt sat in the turn above it.
   *
   * Derived from the one fact that settles it: a transaction hash exists for this
   * response. That holds for every path that can produce one — wallet signature, session
   * auto-sign, a resumed leg — rather than for the kinds we happened to think of.
   */
  const responseSubmitted = Boolean(
    response?.execution?.tx_hash ||
      (typeof (response?.data as { tx_hash?: unknown } | undefined)?.tx_hash === "string" &&
        (response?.data as { tx_hash: string }).tx_hash),
  );
  // needs_auto_sign + XDR is staged (session auto-sign), not the enable-caps gate.
  const stagedForSessionSign =
    !responseSubmitted &&
    (response?.kind === "needs_wallet_sign" ||
      (response?.kind === "needs_auto_sign" && isSignableXdr(response.unsigned_xdr)));
  const phase = bindGate
    ? "bind"
    : loading
      ? "running"
      : response?.kind === "plan_preview"
        ? "plan"
        : response?.kind === "needs_auto_sign" && !stagedForSessionSign
          ? "autosign"
          : stagedForSessionSign
            ? "staged"
            : response?.kind === "executed" || responseSubmitted
              ? "done"
              : response
                ? "answer"
                : "idle";

  /**
   * Elapsed seconds for the in-flight turn.
   *
   * `/api/copilot` streams no progress, so the only truthful things to show while it runs
   * are that it is running and for how long. The three-row pipeline that used to render
   * here — "Parsing intent" active, "MCP tool call" pending, "Composing response" pending
   * — was hardcoded and never advanced, so it still read "MCP tool call pending" long
   * after the server had finished that stage and moved on to composing. A stage marker
   * that cannot move is worse than a clock: it looks stalled precisely when work is
   * happening. Showing a fabricated sequence instead would break the surface's own rule
   * that progress must reflect events that actually occurred.
   */
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);

  /** Agent-run trace, built from the turn that actually happened. */
  const steps = useMemo<Step[]>(() => {
    if (loading) {
      const clock = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${String(elapsedSec % 60).padStart(2, "0")}s`
        : `${elapsedSec}s`;
      return [
        {
          label: multiLeg ? "Running multi-leg plan" : "Reading your position and the markets",
          detail: clock,
          state: "active",
        },
      ];
    }
    if (!response) return [];
    const template = response.intent?.template_id || response.preview?.template_id || "—";
    const tool = response.mcp?.tool || "—";
    // Multi-leg strategy: show accumulated legs (not just the current hop).
    const mlSteps =
      strategySteps.length > 0
        ? strategySteps
        : Array.isArray((response.data as any)?.multi_leg_steps)
          ? ((response.data as any).multi_leg_steps as Array<{
              label?: string;
              status?: string;
              op?: string;
            }>)
          : null;
    if (mlSteps?.length) {
      return mlSteps.map((s) => {
        const st = String(s.status || "");
        const state: Step["state"] =
          st === "ok" || st === "done"
            ? "done"
            : st === "pending" || st === "needs_sign"
              ? "active"
              : st === "skipped"
                ? "pending"
                : "done";
        return {
          label: s.label || (s as { op?: string }).op || "step",
          detail: st === "ok" || st === "done" ? "done" : st || "—",
          state,
        };
      });
    }
    const write =
      response.kind === "executed" ||
      response.kind === "needs_wallet_sign" ||
      response.kind === "needs_auto_sign" ||
      response.kind === "blocked";
    if (!write) {
      return [
        { label: "Intent parsed", detail: template, state: "done" },
        { label: "MCP tool call", detail: tool, state: response.mcp?.tool ? "done" : "pending" },
        { label: "Response composed", detail: "plain english + facts", state: "done" },
      ];
    }
    const decision = response.preview?.risk?.decision ?? "needs_confirmation";
    const out: Step[] = [
      { label: "Intent parsed", detail: template, state: "done" },
      { label: "Transaction built", detail: tool, state: response.mcp?.has_unsigned_xdr || response.execution ? "done" : "pending" },
    ];
    if (response.preview?.simulation) {
      out.splice(1, 0, { label: "Account state read", detail: "mcp · vanna_get_account_health", state: "done" });
    }
    out.push({ label: "Risk gate", detail: decision, state: "done" });
    out.push({
      label: response.kind === "executed" ? "Signed & submitted" : response.kind === "blocked" ? "Rejected" : "Staged for signature",
      detail: response.execution?.status || response.mcp?.auto_sign || "awaiting approval",
      state: response.kind === "executed" ? "done" : response.kind === "blocked" ? "done" : "active",
    });
    return out;
  // elapsedSec drives the in-flight clock; without it the memo freezes at 0s.
  }, [loading, response, strategySteps, multiLeg, elapsedSec]);

  /**
   * The same legs the agent-run list shows, in the shape the run card renders.
   *
   * Two things are derived here rather than sent by the server:
   *   - `running`. The server has no such status — a leg is either not started or it has
   *     a result. But while a request is on the wire, exactly one leg is in flight: the
   *     first one without a terminal result. Marking it lets the card show a spinner and
   *     an elapsed time instead of calling a live leg "pending".
   *   - the venue, from VENUE_BY_OP — the same table the plan card badges with.
   */
  const TERMINAL_LEG = useMemo(
    () =>
      new Set([
        "ok",
        "done",
        "signed_and_submitted",
        "error",
        "blocked",
        "preflight_blocked",
        "stopped",
        "stopped_hf",
        "skipped",
      ]),
    [],
  );
  const execLegs = useMemo<RunLeg[]>(() => {
    const raw: MultiLegStepUi[] = strategySteps.length
      ? strategySteps
      : Array.isArray((response?.data as { multi_leg_steps?: unknown })?.multi_leg_steps)
        ? ((response!.data as { multi_leg_steps: MultiLegStepUi[] }).multi_leg_steps)
        : [];
    /**
     * Drop the pseudo-leg.
     *
     * When the router cannot resolve part of a strategy it appends a clarification row
     * whose label is the ENTIRE original prompt. That is the turn's clarification, not a
     * leg: it has no op and no amount, so it took focus in the card, reported "paused on
     * leg 1 of 3", and opened a number field for a question that was really "I could not
     * decompose this". Anything whose label is the prompt back at us is not a step.
     */
    const promptEcho = (submitted || "").trim().toLowerCase();
    const src = raw.filter((s) => {
      const label = String(s.label ?? "").trim().toLowerCase();
      if (!label) return true;
      const echo = promptEcho.length > 24 && (label === promptEcho || label.startsWith(promptEcho));
      const noOp = !s.op || s.op === "step";
      return !(echo && noOp);
    });
    if (!src.length) return [];
    const inFlightIdx = loading
      ? src.findIndex((s) => !TERMINAL_LEG.has(String(s.status ?? "")))
      : -1;
    const firstOpen = src.findIndex((s) => !TERMINAL_LEG.has(String(s.status ?? "")));
    return src.map((s, i) => {
      const op = String(s.op ?? "step");
      const amt = s.amount;
      const hasAmt = amt != null && Number.isFinite(Number(amt)) && Number(amt) > 0;
      const pauseLp =
        (op === "add_liquidity" ||
          op === "deploy_to_blend" ||
          op === "supply_to_blend" ||
          op === "remove_liquidity" ||
          op === "withdraw_from_blend") &&
        !hasAmt &&
        i === firstOpen &&
        !loading;
      const fromInput = Array.isArray(
        (response?.data as { lp_input?: { sides?: string[] } })?.lp_input?.sides,
      )
        ? ((response!.data as { lp_input: { sides: [string, string] } }).lp_input.sides)
        : null;
      const sides =
        op === "add_liquidity"
          ? fromInput ??
            (s.token_a && s.token_b
              ? ([String(s.token_a), String(s.token_b)] as [string, string])
              : lpSides(s.asset, s.token_b || s.token_out, null))
          : op === "deploy_to_blend" || op === "supply_to_blend" || op === "withdraw_from_blend"
            ? fromInput ?? (["XLM", "BLUSDC"] as [string, string])
            : null;
      return {
        // Position, not the server's index. A resumed run restarts its step counter, so a
        // returned index can collide with one already on screen — which showed two
        // different legs both numbered "1". Order is what the accumulator maintains; the
        // number the user reads is that order.
        n: i + 1,
        venue: VENUE_BY_OP[op] ?? "other",
        op,
        label: s.label || op.replace(/_/g, " "),
        amount: hasAmt
          ? Number(amt).toLocaleString(undefined, { maximumFractionDigits: 7 })
          : null,
        asset: s.asset ?? null,
        leverage: s.leverage ?? null,
        status: pauseLp ? "needs_input" : toRunLegStatus(s.status, i === inFlightIdx),
        txHash: s.tx_hash ? truncHash(String(s.tx_hash)) : null,
        // The server's `message` is a humanized reason. Only surface it where it is one:
        // on a leg that failed or is asking for something, never on a settled leg.
        error:
          s.message && toRunLegStatus(s.status) === "failed" ? String(s.message) : null,
        question:
          pauseLp
            ? s.message
              ? String(s.message)
              : `How much ${sides ? sides.join(" or ") : "XLM or AQUSDC"} should I ${
                  op === "add_liquidity" ? "add" : "supply"
                }?`
            : s.message && toRunLegStatus(s.status) === "needs_input"
              ? String(s.message)
              : null,
        tokenIn: s.token_in ?? null,
        tokenOut: s.token_out ?? null,
        lpSides: sides,
        lpOtherPerXlm:
          op === "add_liquidity"
            ? ((response?.data as { lp_input?: { other_per_xlm?: number | null } })?.lp_input?.other_per_xlm ?? null)
            : null,
        lpPrefillXlm:
          op === "add_liquidity"
            ? ((response?.data as { lp_input?: { amount_xlm?: number | null } })?.lp_input?.amount_xlm ?? null)
            : op === "remove_liquidity"
              ? ((response?.data as { lp_input?: { amount?: number | null } })?.lp_input?.amount ?? null)
              : null,
        lpPrefillOther:
          op === "add_liquidity"
            ? ((response?.data as { lp_input?: { amount_other?: number | null } })?.lp_input?.amount_other ?? null)
            : null,
        lpHeld:
          op === "remove_liquidity" || op === "withdraw_from_blend"
            ? ((response?.data as { lp_input?: { held?: number | null } })?.lp_input?.held ?? null)
            : null,
        lpHeldLabel:
          op === "remove_liquidity" || op === "withdraw_from_blend"
            ? ((response?.data as { lp_input?: { label?: string | null } })?.lp_input?.label ?? null)
            : null,
      };
    });
  }, [strategySteps, response, loading, TERMINAL_LEG, submitted]);

  /**
   * Resume from a paused leg once the user supplies the amount the plan never carried.
   * The leg goes first with its new amount, then every leg still unstarted after it —
   * the server runs them in order, so the rest of the strategy continues untouched.
   */
  const submitLegAmount = useCallback(
    (leg: RunLeg, amount: number, selectedAsset?: string, pair?: { amount_a: number; amount_b: number }) => {
      /**
       * Everything still outstanding, not just the leg being answered.
       *
       * A leg the run never reached is marked `skipped` — "skipped because an earlier leg
       * needs an amount" — so `skipped` means *not yet attempted*, not *abandoned*, and it
       * has to travel with the resume or it never runs. Only settled legs are excluded;
       * replaying one of those would deposit or borrow a second time.
       *
       * `leverage` rides along on every leg. Without it a levered farm resumed as a plain
       * supply — the same class of failure as an approved 2× plan replaying unlevered, and
       * just as invisible, because the amount looks right.
       */
      const carry = (l: RunLeg, overrideAmount?: number, overrideAsset?: string) => {
        const asset = overrideAsset || l.asset;
        const sides = l.lpSides;
        const selected = (overrideAsset || asset || "").toUpperCase();
        const isLp = l.op === "add_liquidity" && sides && sides.length === 2;
        return {
          op: l.op,
          asset,
          amount:
            overrideAmount ??
            (l.amount != null ? Number(String(l.amount).replace(/,/g, "")) : null),
          leverage: l.leverage ?? null,
          label: l.label,
          token_in: l.tokenIn ?? null,
          token_out: l.tokenOut ?? null,
          token_a: isLp ? sides[0] : null,
          token_b: isLp ? sides[1] : null,
          amount_a:
            pair && l.n === leg.n
              ? pair.amount_a
              : isLp && overrideAmount != null && selected === "XLM"
                ? overrideAmount
                : null,
          amount_b:
            pair && l.n === leg.n
              ? pair.amount_b
              : isLp && overrideAmount != null && selected !== "XLM"
                ? overrideAmount
                : null,
        };
      };

      const rest = execLegs.filter((l) => l.n > leg.n && l.status !== "ok").map((l) => carry(l));
      const summary = String(
        strategyMetaRef.current.strategy_summary || submitted || "Continue strategy",
      );
      void resumeMultiLeg([carry(leg, amount, selectedAsset), ...rest], summary);
    },
    [execLegs, resumeMultiLeg, submitted],
  );

  /**
   * Resume from a paused SWAP leg once the user names a corrected destination token —
   * e.g. answering "BLUSDC is Blend USDC — swap to AQUSDC or SOUSDC instead" with just
   * "SOUSDC". Same pattern as submitLegAmount: the leg goes first with its corrected
   * `token_out`, then every leg still unstarted after it.
   *
   * Reported live: typing the answer into the main composer fired a brand-new, context-
   * free message ("SOUSDC" alone), which the router could not understand on its own — the
   * paused strategy was silently abandoned rather than resumed with the correction. The
   * label is rebuilt too ("Swap 10 XLM → SOUSDC"), not just the underlying token_out — a
   * stale label showing the OLD (refused) destination while the corrected one executes
   * would be its own, quieter version of the same lie.
   */
  const submitLegTokenAnswer = useCallback(
    (leg: RunLeg, tokenOut: string) => {
      const carry = (l: RunLeg, overrideTokenOut?: string) => {
        const tokenIn = l.tokenIn ?? l.asset ?? "XLM";
        const finalTokenOut = overrideTokenOut ?? l.tokenOut ?? null;
        const label =
          overrideTokenOut && l.op === "swap"
            ? `Swap ${l.amount ?? ""} ${tokenIn} → ${overrideTokenOut}`.replace(/\s+/g, " ").trim()
            : l.label;
        return {
          op: l.op,
          asset: l.asset,
          amount: l.amount != null ? Number(String(l.amount).replace(/,/g, "")) : null,
          leverage: l.leverage ?? null,
          label,
          token_in: tokenIn,
          token_out: finalTokenOut,
        };
      };

      const rest = execLegs.filter((l) => l.n > leg.n && l.status !== "ok").map((l) => carry(l));
      const summary = String(
        strategyMetaRef.current.strategy_summary || submitted || "Continue strategy",
      );
      void resumeMultiLeg([carry(leg, tokenOut), ...rest], summary);
    },
    [execLegs, resumeMultiLeg, submitted],
  );

  const continueRemainingLegs = useCallback(() => {
    const remaining = execLegs.filter((l) => l.status !== "ok");
    if (!remaining.length) return;
    const carry = (l: RunLeg) => {
      const sides = l.lpSides;
      const isLp = l.op === "add_liquidity" && sides && sides.length === 2;
      return {
        op: l.op,
        asset: l.asset,
        amount: l.amount != null ? Number(String(l.amount).replace(/,/g, "")) : null,
        leverage: l.leverage ?? null,
        label: l.label,
        token_in: l.tokenIn ?? null,
        token_out: l.tokenOut ?? null,
        token_a: isLp ? sides[0] : null,
        token_b: isLp ? sides[1] : null,
      };
    };
    const summary = String(
      strategyMetaRef.current.strategy_summary || submitted || "Continue strategy",
    );
    void resumeMultiLeg(remaining.map(carry), summary);
  }, [execLegs, resumeMultiLeg, submitted]);

  /**
   * Best-effort match of a free-text answer against a known asset symbol — "SOUSDC",
   * "swap to SOUSDC", "use soroswap (SOUSDC)" all resolve the same way. Longest-first so
   * "BLUSDC" cannot match as a substring of a longer, hypothetical symbol.
   */
  const resolveAssetSymbolFromText = useCallback((text: string): string | null => {
    const t = text.toUpperCase();
    for (const sym of ["SOUSDC", "AQUSDC", "BLUSDC", "USDC", "XLM", "AQUA"]) {
      if (new RegExp(`\\b${sym}\\b`).test(t)) return sym;
    }
    return null;
  }, []);

  /**
   * Read after mount, not during render: localStorage does not exist during SSR, and
   * defaulting to 1.3 on the server while the stored floor is 1.4 is a hydration mismatch.
   */
  const [guardianFloor, setGuardianFloor] = useState(1.3);
  useEffect(() => setGuardianFloor(readGuardianFloor()), []);
  // Same reason: the caps chip reads storage after mount, never during render.
  useEffect(() => setSavedCaps(readAutoCaps()), []);

  const sim = response?.preview?.simulation ?? null;
  /**
   * Does this write move margin health?
   *
   * `OP_FLOW` (lib/copilot/workflow/types.ts) declares it per op and `evaluateWriteRisk`
   * passes the answer through as `margin_applicable`, so the card no longer names ops.
   * The list it replaces — swap, add_liquidity, remove_liquidity — had to be extended by
   * hand for every health-neutral op added, and Blend supply and Blend withdraw were
   * never added: both drew a full "projected impact" card reading 59.40 → 59.40 over a
   * write that cannot change a health factor, and did it while covering the thread.
   */
  const marginProjected = sim?.margin_applicable !== false;
  const reasons = response?.preview?.risk?.reasons ?? [];
  const decision = response?.preview?.risk?.decision;
  const action = response?.preview?.action;
  const followUp = followUpFor(response?.answer, response?.intent);
  /** Same conditions the auto-submit effect uses, so the notice can't disagree with it. */
  // Multi-leg: every hop with XDR auto-submits when session signing is on — including
  // responses that older servers labeled needs_auto_sign.
  /**
   * The SAME question the auto-submit effect asks, with the same inputs.
   *
   * `allow_session_sign` was missing here and passed there, so the two disagreed
   * exactly when the server withheld session-signing (`forbid_session_sign`, or a
   * high-impact swap): the effect declined to sign, while this said it would and
   * rendered the "no click needed" spinner INSTEAD of the Approve button. Nothing
   * signed and nothing could be clicked — the run just span. Live, 21 Sep, on a
   * staged deposit showing "risk gate · confirm".
   */
  const willAutoSubmit = shouldSessionAutoSubmit({
    kind: response?.kind,
    sessionSigning,
    riskDecision: decision,
    autoSubmitBlocked,
    hasSignableXdr: isSignableXdr(response?.unsigned_xdr),
    allowSessionSign: response?.preview?.allow_session_sign,
  });
  const txHash =
    response?.execution?.tx_hash ??
    (typeof (response?.data as { tx_hash?: unknown } | undefined)?.tx_hash === "string"
      ? String((response?.data as { tx_hash: string }).tx_hash)
      : typeof (response?.data as { "tx hash"?: unknown } | undefined)?.["tx hash"] === "string"
        ? String((response?.data as { "tx hash": string })["tx hash"])
        : null);

  /** The rail collapses to a 60px icon column; the stage takes the width back. */
  const [railCollapsed, setRailCollapsed] = useState(false);
  /**
   * No turn on screen. Drives the stage grid: centred composer, hero and chips when
   * empty; docked composer once there is a thread.
   */
  const stageEmpty = investigation.turns.length === 0 && !response && phase === "idle" && !investigation.loading && !submitted;
  const lastUserTurn = [...investigation.turns].reverse().find((turn) => turn.role === "user")?.text ?? null;
  const pendingUser = submitted && submitted !== lastUserTurn ? submitted : null;
  const submittedRecorded = !!submitted && investigation.turns.some((turn) => turn.role === "user" && turn.text === submitted);
  const isStaleInvestigation = Boolean(
    investigation.result &&
    !investigation.loading &&
    !workflow.view &&
    !workflow.loading &&
    !signingJournal &&
    lastUserTurn &&
    investigation.prompt &&
    lastUserTurn !== investigation.prompt
  );
  /**
   * Owner layout (23 Sep): the plan card becomes the execution card in the same place. While
   * the investigation card draws this run, the thread leaves the run's receipt out, so one
   * run is one card. Once the user moves on, the card stops drawing it and the thread's
   * receipt keeps the run's final state on the past turn.
   */
  /**
   * The questionnaire docks where the chat box is (owner, 24 Sep; mockup boards 10–16), for
   * the reply that issued it and only while that reply is the latest, live one. Closing it
   * brings the chat box back for that reply; a new reply can issue a new one.
   */
  const [closedQuestionnaire, setClosedQuestionnaire] = useState<string | null>(null);
  const openQuestionnaire = !investigation.loading && investigation.resultOrigin === "live" &&
    investigation.turns[investigation.turns.length - 1]?.role === "assistant" &&
    investigation.result?.questionnaire && investigation.result.questionnaire.id !== closedQuestionnaire
    ? investigation.result.questionnaire : null;
  /** The run finished on an earlier reply: it is history, drawn by the thread on its own turn. */
  const runIsPast = runIsOnEarlierTurn(investigation.turns, workflow.view ? { id: workflow.view.id, finished: finishedWorkflow(workflow.view) } : null);
  const cardDrawsRun = !isStaleInvestigation && !!workflow.view && !runIsPast &&
    workflow.view.status !== "proposed" && workflow.view.status !== "validating" &&
    investigation.turns[investigation.turns.length - 1]?.role !== "user";
  /**
   * "Once tx is settled, the same response shows the completed response" (owner layout).
   * The reply written before approval ended in an instruction to approve; once the run has
   * finished, that turn's text is replaced with what happened, built from the legs
   * themselves (localExecutionAnswer), not from any wording in the old reply.
   */
  const completedTextRef = useRef<string | null>(null);
  const updateLastAssistantText = investigation.updateLastAssistantText;
  useEffect(() => {
    const view = workflow.view;
    if (!view || !cardDrawsRun) return;
    const settledCount = view.steps.filter((step) => step.status === "settled").length;
    const finished = view.status === "completed" ||
      ((view.status === "blocked" || view.status === "cancelled") && settledCount > 0);
    if (!finished) return;
    const key = `${view.id}:${view.status}:${settledCount}`;
    if (completedTextRef.current === key) return;
    completedTextRef.current = key;
    const result = investigation.result;
    const candidate = result?.candidates?.feasible.find((entry) => entry.id === approvedCandidateRef.current);
    const reply = completionReply(view, {
      title: candidate?.label ?? null,
      comparisons: result?.rateComparisons ?? [],
      healthFactorAfter: candidate?.finalHealthFactor ?? null,
      repaysAllDebt: !!candidate?.repaysAllDebt,
    });
    if (reply) void updateLastAssistantText(reply);
  }, [workflow.view, cardDrawsRun, updateLastAssistantText, investigation.result]);
  const liveWriteUi =
    multiLeg ||
    phase === "plan" ||
    phase === "autosign" ||
    phase === "staged" ||
    phase === "bind" ||
    phase === "done";
  /**
   * Live `/api/copilot` reply, painted before (or if) it is mirrored into the session.
   *
   * `response.message` — never `answer.headline`. For a structured answer the message IS
   * the headline plus the figures, flattened by `answerToText`, and `ChatTurns` renders
   * that whole document (chat-message.tsx). Taking the headline alone dropped the
   * holdings the read had already fetched, and did it only for the live turn, so the
   * same answer gained rows the moment the session reloaded.
   */
  const liveReply = response
    ? (response.preview?.human_summary || "").trim() || response.message
    : null;
  const liveAssistant = liveReply && !submittedRecorded ? liveReply : null;
  /**
   * The rail's flat position list, from the same `positionRows` the page already built.
   * One state, two views — the rail must never compute its own figures.
   */
  const railPositions = useMemo(() => {
    const usd = (n: number) =>
      `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return [
      ...positionRows.collateral.map((r) => ({
        symbol: r.symbol, role: "Margin · Collateral", amount: r.amount, usd: usd(r.usd),
      })),
      ...positionRows.borrowed.map((r) => ({
        symbol: r.symbol, role: "Margin · Borrowed", amount: r.amount, usd: usd(r.usd),
      })),
    ];
  }, [positionRows]);


  return (
    <div className="cp-root">
      <CopilotShell
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((v) => !v)}
        empty={stageEmpty}
        conversationId={investigation.conversationId}
        justSubmitted={Boolean(pendingUser && loading)}
        scrollKey={`${investigation.turns.length}-${pendingUser}-${liveReply}-${loading}-${response?.request_id}`}
        railTop={
          <CopilotRailTop
            onNewChat={startNewChat}
            autoApprove={{
              on: autoApproveUiOn,
              busy: autoApprovePending || loading,
              capsMode: railCapsMode,
              customTx,
              customDay,
              defaultTx: mcpDefaultCap ?? 1000,
              defaultDay: mcpDefaultCap ?? 1000,
              onToggle: handleAutoApproveToggle,
              onCapsMode: setRailCapsMode,
              onCustomTx: setCustomTx,
              onCustomDay: setCustomDay,
            }}
          />
        }
        railBody={
          <CopilotRailBody
            hasWallet={Boolean(address)}
            healthFactor={liveHf}
            positions={railPositions}
            conversations={investigation.conversations}
            activeId={investigation.conversationId}
            onOpen={openConversation}
            onRename={(id, title) => { void investigation.rename(id, title); }}
            onDelete={(id) => { void investigation.remove(id); }}
          />
        }
        railMini={
          <CopilotRailMini
            onExpand={() => setRailCollapsed(false)}
            onNewChat={startNewChat}
            autoApprove={{
              on: autoApproveUiOn,
              busy: autoApprovePending || loading,
              capsMode: railCapsMode,
              customTx,
              customDay,
              defaultTx: mcpDefaultCap ?? 1000,
              defaultDay: mcpDefaultCap ?? 1000,
              onToggle: handleAutoApproveToggle,
              onCapsMode: setRailCapsMode,
              onCustomTx: setCustomTx,
              onCustomDay: setCustomDay,
            }}
            healthFactor={liveHf}
            conversations={investigation.conversations}
            activeId={investigation.conversationId}
            onOpen={openConversation}
            onRename={(id, title) => { void investigation.rename(id, title); }}
            onDelete={(id) => { void investigation.remove(id); }}
          />
        }
        thread={
            <div style={{ paddingTop: 24, paddingBottom: 8, display: "flex", flexDirection: "column", gap: 34 }}>

            {/* Thread content is a conversation, not one giant console card. Individual
                decision and execution components keep their own boundaries. */}
            {(investigation.turns.length > 0 || pendingUser || investigation.loading || investigation.result || investigation.error || phase !== "idle") && (
            <section aria-label="Copilot conversation" className="min-w-0">
            <ChatTurns
              turns={investigation.turns}
              pendingUser={pendingUser}
              working={Boolean(pendingUser && loading && !investigation.loading)}
              liveAssistant={liveAssistant}
              liveNote={!isError ? response?.answer?.note : null}
              liveTone={isError ? "error" : "default"}
              sessionSigning={sessionSigning}
              hideReceiptFor={cardDrawsRun ? workflow.view?.id ?? null : null}
            />
            {txHash && !investigation.turns.some((turn) => turn.executionReceipt) ? (
              <div className="flex items-start gap-2.5 max-w-[85%]">
                <div className="w-[18px] shrink-0" aria-hidden="true" />
                <div className="min-w-0 w-full">
                  <ExecutionStepper
                    steps={[
                      {
                        id: "direct-tx",
                        label: "",
                        op: String(action?.op ?? "submit"),
                        asset: String(action?.asset ?? ""),
                        amount: String(action?.amount ?? ""),
                        status: "settled",
                        txHash,
                      },
                    ]}
                    currentStepIndex={0}
                    autoApprove={sessionSigning}
                  />
                </div>
              </div>
            ) : null}
            {(!isStaleInvestigation && (investigation.loading || investigation.result || investigation.error || workflow.view || workflow.loading || signingJournal)) && (
              <InvestigationCard
                {...investigation}
                omitTranscript
                onPropose={investigation.result?.continuation
                  ? (candidateId) => {
                      const continuation = investigation.result!.continuation;
                      // Claimed here so the auto-prepare effect does not send the same plan again.
                      claimDispatch(address, `propose:${continuation}:${candidateId}`);
                      void workflow.propose(continuation, candidateId);
                    }
                  : undefined}
                workflow={runIsPast ? null : workflow.view}
                planWithdrawn={workflow.stale}
                planLiveFloor={workflow.quote}
                workflowError={workflow.error}
                workflowLoading={workflow.loading || signingJournal}
                onApprove={() => { void workflow.approve(); }}
                onResume={() => { void workflow.resume(); }}
                onCancelPlan={() => { void workflow.cancelPlan(); }}
                onSign={() => { void signJournalXdr(false); }}
                wallet={address}
                autoSign={sessionSigning}
                onApproveCandidate={investigation.result?.continuation ? approveCandidate : undefined}
                onReply={(text) => { void run(text); }}
                onWrite={(op) => {
                  const request = investigation.result?.originalRequest ?? "";
                  // Only this click opens an account; the server never creates one unasked.
                  void postCopilot({ pending_write: { op }, message: request }, request);
                }}
                threadDefersReceipt={cardDrawsRun}
              />
            )}
            <div
              hidden={
                !response && !loading &&
                !!(investigation.turns.length > 0 || investigation.loading || investigation.result || investigation.error || workflow.view || workflow.loading)
              }
              className="min-w-0"
            >
              {/*
                The idle capability grid is gone. It listed four example prompts in big
                tappable cards, which is exactly what the Prompts button already opens — the
                same suggestions twice, with the duplicate occupying the space the actual
                work needs. An empty console now shows nothing rather than filler.
              */}
              {/* A turn in flight or complete */}
              {phase !== "idle" && (phase !== "done" || strategyOpen) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, animation: "cp-in 300ms ease-out forwards" }}>
                  { !submittedRecorded && !pendingUser && (submitted || investigation.turns.find((t) => t.role === "user")?.text) && (
                    <UserBubble>
                      {submitted || investigation.turns.find((t) => t.role === "user")?.text}
                    </UserBubble>
                  )}

                  {loading && !multiLeg && !pendingUser ? (
                    <p role="status" aria-live="polite" className="text-[13px] leading-[20px] text-violet-500">Working…</p>
                  ) : null}

                  {/* A multi-leg run gets the live execution card — one card that advances
                      in place, narrating each leg as it settles. The plain step list stays
                      for single-turn work, where there is no chain to narrate. */}
                  {multiLeg && execLegs.length > 0 && (phase !== "done" || strategyOpen) ? (
                    <RunExecutionCard
                      eyebrow="02"
                      legs={execLegs}
                      hf={liveHf}
                      floor={
                        // "keep me above 1.4" in the prompt wins over the stored default.
                        strategyMetaRef.current.min_hf != null &&
                        Number.isFinite(Number(strategyMetaRef.current.min_hf))
                          ? Number(strategyMetaRef.current.min_hf)
                          : guardianFloor
                      }
                      busy={loading || signing}
                      signerLive={sessionSigning}
                      signerText={
                        sessionSigning
                          ? "vanna embedded signer"
                          : walletKind === "privy"
                            ? "privy wallet"
                            : "freighter wallet"
                      }
                      footerNote={
                        hfPaused
                          ? "Health factor dropped below the floor you asked for. Continue the remaining collateral/debt steps, or stop here. Settled legs stay on-chain."
                          : undefined
                      }
                      footerTone={hfPaused ? "warn" : undefined}
                      onCancel={loading || signing ? cancelInFlight : undefined}
                      onContinue={hfPaused ? continueRemainingLegs : undefined}
                      onStop={
                        hfPaused
                          ? stopRemainingLegs
                          : execLegs.some((l) => l.status === "failed")
                            ? reset
                            : undefined
                      }
                      onNewIntent={reset}
                      onViewTx={txHash ? () => window.open(txUrl(txHash), "_blank") : undefined}
                      onSubmitAmount={submitLegAmount}
                      onLpEntered={() => {
                        if (execLegs.length > 1) lpScrollPendingRef.current = true;
                      }}
                    />
                  ) : liveWriteUi ? (
                    <StepList steps={steps} running={loading} />
                  ) : null}

                  {/* Answer / note. Hidden while a hop is in flight so Strategy /
                      Ask another cannot sit under a live Cancel. Plain reads already
                      live in ChatTurns (user right, copilot left). */}
                  {phase === "answer" && (response || multiLeg) && (
                    liveWriteUi ||
                    response?.kind === "clarification" ||
                    !!followUp ||
                    (!submittedRecorded && !liveAssistant)
                  ) && (
                    <div className={liveWriteUi ? "mt-[26px]" : undefined} style={{ animation: "cp-in 300ms ease-out forwards" }}>
                      {(multiLeg || (isError && liveWriteUi) || (decision && !multiLeg && liveWriteUi)) && (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {(multiLeg || (isError && liveWriteUi)) && <Eyebrow>{multiLeg ? "Strategy" : "Note"}</Eyebrow>}
                          {decision && !multiLeg && liveWriteUi && <RiskChip decision={decision} />}
                        </div>
                      )}
                      {multiLeg ? (
                        <>
                          {response && (
                            <div className="mt-4">
                              <AssistantMessage note={response.answer?.note}>
                                {response.message}
                              </AssistantMessage>
                            </div>
                          )}
                          {/* No strategy card here. The plan is reviewed once in
                              "03 Approve plan"; from then on "02 Agent run" IS the live
                              step view. Repeating the same legs in a second card during and
                              after execution showed them twice with nothing left to decide. */}
                        </>
                      ) : response && !liveAssistant ? (
                        <div className="min-w-0">
                          {investigation.turns.length === 0 ? (
                            <AssistantMessage
                              tone={isError ? "error" : "default"}
                              note={response.answer?.note}
                            >
                              {response.message}
                            </AssistantMessage>
                          ) : null}
                          {sim && !multiLeg && marginProjected && <ImpactPanel sim={sim} />}
                        </div>
                      ) : null}

                      {/* USDC variant (or other) clarify chips */}
                      {response?.kind === "clarification" &&
                        response.clarify_options &&
                        response.clarify_options.length > 0 && (
                          <div className="mt-5 flex flex-col gap-2.5">
                            {response.intent?.template_id === "clarify_usdc_variant" ? null : (
                            <p className="font-mono text-[10.5px] uppercase tracking-[0.15em] text-vgray-400">
                              {response.pending_write?.clarify_slot === "fraction"
                                ? "how much to repay"
                                : response.pending_write?.clarify_slot === "borrow" ||
                                    response.pending_write?.clarify_slot === "collateral"
                                  ? "choose usdc type"
                                  : "choose an option"}
                            </p>
                            )}
                            <div className="flex flex-wrap gap-2.5">
                              {response.clarify_options.map((opt) => (
                                <button
                                  key={opt.id}
                                  type="button"
                                  disabled={loading}
                                  onClick={() => void pickClarifyOption(opt)}
                                  className="rounded-r3 border border-violet-100 bg-violet-50 px-4 py-3 text-left transition-colors hover:border-violet-400 disabled:opacity-50"
                                >
                                  <span className="block font-mono text-[13px] font-semibold text-violet-600">
                                    {opt.label}
                                  </span>
                                  {opt.description && (
                                    <span className="mt-0.5 block text-[12px] leading-snug text-vgray-500">
                                      {opt.description}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                      {!(loading || signing || hfPaused || (multiLeg && strategyOpen)) && followUp && (
                      <div className="mt-[22px] flex flex-wrap gap-2.5">
                          <button
                            type="button"
                            /**
                             * Loads the composer; it does not run.
                             *
                             * This suggestion is now a WRITE carrying the amount the user asked
                             * about, and with auto-approve on a write leaves no gate — one click
                             * here used to be one borrow, at whatever size the label said. Filling
                             * the box puts the amount in front of the user with Run one deliberate
                             * press away, which is also what makes the carried-through amount safe
                             * to show in the first place.
                             */
                            onClick={() => {
                              setIntentText(followUp);
                              inputRef.current?.focus();
                              inputRef.current?.scrollIntoView({
                                block: "center",
                                behavior: "smooth",
                              });
                            }}
                            className={`px-[18px] py-2.5 ${BTN_TINT}`}
                          >
                            {followUp}
                          </button>
                      </div>
                      )}
                    </div>
                  )}

                  {/* Multi-leg plan awaiting approval. Nothing has executed yet — the
                      server froze these steps and will only run them if we post the same
                      plan back, fingerprint intact. */}
                  {phase === "plan" && response?.plan && (
                    <PlanApprovalCard
                      plan={response.plan}
                      busy={loading}
                      sessionSigning={sessionSigning}
                      onApprove={approvePlan}
                      onModify={() => {
                        // Put the original wording back in the composer so it can be
                        // edited — v1 "modify" is re-prompting, not inline step editing.
                        setIntentText(submitted || "");
                        setResponse(null);
                      }}
                      onCancel={() => setResponse(null)}
                    />
                  )}

                  {/* Staged write — execution progress stepper inside the thread */}
                  {phase === "staged" && response && !txHash && (
                    <div
                      ref={stagedSectionRef}
                      className="mt-4 flex flex-col gap-3"
                      style={{ animation: "cp-in 300ms ease-out forwards" }}
                    >
                      <ExecutionStepper
                        steps={[
                          {
                            id: "direct-tx",
                            label:
                              response.preview?.human_summary ||
                              `${action?.op?.replace(/_/g, " ") ?? "submit"} ${action?.amount ?? ""} ${action?.asset ?? ""}`.trim(),
                            op: String(action?.op ?? "submit"),
                            asset: String(action?.asset ?? ""),
                            amount: String(action?.amount ?? ""),
                            status: signing ? "signing" : willAutoSubmit ? "submitting" : "pending",
                          },
                        ]}
                        currentStepIndex={0}
                        autoApprove={sessionSigning}
                      />

                      {sessionSigning && !willAutoSubmit && (
                        <p className="flex items-start gap-1.5 font-mono text-[11px]" style={{ color: WARN_INK }}>
                          <CircleAlert size={13} className="mt-px shrink-0" />
                          {decision === "block"
                            ? "Auto-approve is on, but the risk gate blocked this write — manual approval required."
                            : autoSubmitBlocked
                              ? "Auto-sign failed for this step — click Approve & sign to retry."
                              : "Auto-approve is on — click Approve & sign if auto-sign did not start."}
                        </p>
                      )}

                      {willAutoSubmit ? (
                        <div className="flex flex-wrap items-center gap-2.5">
                          <div className="flex flex-1 items-center gap-2.5 rounded-lg border border-violet-100 bg-violet-50/60 px-4 py-3 font-mono text-[12px] font-semibold text-violet-600">
                            <Loader2 size={14} className="animate-spin" />
                            Auto-approving — signing and submitting for you…
                          </div>
                          <button
                            type="button"
                            onClick={reset}
                            className="rounded-lg px-3.5 py-2.5 text-[13px] font-semibold text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-600"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2.5">
                          <button
                            type="button"
                            disabled={!address || signing}
                            onClick={signWithWallet}
                            className="flex-1 rounded-lg bg-gradient px-5 py-3 text-[14px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
                          >
                            {signing
                              ? "Signing…"
                              : !address
                                ? "Connect wallet to sign"
                                : action?.multi_leg
                                  ? "Confirm all legs & sign"
                                  : "Approve & sign"}
                          </button>
                          {!signing && (
                            <button
                              type="button"
                              onClick={() => {
                                setIntentText(submitted || "");
                                setResponse(null);
                                inputRef.current?.focus();
                              }}
                              className="rounded-lg border border-vgray-200 bg-transparent px-4 py-3 text-[13px] font-semibold text-vgray-700 transition-colors hover:border-violet-100 hover:bg-violet-50 hover:text-violet-600"
                            >
                              Modify
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={reset}
                            className="rounded-lg px-3.5 py-3 text-[13px] font-semibold text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-600"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Signing-authority consent gate.
                      Separate from the auto-sign gate on purpose: this one is not about
                      spend limits, it is the permission that has to exist before any
                      limit can be enforced. Wording never says "connect your wallet" —
                      the wallet IS connected, and telling the user to reconnect is the
                      dead end this panel exists to end. */}
                  {phase === "bind" && response && bindGate && (
                    <div className="mt-[26px] space-y-5" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <Eyebrow n="03">Signing authority</Eyebrow>
                      </div>
                      <p className="whitespace-pre-wrap text-subtext text-vgray-800">{response.message}</p>

                      {/* State of the two permissions, side by side. The whole diagnosis
                          of this bug is that these are different rows. */}
                      <div className="rounded-r4 border border-vgray-100 p-4">
                        <div className="flex flex-col gap-1.5">
                          <Row k="wallet connected" v="yes" color={ACCENT} />
                          <Row
                            k="vanna may sign"
                            v={
                              bindGate.status === "bound"
                                ? "authorized"
                                : bindGate.status === "pending"
                                  ? "awaiting your approval"
                                  : "not authorized"
                            }
                            color={bindGate.status === "bound" ? ACCENT : WARN_INK}
                          />
                          {bindGate.wallet_address && (
                            <Row k="wallet" v={`${bindGate.wallet_address.slice(0, 6)}…${bindGate.wallet_address.slice(-4)}`} />
                          )}
                        </div>
                      </div>

                      {/* In-app consent in flight — Privy may be showing its own sheet.
                          Deliberately renders INSTEAD of the fallback buttons so the
                          external link never flashes up during the path that replaces it. */}
                      {bindingInApp ? (
                        <div className="rounded-r4 border border-violet-100 bg-violet-50 p-4">
                          <p className="flex items-center gap-2 text-body-2 text-violet-600">
                            <Loader2 size={14} className="animate-spin" />
                            Authorizing Vanna as an additional signer on your wallet…
                          </p>
                        </div>
                      ) : bindGate.connect_url ? (
                        <div className="rounded-r4 border border-violet-100 bg-violet-50 p-4">
                          <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-violet-600">
                            <ShieldCheck size={14} /> authorize additional signer
                          </p>
                          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                            {/* Retrying in-app is the primary action whenever a signer id
                                exists — the same one gesture, not a trip to another tab. */}
                            {bindGate.signer_id && (
                              <button
                                type="button"
                                disabled={loading}
                                onClick={() => void completeWalletBindInApp(bindGate)}
                                className={`px-[18px] py-2.5 ${BTN_GRADIENT}`}
                              >
                                {loading ? "Working…" : "Authorize in app"}
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={loading || !bindGate.request_id}
                              onClick={() => void checkWalletBind(bindGate)}
                              className={`px-[18px] py-2.5 ${BTN_ON_TINT}`}
                            >
                              {loading ? "Checking…" : "Check again"}
                            </button>
                          </div>
                          <p className="mt-3 text-body-2 text-vgray-500">
                            Vanna is added <em>alongside</em> your own key — it never replaces it,
                            and you can revoke it in Privy whenever you want.
                          </p>
                          {/* Last resort, and framed as one. Reaching for this means the
                              in-app SDK path could not run at all. */}
                          <p className="mt-2 text-body-2 text-vgray-400">
                            Not working here?{" "}
                            <a
                              href={bindGate.connect_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 underline hover:text-violet-500"
                            >
                              Authorize on Vanna&apos;s page
                              <ExternalLink size={11} />
                            </a>
                            {bindGate.expires_in
                              ? ` · link valid ${Math.round(bindGate.expires_in / 60)} min`
                              : ""}
                          </p>
                        </div>
                      ) : (
                        <div
                          className="rounded-r4 border p-4"
                          style={{ borderColor: "var(--cp-warn-bd)", background: "var(--cp-warn-bg)" }}
                        >
                          <p className="text-body-2" style={{ color: WARN_INK }}>
                            {bindGate.status === "expired"
                              ? "The authorization link expired before it was completed."
                              : "No authorization link is available right now."}
                          </p>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void startWalletBind(bindGate.retry_action ?? undefined)}
                            className={`mt-3 px-[18px] py-2.5 ${BTN_GRADIENT}`}
                          >
                            {loading ? "Working…" : "Get a new link"}
                          </button>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={reset}
                        className="rounded-r2 px-[18px] py-2.5 text-[13px] font-semibold text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Auto-sign enable gate */}
                  {phase === "autosign" && response && (
                    <div className="mt-[26px] space-y-5" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <Eyebrow n="03">Auto-sign</Eyebrow>
                        {decision && <RiskChip decision={decision} />}
                      </div>
                      <p className="whitespace-pre-wrap text-subtext text-vgray-800">{response.message}</p>
                      {sim && marginProjected && <ImpactPanel sim={sim} />}
                      <div className="rounded-r4 border border-violet-100 bg-violet-50 p-4">
                        <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-violet-600">
                          <ShieldCheck size={14} /> enable auto-sign
                        </p>
                        {!address && <p className="mb-3 text-body-2" style={{ color: WARN_INK }}>Connect your wallet first.</p>}
                        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                          <button
                            type="button"
                            disabled={!address || loading}
                            onClick={() => enableAutoSign("use_defaults")}
                            className={`px-[18px] py-2.5 ${BTN_GRADIENT}`}
                          >
                            {(() => {
                              try {
                                const raw = response?.auto_sign?.raw as
                                  | { default_cap_usd?: number }
                                  | null
                                  | undefined;
                                const d = Number(raw?.default_cap_usd);
                                if (Number.isFinite(d) && d > 0) return `Defaults ($${d} / $${d})`;
                              } catch {
                                /* ignore */
                              }
                              return "Defaults (MCP default caps)";
                            })()}
                          </button>
                          <button
                            type="button"
                            disabled={!address || loading}
                            onClick={() => setShowCustom((s) => !s)}
                            aria-expanded={showCustom}
                            className={`px-[18px] py-2.5 ${BTN_ON_TINT}`}
                          >
                            Custom limits
                          </button>
                        </div>
                        {showCustom && (
                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <label className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">
                              max per tx USD
                              <input
                                value={customTx}
                                onChange={(e) => setCustomTx(e.target.value)}
                                className="mt-1 w-full border-b-2 border-vgray-200 bg-transparent pb-1 font-mono text-[15px] text-vgray-900 focus:border-violet-500 focus:outline-none"
                              />
                            </label>
                            <label className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">
                              max per day USD
                              <input
                                value={customDay}
                                onChange={(e) => setCustomDay(e.target.value)}
                                className="mt-1 w-full border-b-2 border-vgray-200 bg-transparent pb-1 font-mono text-[15px] text-vgray-900 focus:border-violet-500 focus:outline-none"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={!address || loading}
                              onClick={() => enableAutoSign("custom")}
                              className={`px-[18px] py-2.5 sm:col-span-2 ${BTN_GRADIENT}`}
                            >
                              Enable custom
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={reset}
                        className="rounded-r2 px-[18px] py-2.5 text-[13px] font-semibold text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                </div>
              )}
            </div>

            </section>
            )}
          </div>
        }
        composer={
          <>
            {/* Hero — only while the stage is empty. It shares the composer's block so
                the two move together as the grid recentres them. */}
            {stageEmpty && (
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div className="text-[28px] leading-[42px] font-semibold text-vgray-900">
                  What&apos;s the next move?
                </div>
                <div className="mt-1.5 text-[16px] leading-[24px] text-vgray-500">
                  Read the book, size a plan, or run a change.
                </div>
              </div>
            )}
            {openQuestionnaire && (
              /* Docked where the chat box is, so it must not grow over the thread: capped, with its own scroll. */
              <div style={{ maxHeight: "min(46vh, 440px)", overflowY: "auto", overscrollBehavior: "contain", borderRadius: 16 }}>
              <ClarifyQuestionnaire
                questionnaire={openQuestionnaire}
                busy={investigation.loading}
                onSubmit={(answers) => {
                  setClosedQuestionnaire(openQuestionnaire.id);
                  // The answer is this turn's user message; left on the earlier prompt, the thread
                  // redrew that prompt as a pending bubble under the answer.
                  setSubmitted(answers.summary);
                  void investigation.run(answers.summary, undefined, answers);
                }}
                onCancel={() => setClosedQuestionnaire(openQuestionnaire.id)}
                onSomethingElse={(text) => {
                  setClosedQuestionnaire(openQuestionnaire.id);
                  run(text);
                }}
              />
              </div>
            )}
            {/* The pill is styled inline for the reason recorded in globals.css: a custom
                class declared there did not survive into the served stylesheet, and the
                composer must never render as an unstyled row. */}
            <div
              hidden={!!openQuestionnaire}
              className="cp-composer"
              style={{
                minWidth: 0,
                background: "var(--cp-surface)",
                border: "1px solid var(--cp-g100)",
                borderRadius: 28,
                padding: "8px 8px 8px 18px",
              }}
            >
          {/* One surface, one Run. Which engine handles a turn is the server's decision from
              the request itself, never a mode the user has to pick — a person asking for a
              strategy should not have to know that research and execution are different code
              paths, and a mode switch made "deposit 5 XLM" silently non-executable. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (signing) return;
              /**
               * A paused swap answered with just the corrected token ("SOUSDC") used to fire
               * a brand-new, context-free message through `run()` — the router cannot infer
               * a whole trade from one word, so the paused strategy was silently abandoned
               * instead of resumed. When the composer is currently showing a swap leg
               * waiting on exactly this kind of answer, and the typed text resolves to a
               * known token, treat it as the answer to THAT leg instead.
               */
              const pausedSwap = execLegs.find(
                (l) => l.status === "needs_input" && l.op === "swap",
              );
              const resolvedToken = pausedSwap ? resolveAssetSymbolFromText(intentText) : null;
              if (pausedSwap && resolvedToken) {
                submitLegTokenAnswer(pausedSwap, resolvedToken);
                return;
              }
              run(intentText);
            }}
          >
            <div className="flex items-end gap-2">
              {/*
                A textarea that grows with the text, not a single-line input.
                A long intent scrolled sideways out of view, so the beginning of your own
                instruction — usually the objective, with the constraint at the end — was
                hidden exactly when you wanted to re-read it before running. It grows to six
                rows and then scrolls, so it can never push Run off the screen.

                Enter still runs; Shift+Enter takes a newline. Losing Enter-to-run to gain
                multiline would be a bad trade for the common case.
              */}
              <textarea
                ref={inputRef}
                value={intentText}
                onChange={(e) => setIntentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                // Short enough not to wrap the empty box onto a second line.
                placeholder={investigation.result?.question
                  ? "Answer the question, or refine the plan…"
                  : "Ask about a position, or describe a change"}
                aria-label="Copilot intent"
                maxLength={8000}
                rows={1}
                className="cp-composer-input min-w-0 flex-1 bg-transparent text-vgray-900 placeholder:text-vgray-300 focus:outline-none"
                // Inline, not a utility class: the drag-to-resize grip is the browser default
                // and must not appear. The box sizes itself from the text; a manual handle
                // only lets the user fight that.
                style={{ resize: "none" }}
                spellCheck={false}
              />
              <button
                type={loading || signing || investigation.loading || entry.loading ? "button" : "submit"}
                disabled={!loading && !signing && !investigation.loading && !entry.loading && !intentText.trim()}
                onClick={
                  loading || signing || investigation.loading || entry.loading
                    ? (e) => {
                        e.preventDefault();
                        entry.cancel();
                        investigation.cancel();
                        cancelInFlight();
                      }
                    : undefined
                }
                aria-label={loading || signing || investigation.loading || entry.loading ? "Cancel" : "Send"}
                // One round button in the pill: Send, or while a reply runs, Stop (the square).
                className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-100"
                style={{ background: "var(--gradient, linear-gradient(135deg, #FC5457 10%, #703AE6 80%))" }}
                title={loading || signing || investigation.loading || entry.loading ? "Stop" : "Send"}
              >
                {loading || signing || investigation.loading || entry.loading ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                    <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
          </form>

          {entry.error && <p role="alert" className="mt-3 text-[13px] text-imperial-500">{entry.error}</p>}

        </div>
            <p className="mt-1.5 text-center text-[11px] leading-[17px] text-vgray-400">
              {autoApproveUiOn
                ? "Auto-approve on · writes inside the limits run without a prompt"
                : "Auto-approve off · every write asks for a signature"}
            </p>
            {/* Starter prompts, shown only on an empty stage. They run through the same
                composer path a typed prompt does, so nothing here is a shortcut past the
                classifier, the reads or any gate. */}
            {stageEmpty && (
              <div style={{ paddingTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                {["Price of XLM", "What's my health factor?", "Deposit 5 XLM"].map((text) => (
                  <button
                    key={text}
                    type="button"
                    disabled={loading || signing || investigation.loading || entry.loading}
                    onClick={() => { void run(text); }}
                    className="w-full cursor-pointer rounded-r2 px-1.5 py-2.5 text-left text-[14px] leading-[21px] text-vgray-500 transition-colors hover:bg-vgray-50 hover:text-vgray-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </>
        }
      />
    </div>
  );

}

export default CopilotWorkspace;
