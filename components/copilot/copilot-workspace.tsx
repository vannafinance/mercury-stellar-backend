"use client";

// Vanna Copilot workspace — Gemini understands intent; MCP executes.
//
// Layout follows the Copilot design: an intent card that walks a turn through
// agent-run → answer / staged action / executed, a session log beneath it, and a
// right rail carrying live account health, autonomy state, and this session's
// on-chain writes.
//
// Theming: every surface/border/text colour comes from the app's own dark-aware
// tokens (`surface`, `vgray-*`, `shadow-vanna`), so the page follows the global
// light/dark toggle with no per-page theme state. The violet-tinted panels and
// venue colours the app's tokens don't invert come from the `.cp-root` scope in
// globals.css, which also re-themes the violet ramp for dark.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  LayoutTemplate,
  X,
  Loader2,
  Sparkles,
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
import { useCopilotSettingsStore, setAutoApprove } from "@/store/copilot-settings";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { deriveMarginHealth } from "@/lib/margin-health";
import { executeAction, isExecutable, type CopilotAction, type ExecuteResult } from "./execute";
import { isSignableXdr, signAndSubmitMcpXdr, type SignXdrResult } from "./sign-xdr";
import { executeClientTools } from "@/lib/assistant/client-tools";
import { PlanApprovalCard, type PlanPreview } from "./plan-approval-card";
import { RunExecutionCard, toRunLegStatus, type RunLeg } from "./run-execution-card";
import { HealthDial } from "./health-dial";
import { VENUE_BY_OP } from "@/lib/copilot/plan-approval";
import { AnswerView } from "./answer-view";
import { labelHasAmount, legKey, legKeyLoose } from "./leg-key";
import type { StructuredAnswer } from "@/lib/copilot/answer-schema";

interface BrainHealth {
  status: string;
  llm_provider: string;
  mcp_mode: string;
  templates: number;
  in_process?: boolean;
  execution_mode?: string;
}

interface AutoSignPrompt {
  status: "needs_confirmation" | "needs_enable";
  message: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  pending_write?: CopilotAction | null;
  /** MCP payload (e.g. default_cap_usd) — keep for UI labels, never invent caps. */
  raw?: Record<string, unknown> | null;
}

interface Simulation {
  hf_before: number | null;
  hf_after: number | null;
  collateral_before: number;
  collateral_after: number;
  debt_before: number;
  debt_after: number;
  ltv_before: number;
  ltv_after: number;
  liquidation_threshold: number;
  amount_usd: number;
  asset?: string | null;
}

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
  } | null;
  auto_sign?: AutoSignPrompt | null;
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

/** Idle-state cards: what the agent can actually run, with the MCP tool behind each. */
const CAPABILITIES: Array<{ tag: string; tone: "read" | "write" | "multi"; label: string; tool: string }> = [
  { tag: "read", tone: "read", label: "What's my health factor?", tool: "vanna_get_account_health" },
  { tag: "read", tone: "read", label: "How is the USDC pool doing?", tool: "vanna_get_pool_stats" },
  { tag: "write", tone: "write", label: "Deposit 5 XLM as collateral", tool: "vanna_deposit_collateral" },
  {
    tag: "write · multi-leg",
    tone: "multi",
    label: "Park 20 XLM then farm 10 BLUSDC at 2×",
    tool: "multi_leg_agent",
  },
];

const PROMPTS: Record<string, string[]> = {
  market: ["Price of XLM", "USDC pool stats", "Blend USDC reserve APY", "List protocol addresses"],
  "my account": [
    "What's my health factor?",
    "How much collateral do I have?",
    "How much do I owe?",
    "Can I borrow 20 USDC?",
  ],
  actions: [
    "Create Vanna wallet",
    "Open a margin account",
    "Deposit 5 XLM",
    "Lend 5 USDC",
    "Borrow 2 USDC",
    "Park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4",
    "Repay 5 BLUSDC then deposit 10 XLM as collateral",
    "Swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC",
    "Enable auto-sign",
  ],
};

/**
 * Suggested next prompt — a shortcut, not a claim about the answer. Keyed by the
 * `template_id` reads come back with, which is the MCP tool name.
 */
const FOLLOW_UP: Record<string, string> = {
  vanna_get_price: "USDC pool stats",
  vanna_get_prices_batch: "USDC pool stats",
  vanna_get_pool_stats: "Lend 5 USDC",
  vanna_get_blend_reserve_stats: "Lend 5 USDC",
  vanna_get_account_health: "Can I borrow 20 USDC?",
  vanna_get_debt: "Repay 2 USDC",
  vanna_get_collateral: "What's my health factor?",
  vanna_can_borrow: "Borrow 2 USDC",
  vanna_get_max_borrow: "Borrow 2 USDC",
  vanna_get_wallet_balance: "Deposit 5 XLM as collateral",
  // DOM-grounded page assist — optional bridge to live account data
  page_assist: "What is my health factor?",
};

const EMERALD = "#10b981";
const AMBER = "#f59e0b";
const IMPERIAL = "#fc5457";
const VIOLET = "#703ae6";

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
  if (s !== "" && !Number.isNaN(n) && Math.abs(n) < 1e15)
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return s;
}
/** Health factor → gauge fill. 3.00+ tops the bar, so 1.00 sits at 33.3%. */
function hfPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "0%";
  return `${Math.max(2, Math.min(100, (v / 3) * 100))}%`;
}
function hfColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EMERALD;
  if (v >= 1.5) return EMERALD;
  if (v >= 1.3) return AMBER;
  return IMPERIAL;
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
  color: string;
  /** Multi-leg / agent-chain parent — child hops update this instead of new rows. */
  strategy?: boolean;
  legs?: LogLeg[];
}
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
  return (
    <Tag className="font-mono text-[11px] font-normal uppercase tracking-[0.25em] text-vgray-400">
      {n ? (
        <>
          <span className="text-violet-500">{n}</span> ·{" "}
        </>
      ) : null}
      {children}
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
function shortenValue(v: string): { text: string; full: string | null } {
  const s = v.trim();
  if (/^[GC][A-Z0-9]{40,}$/.test(s)) {
    return { text: `${s.slice(0, 8)}…${s.slice(-6)}`, full: s };
  }
  // Long hex (tx hashes, XDR fragments) gets the same treatment.
  if (s.length > 34 && /^[0-9a-fA-F]{34,}$/.test(s)) {
    return { text: `${s.slice(0, 10)}…${s.slice(-6)}`, full: s };
  }
  return { text: s, full: null };
}

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  const { text, full } = shortenValue(v);
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-vgray-100 py-2 last:border-0">
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
 * Pause between chained legs.
 *
 * The gap exists so the previous transaction is visible on-chain before the next leg
 * reads state — not for the user's benefit. 2.2s was tuned when every leg needed a
 * manual signature, where the delay was hidden by the click. With auto-approve on there
 * is no click, so it became dead waiting between four legs.
 */
const CHAIN_DELAY_MS = 900;

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
  allow: { label: "risk gate · allow", color: EMERALD, bg: "rgba(16,185,129,.12)" },
  needs_confirmation: { label: "risk gate · confirm", color: AMBER, bg: "rgba(245,158,11,.14)" },
  block: { label: "risk gate · blocked", color: IMPERIAL, bg: "rgba(252,84,87,.14)" },
} as const;

function RiskChip({ decision }: { decision: keyof typeof RISK_TONE }) {
  const tone = RISK_TONE[decision];
  return (
    <span
      className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em]"
      style={{ color: tone.color, background: tone.bg }}
    >
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: tone.color }} />
      {tone.label}
    </span>
  );
}

/** The agent-run trace: one line per stage of the turn, with the tool that ran. */
function StepList({ steps, running }: { steps: Step[]; running: boolean }) {
  return (
    <div className="mt-3.5 rounded-2xl border border-vgray-100 bg-vgray-50 px-4 py-1.5 sm:px-[18px]">
      {steps.map((s, i) => (
        <div key={i} className="flex items-start gap-3 border-b border-vgray-100 py-[11px] last:border-0">
          <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <span
              className={`h-2 w-2 rounded-full ${s.state === "active" ? "animate-pulse" : ""}`}
              style={{
                background: s.state === "done" ? EMERALD : s.state === "active" ? VIOLET : "var(--color-vgray-300)",
                opacity: s.state === "pending" ? 0.45 : 1,
              }}
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <span
              className={`text-body-2 font-semibold ${s.state === "pending" ? "text-vgray-400" : "text-vgray-900"}`}
            >
              {s.label}
            </span>
            <span
              className={`break-all text-right font-mono text-[11px] ${
                s.state === "pending" ? "text-vgray-300" : "text-vgray-500"
              }`}
            >
              {s.detail}
            </span>
          </span>
        </div>
      ))}
      <div className="h-0.5 overflow-hidden">
        {running && <div className="h-0.5 w-[30%] rounded-full bg-gradient" style={{ animation: "cp-sweep 1.1s ease-in-out infinite" }} />}
      </div>
    </div>
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
};

type ResumeLeg = {
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label?: string;
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

  const tone = (status?: string) => {
    if (status === "ok" || status === "done") return EMERALD;
    if (
      status === "needs_sign" ||
      status === "needs_wallet_sign" ||
      status === "staged" ||
      status === "pending" ||
      status === "clarification"
    )
      return AMBER;
    if (status === "error" || status === "blocked" || status === "stopped_hf") return IMPERIAL;
    return "var(--color-vgray-400)";
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

  const borderColor = allOk
    ? "rgba(16,185,129,.35)"
    : anyFail
      ? "rgba(252,84,87,.28)"
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
            ? "rgba(16,185,129,.06)"
            : anyFail
              ? "rgba(252,84,87,.05)"
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
                style={{ color: tone(isOk ? "ok" : st), background: `${tone(isOk ? "ok" : st)}18` }}
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
                    style={{ color: st === "error" || st === "blocked" ? IMPERIAL : "var(--color-vgray-500)" }}
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

function FactsGrid({ data }: { data: Record<string, unknown> }) {
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
  ]);
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === "" || skipKeys.has(k)) continue;
    if (typeof v === "object") {
      if (Array.isArray(v)) continue;
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv != null && typeof sv !== "object") rows.push([prettyKey(sk), prettyVal(sv)]);
      }
    } else {
      rows.push([prettyKey(k), prettyVal(v)]);
    }
  }
  if (!rows.length) return null;
  return (
    <div className="mt-[18px] grid grid-cols-1 gap-x-8 rounded-2xl border border-vgray-100 bg-vgray-50 px-5 py-4 sm:grid-cols-2">
      {rows.slice(0, 10).map(([k, v], i) => (
        <Row key={i} k={k} v={v} />
      ))}
    </div>
  );
}

/**
 * Before→after projection for a staged write. Informational: the binding gates
 * run in the MCP server and the Sign Service, so this panel only appears when
 * the brain managed to read the account and project the impact.
 */
function ImpactPanel({ sim }: { sim: Simulation }) {
  const after = sim.hf_after;
  const color = hfColor(after);
  const rows: Array<{ k: string; before: string; after: string }> = [
    { k: "collateral", before: usd(sim.collateral_before), after: usd(sim.collateral_after) },
    { k: "debt", before: usd(sim.debt_before), after: usd(sim.debt_after) },
    {
      k: "ltv",
      before: `${(sim.ltv_before * 100).toFixed(1)}%`,
      after: `${(sim.ltv_after * 100).toFixed(1)}%`,
    },
    { k: "size", before: "—", after: usd(sim.amount_usd) },
  ];

  // A zeroed baseline means the account read failed, not that the position is empty —
  // the two are indistinguishable in this payload. Rendering it drew a full panel of
  // "$0.00 → $0.00" and "∞ → ∞" beside a funded account, which reads as a real
  // projection of nothing happening. Say what we know instead of drawing a false one.
  const noBaseline =
    !(Number.isFinite(sim.collateral_before) && sim.collateral_before > 0) &&
    !(sim.hf_before != null && Number.isFinite(sim.hf_before) && sim.hf_before > 0);
  if (noBaseline) {
    return (
      <div className="mt-[18px] rounded-2xl border border-vgray-100 bg-vgray-50 px-5 py-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-violet-500">
          projected impact
        </p>
        <p className="text-[13px] leading-[19px] text-vgray-500">
          Not available — reading your current position failed, so there is no baseline to
          project from. Your live figures are on the margin page.
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
        <div className="absolute inset-y-0 left-[33.3%] w-0.5" style={{ background: IMPERIAL }} />
        <div className="absolute inset-y-0 left-[43.3%] w-0.5" style={{ background: AMBER }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-vgray-400">
        <span style={{ color: IMPERIAL }}>1.00 liquidation</span>
        <span style={{ color: AMBER }}>1.30 caution</span>
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

export function CopilotWorkspace() {
  const address = useUserStore((s) => s.address);
  const walletKind = useUserStore((s) => s.walletKind);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const storeGrossCollateral = useMarginAccountInfoStore((s) => s.grossCollateralValue);
  const storeCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const storeBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const storeNetValue = useMarginAccountInfoStore((s) => s.totalValue);
  const autoApprove = useCopilotSettingsStore((s) => (address ? !!s.autoApproveByWallet[address] : false));

  // Same live snapshot feed as margin / portfolio so the right rail tracks
  // real on-chain HF / collateral / debt instead of a one-shot store paint.
  const { snapshot, refresh: refreshSnapshot } = useAccountSnapshot(address);

  const [intentText, setIntentText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [health, setHealth] = useState<BrainHealth | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [customTx, setCustomTx] = useState("500");
  const [customDay, setCustomDay] = useState("2000");
  const [showCustom, setShowCustom] = useState(false);
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
  /** Parent strategy prompt for client next_step hops (session log grouping). */
  const strategyParentRef = useRef<{ id: string; prompt: string } | null>(null);
  /**
   * Accumulated multi-leg steps across sequential hop POSTs. Each hop only returns
   * the legs it ran; the session log already merges via legKey — the strategy card
   * must use the same accumulator or it renumbers the last hop as "1.".
   */
  const strategyStepsRef = useRef<MultiLegStepUi[]>([]);
  const [strategySteps, setStrategySteps] = useState<MultiLegStepUi[]>([]);
  /** Strategy meta (summary, HF floor, SA) from multi-leg payloads — survives hop clears. */
  const strategyMetaRef = useRef<Record<string, unknown>>({});
  const abortRef = useRef<AbortController | null>(null);
  /** Stops chain effect + in-flight fetch without wiping settled log legs. */
  const cancelledRef = useRef(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

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

      if (at >= 0) {
        merged[at] = {
          ...merged[at],
          // The resolved label wins — the row should read "Borrow 15 XLM", not stay on the
          // amount-less wording it was planned with.
          label: labelHasAmount(keyed) ? keyed : merged[at].label,
          amount: leg.amount != null ? leg.amount : merged[at].amount,
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
    strategyStepsRef.current = merged;
    setStrategySteps(merged);
    return merged;
  }, []);

  const resetStrategyAccumulator = useCallback(() => {
    strategyStepsRef.current = [];
    setStrategySteps([]);
    strategyMetaRef.current = {};
  }, []);

  // Session signing only applies to Privy embedded wallets — Freighter always
  // prompts through its extension, so the toggle can't apply there.
  const sessionSigningAvailable = walletKind === "privy" && !!address;
  const sessionSigning = sessionSigningAvailable && autoApprove;

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
  const effSmartAccount = snapshot?.marginAccountAddress ?? smartAccount;
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
  const netValue = snapshot?.totalValue ?? storeNetValue ?? derivedHealth.totalValue;
  const liveHf = effHasAccount && healthFactor ? healthFactor : null;

  /** Force-refresh rail stats after a prompt/sign so values match margin page. */
  const refreshRailStats = useCallback(
    async (opts?: { force?: boolean }) => {
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
        await refreshSnapshot();
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
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusFromKind = (kind: ChatResponse["kind"] | undefined): string => {
    if (kind === "executed") return "executed";
    if (kind === "needs_wallet_sign") return "staged";
    if (kind === "needs_auto_sign") return "needs sign";
    if (kind === "blocked") return "blocked";
    if (kind === "error") return "error";
    if (kind === "answer") return "answered";
    return "clarify";
  };

  const colorFromKind = (kind: ChatResponse["kind"] | undefined): string => {
    if (kind === "executed" || kind === "answer") return EMERALD;
    if (kind === "blocked" || kind === "error") return IMPERIAL;
    if (kind === "needs_wallet_sign" || kind === "needs_auto_sign") return VIOLET;
    return AMBER;
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
      const color = colorFromKind(data.kind);
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
            const at = merged.findIndex((m) => legKey(m.label) === k);
            if (at >= 0) {
              // Keep the first label seen so the row does not re-word itself mid-run,
              // but always take the newer status.
              merged[at] = { ...merged[at], status: leg.status };
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
              status: allDone ? "executed" : overall,
              color: allDone || overall === "executed" ? EMERALD : color,
              strategy: true,
              legs: finalLegs,
            },
            ...without,
          ].slice(0, 8);
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
                status: status === "executed" ? "in progress" : status,
                color: AMBER,
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
            ].slice(0, 8);
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
          const legIdx = legs.findIndex((l) => legKey(l.label) === hopKey);
          if (legIdx >= 0) {
            legs[legIdx] = {
              ...legs[legIdx],
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
          parent.color =
            parent.status === "executed" ? EMERALD : status === "staged" ? VIOLET : AMBER;
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
              status: status === "executed" ? "in progress" : status,
              color: status === "executed" ? AMBER : color,
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
          ].slice(0, 8),
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
            status,
            color,
          },
          ...prev,
        ].slice(0, 8),
      );
    },
    [],
  );

  const pushActivity = useCallback((label: string, hash: string | null | undefined) => {
    if (!hash) return;
    setActivity((prev) => [{ label, hash, ts: Date.now() }, ...prev].slice(0, 5));
  }, []);

  const postCopilot = useCallback(
    async (
      body: Record<string, unknown>,
      promptLabel: string,
      opts?: { chainHop?: boolean },
    ) => {
      if (cancelledRef.current && opts?.chainHop) {
        return null;
      }

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      // Keep last response on chain hops so the strategy card doesn't flash empty;
      // full new prompts still clear.
      if (!opts?.chainHop && !body.summarize_execution) {
        setResponse(null);
      }
      setShowCustom(false);
      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: address ?? "guest",
            tier: "paid",
            smart_account: smartAccount ?? null,
            ...body,
          }),
          signal: ac.signal,
        });
        if (cancelledRef.current) {
          return null;
        }
        const data = (await res.json()) as ChatResponse;
        // Strip markdown stars so the UI never shows **BLUSDC**
        if (data.message) data.message = stripMarkdownLite(data.message);
        if (data.preview?.human_summary) {
          data.preview.human_summary = stripMarkdownLite(data.preview.human_summary);
        }
        // G-wallet create/connect and page tools run in the browser only.
        if (Array.isArray(data.client_tools) && data.client_tools.length) {
          executeClientTools(data.client_tools);
        }

        // Absorb multi-leg hop legs into the shared accumulator (same legKey as log).
        const d = (data.data ?? null) as Record<string, unknown> | null;
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
        if (body.summarize_execution && strategyStepsRef.current.length) {
          data.data = {
            ...strategyMetaRef.current,
            multi_leg: true,
            multi_leg_steps: strategyStepsRef.current,
            ...(data.data && typeof data.data === "object" ? data.data : {}),
          };
        }

        setResponse(data);
        // Agent-chain hops (pending_write / explicit chain) fold into the parent log row.
        // Full multi_leg payloads create/refresh the parent strategy row.
        // Do not log pure summarize receipts as a new turn noise — still fold if multi.
        if (!body.summarize_execution) {
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
        void refreshRailStats({ force });
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
        const failed: ChatResponse = { kind: "error", message: "Copilot request failed." };
        setResponse(failed);
        pushLog(promptLabel, failed);
        return failed;
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setLoading(false);
      }
    },
    [address, smartAccount, pushLog, pushActivity, refreshRailStats, absorbStrategySteps],
  );

  const cancelInFlight = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setSigning(false);
    toast("Request cancelled — completed steps stay in the log.", { duration: 3500 });
  }, []);

  const run = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || loading) return;
      cancelledRef.current = false;
      resetStrategyAccumulator();
      setSubmitted(t);
      setIntentText(t);
      setPaletteOpen(false);
      await postCopilot({ message: t }, t);
    },
    [loading, postCopilot, resetStrategyAccumulator],
  );

  /**
   * Send an approved plan back for execution.
   *
   * Posts the plan verbatim — same plan_id, same created_at, same steps. The server
   * re-hashes the steps and refuses anything that no longer matches what was shown, so
   * this must not normalise, reorder or "tidy" the payload on the way out.
   */
  const approvePlan = useCallback(
    async (plan: PlanPreview) => {
      if (loading) return;
      // Keep the user's original wording as the log label and adopt the plan as the
      // strategy parent, so approval and every leg after it update one row rather than
      // opening a second "Approved plan" entry beside the prompt that created it.
      const label = submitted || plan.summary || `Approve ${plan.steps.length} steps`;
      strategyParentRef.current = { id: `plan-${plan.plan_id}`, prompt: label };
      setPaletteOpen(false);
      await postCopilot(
        {
          message: "approve plan",
          approved_plan: {
            plan_id: plan.plan_id,
            created_at: plan.created_at,
            steps: plan.steps.map((s) => ({
              op: s.op,
              asset: s.asset,
              amount: s.amount,
              leverage: s.leverage,
            })),
          },
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
      const label = summary || `Resume ${legs.length} steps`;
      setSubmitted(label);
      setIntentText(label);
      setPaletteOpen(false);
      await postCopilot(
        {
          message: label,
          resume_multi_leg: { summary: label, legs },
        },
        label,
      );
    },
    [loading, postCopilot],
  );

  const enableAutoSign = useCallback(
    async (action: "start" | "use_defaults" | "custom" | "disable") => {
      const label =
        action === "disable"
          ? "Disable auto-sign"
          : action === "use_defaults"
            ? "Enable auto-sign (MCP defaults)"
            : action === "custom"
              ? `Enable auto-sign ($${customTx}/$${customDay || customTx})`
              : "Enable auto-sign";
      setSubmitted(submitted ?? label);
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
      );
      // Sync local auto-approve (session auto-submit) with the user's cap choice.
      // Even if MCP Sign Service fails user-assertion, local session signing still
      // auto-submits staged XDRs — caps are stored for UI + guardian policy.
      if (address && data) {
        if (action === "disable") {
          setAutoApprove(address, false);
        } else if (action === "use_defaults" || action === "custom") {
          if (data.kind !== "needs_auto_sign") {
            setAutoApprove(address, true);
            const fromMcp = Number(
              (data.data as { default_cap_usd?: number } | null | undefined)?.default_cap_usd,
            );
            const mcpDef = Number.isFinite(fromMcp) && fromMcp > 0 ? fromMcp : 1000;
            const txCap = action === "custom" ? Number(customTx) || mcpDef : mcpDef;
            const dayCap =
              action === "custom" ? Number(customDay || customTx) || txCap : mcpDef;
            try {
              localStorage.setItem(
                "vanna_copilot_auto_caps",
                JSON.stringify({ max_per_tx_usd: txCap, max_per_day_usd: dayCap }),
              );
            } catch {
              /* ignore */
            }
            toast.success(`Auto-approve on · $${txCap}/tx · $${dayCap}/day`);
          }
        }
      }
    },
    [postCopilot, customTx, customDay, response, submitted, address],
  );

  /**
   * Resume a write after the user picks a USDC variant (BLUSDC / AQUSDC / SOUSDC).
   * Server stored the pending op+amount; we inject the chosen asset and re-run.
   */
  const pickClarifyOption = useCallback(
    async (opt: ClarifyOption) => {
      const pw = response?.pending_write;
      if (!pw?.op) {
        // Fallback: rephrase as a full message
        await run(`${opt.id}`);
        return;
      }
      const label = `${pw.op.replace(/_/g, " ")} ${pw.amount ?? ""} ${opt.id}`.trim();
      setSubmitted(label);
      setIntentText(label);
      await postCopilot(
        {
          message: label,
          pending_write: {
            op: pw.op,
            asset: opt.id,
            amount: pw.amount ?? null,
            leverage: pw.leverage ?? null,
          },
        },
        label,
      );
    },
    [response, postCopilot, run],
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
    const action = response?.preview?.action;
    const nextStep = response?.next_step ?? null;
    // A mock-mode or garbled envelope falls back to the local rebuild rather than
    // erroring at the sign step (see `isSignableXdr`).
    const xdr = isSignableXdr(response?.unsigned_xdr) ? response!.unsigned_xdr! : null;
    if (!xdr && (!action || !isExecutable(action))) {
      toast.error("Nothing to sign — re-run the request.");
      return;
    }
    if (!address) {
      toast.error("Connect your wallet first.");
      return;
    }
    setSigning(true);
    try {
      const amount = typeof action?.amount === "number" && action.amount > 0 ? action.amount : 0;
      const result: ExecuteResult | SignXdrResult = xdr
        ? await signAndSubmitMcpXdr(xdr, address)
        : await executeAction(action!, {
            amount,
            walletAddress: address,
            smartAccount,
          });
      if (result.ok) {
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
        await refreshRailStats({ force: true });

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
        const remainingFromData = legsFromData("remaining_legs") ?? legsFromData("resume_legs");
        const preferResume =
          (response?.data as any)?.prefer_resume_multi_leg === true ||
          // Auto-approve is a standing instruction to keep going without asking.
          ((response?.data as any)?.can_resume === true && autoApprove) ||
          (remainingFromData && remainingFromData.length > 0);

        // Advance hop legs to ok in the shared accumulator (and current payload).
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
        const awaiting = new Set(["needs_sign", "needs_wallet_sign", "staged"]);
        let claimed = false;
        const patched: MultiLegStepUi[] = raw
          ? raw.map((s) => {
              if (claimed || !awaiting.has(String(s?.status ?? ""))) return s;
              claimed = true;
              return { ...s, status: "ok", tx_hash: result.hash ?? s.tx_hash ?? null };
            })
          : [];
        if (patched.length) {
          absorbStrategySteps(patched);
          strategyMetaRef.current = {
            ...strategyMetaRef.current,
            ...d0,
            multi_leg_steps: strategyStepsRef.current,
          };
        }
        // "Done" requires every leg to actually be ok, not merely that nothing is queued.
        const done =
          patched.length > 0 &&
          patched.every((s) => String(s?.status ?? "") === "ok") &&
          (!preferResume || !remainingFromData?.length);

        setResponse((prev) => {
          if (!prev) return prev;
          const d = (prev.data ?? {}) as Record<string, unknown>;
          return {
            ...prev,
            kind: "executed",
            data: {
              ...d,
              multi_leg_steps: strategyStepsRef.current.length
                ? strategyStepsRef.current
                : patched,
              headline: done ? "All steps completed — strategy is live." : undefined,
              can_resume: done ? false : d.can_resume,
            },
            execution: {
              status: done ? "completed" : "partial",
              tx_hash: result.hash ?? prev.execution?.tx_hash ?? null,
              steps: prev.execution?.steps,
            },
          } as ChatResponse;
        });

        if (preferResume && remainingFromData && remainingFromData.length > 0) {
          if (cancelledRef.current) return;
          const parentPrompt =
            strategyParentRef.current?.prompt ||
            String((response?.data as any)?.strategy_summary || submitted || "Continue strategy");
          if (!strategyParentRef.current) {
            strategyParentRef.current = {
              id: response?.request_id || `strat-${Date.now()}`,
              prompt: parentPrompt,
            };
          }
          // Prevent the executed-effect from also firing resume_multi_leg
          const resumeKey = `${response?.request_id ?? "exec"}:resume:${remainingFromData.map((l) => l.op).join(",")}`;
          nextStepFiredRef.current = resumeKey;
          toast.success(
            `Step confirmed — continuing ${remainingFromData.length} remaining leg(s)…`,
            { duration: 3500 },
          );
          // Strip remaining_legs so interim executed response does not re-trigger resume
          setResponse({
            kind: "executed",
            message: `Step done${result.hash ? ` · ${result.hash.slice(0, 12)}…` : ""}. Continuing strategy…`,
            mcp: response?.mcp ?? null,
            preview: response?.preview ?? null,
            execution: { status: "signed_and_submitted", tx_hash: result.hash ?? null },
            request_id: response?.request_id,
            data: {
              ...(response?.data || {}),
              multi_leg: true,
              multi_leg_steps: strategyStepsRef.current,
              remaining_legs: null,
              prefer_resume_multi_leg: false,
            },
          });
          await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
          if (cancelledRef.current) return;
          await refreshRailStats({ force: true });
          setSubmitted(parentPrompt);
          await postCopilot(
            {
              message: parentPrompt,
              resume_multi_leg: {
                summary: parentPrompt,
                legs: remainingFromData,
              },
            },
            parentPrompt,
            { chainHop: true },
          );
          return;
        }

        // Legacy 2-hop next_step chain (deposit→borrow only)
        if (nextStep?.op && nextStep.amount != null && nextStep.amount > 0) {
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
          await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
          if (cancelledRef.current) return;
          await refreshRailStats({ force: true });
          setSubmitted(strategyParentRef.current?.prompt || submitted || label);
          await postCopilot(
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
          strategyParentRef.current?.prompt ||
          String(strategyMetaRef.current.strategy_summary || submitted || summary);

        if (hasStrategy && ranLegs.some((l) => l.status === "ok" || l.status === "done")) {
          /**
           * "All steps completed" only when they are. This branch is reached after the
           * last signature the CLIENT was asked for, which is not the same as the last
           * leg of the strategy: a leg still waiting on an amount was never staged, so it
           * never asked for a signature. Announcing completion there told the user a
           * delta-neutral carry was live when only its collateral leg had settled.
           */
          const unfinished = strategyStepsRef.current.filter(
            (s) => !["ok", "done"].includes(String(s.status ?? "")),
          );
          setResponse({
            kind: "executed",
            message: `Submitted with your wallet${result.hash ? ` · ${result.hash}` : ""}.`,
            mcp: response?.mcp ?? null,
            preview: response?.preview ?? null,
            execution: { status: "signed_and_submitted", tx_hash: result.hash ?? null },
            request_id: response?.request_id,
            data: {
              ...strategyMetaRef.current,
              multi_leg: true,
              multi_leg_steps: strategyStepsRef.current,
              headline: unfinished.length
                ? `${strategyStepsRef.current.length - unfinished.length} of ${strategyStepsRef.current.length} steps settled — ${unfinished.length} still to run.`
                : "All steps completed — strategy is live.",
            },
          });
          if (!cancelledRef.current) {
            await postCopilot(
              {
                message: intent,
                summarize_execution: { intent, legs: ranLegs },
              },
              intent,
              { chainHop: true },
            );
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
        toast.error(result.error);
        // A failed-but-submitted turn (confirmation timeout) still has a hash worth
        // keeping, so the user gets an explorer link instead of a dead end.
        if ("hash" in result && result.hash) {
          pushActivity(response?.preview?.human_summary || submitted || "Submitted", result.hash);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign failed");
    } finally {
      setSigning(false);
    }
  }, [
    response,
    address,
    smartAccount,
    submitted,
    pushActivity,
    postCopilot,
    refreshRailStats,
    absorbStrategySteps,
    // Read inside `preferResume`. Omitting it would capture the toggle's value from the
    // render this callback was created in, so turning auto-approve on mid-strategy would
    // not take effect until something else re-created the callback.
    autoApprove,
  ]);

  /**
   * Session signing: submit a staged write without the manual approve click.
   *
   * This is what the per-wallet auto-approve toggle has always promised (see
   * store/copilot-settings) and it was never wired, so the button asked for a click
   * even with the toggle on. It runs client-side on purpose: the Sign Service's
   * server-side auto-sign needs a user-scoped WorkOS assertion that the copilot
   * can't mint (it holds an M2M token), whereas a Privy embedded wallet signs
   * programmatically with no popup — so the opt-in can be honoured here.
   *
   * Deliberately narrow. Multi-leg strategies and anything the risk gate didn't
   * clear always wait for an explicit click, and each response is submitted at most
   * once (keyed by request_id) so a re-render can't double-spend.
   */
  const autoSubmittedRef = useRef<string | null>(null);
  const nextStepFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (response?.kind !== "needs_wallet_sign") return;
    if (!sessionSigning || signing) return;
    // Allow sequential agent steps (deposit→borrow) even if labeled multi-leg.
    // Only skip true risk-blocked turns.
    if (response.preview?.risk?.decision === "block") return;

    const key = response.request_id ?? response.preview?.human_summary ?? "pending";
    if (autoSubmittedRef.current === key) return;
    autoSubmittedRef.current = key;
    void signWithWallet();
  }, [response, sessionSigning, signing, signWithWallet]);

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
    const remaining = legsFrom("remaining_legs") ?? legsFrom("resume_legs");
    const canResumeFlag = (response.data as any)?.can_resume === true;
    const preferResume =
      (response.data as any)?.prefer_resume_multi_leg === true ||
      // Auto-approve is a standing instruction to continue without asking. Without it,
      // the button stays and the user drives each leg.
      (canResumeFlag && autoApprove) ||
      (remaining && remaining.length > 0 && (response.data as any)?.multi_leg);

    if (preferResume && remaining && remaining.length > 0) {
      const key = `${response.request_id ?? "exec"}:resume:${remaining.map((l) => l.op).join(",")}`;
      if (nextStepFiredRef.current === key) return;
      nextStepFiredRef.current = key;
      const parentPrompt =
        strategyParentRef.current?.prompt ||
        String((response.data as any)?.strategy_summary || submitted || "Continue strategy");
      if (!strategyParentRef.current) {
        strategyParentRef.current = {
          id: response.request_id || `strat-${Date.now()}`,
          prompt: parentPrompt,
        };
      }
      toast.success(`Continuing ${remaining.length} remaining step(s)…`, { duration: 3000 });
      void (async () => {
        await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
        if (cancelledRef.current) return;
        await refreshRailStats({ force: true });
        if (cancelledRef.current) return;
        setSubmitted(parentPrompt);
        await postCopilot(
          {
            message: parentPrompt,
            resume_multi_leg: { summary: parentPrompt, legs: remaining },
          },
          parentPrompt,
          { chainHop: true },
        );
      })();
      return;
    }

    const next = response.next_step;
    if (!next?.op || next.amount == null || !(next.amount > 0)) return;
    const key = `${response.request_id ?? "exec"}:${next.op}:${next.amount}:${next.asset ?? ""}`;
    if (nextStepFiredRef.current === key) return;
    nextStepFiredRef.current = key;

    const label =
      next.label ||
      `Auto step ${next.step ?? 2}: ${next.op} ${next.amount} ${next.asset || ""}`.trim();
    toast.success("Step confirmed — next leg in ~2s…", { duration: 3000 });
    void (async () => {
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
      setSubmitted(strategyParentRef.current?.prompt || submitted || label);
      await postCopilot(
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
    })();
  }, [response, loading, signing, postCopilot, refreshRailStats, submitted, autoApprove]);

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
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setSigning(false);
    setSubmitted(null);
    setResponse(null);
    setIntentText("");
    setShowCustom(false);
    autoSubmittedRef.current = null;
    nextStepFiredRef.current = null;
    strategyParentRef.current = null;
    resetStrategyAccumulator();
    inputRef.current?.focus();
  };

  const brainOnline = health?.status === "ok";
  const multiLeg =
    isMultiLegResponse(response?.data ?? null) || strategySteps.length > 0;
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
  const phase = loading
    ? "running"
    : response?.kind === "plan_preview"
      ? "plan"
      : response?.kind === "needs_auto_sign"
        ? "autosign"
        : response?.kind === "needs_wallet_sign"
          ? "staged"
          : response?.kind === "executed"
            ? "done"
            : response
              ? "answer"
              : "idle";

  /** Agent-run trace, built from the turn that actually happened. */
  const steps = useMemo<Step[]>(() => {
    if (loading) {
      return [
        { label: "Parsing intent", detail: "gemini · vertex", state: "active" },
        { label: "MCP tool call", detail: multiLeg ? "multi-leg plan…" : "pending", state: "pending" },
        { label: "Composing response", detail: "pending", state: "pending" },
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
  }, [loading, response, strategySteps]);

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
  const runLegs = useMemo<RunLeg[]>(() => {
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
    return src.map((s, i) => {
      const op = String(s.op ?? "step");
      const amt = s.amount;
      const hasAmt = amt != null && Number.isFinite(Number(amt)) && Number(amt) > 0;
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
        status: toRunLegStatus(s.status, i === inFlightIdx),
        txHash: s.tx_hash ? truncHash(String(s.tx_hash)) : null,
        // The server's `message` is a humanized reason. Only surface it where it is one:
        // on a leg that failed or is asking for something, never on a settled leg.
        error:
          s.message && toRunLegStatus(s.status) === "failed" ? String(s.message) : null,
        question:
          s.message && toRunLegStatus(s.status) === "needs_input" ? String(s.message) : null,
      };
    });
  }, [strategySteps, response, loading, TERMINAL_LEG, submitted]);

  /**
   * Resume from a paused leg once the user supplies the amount the plan never carried.
   * The leg goes first with its new amount, then every leg still unstarted after it —
   * the server runs them in order, so the rest of the strategy continues untouched.
   */
  const submitLegAmount = useCallback(
    (leg: RunLeg, amount: number) => {
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
      const carry = (l: RunLeg, overrideAmount?: number) => ({
        op: l.op,
        asset: l.asset,
        amount:
          overrideAmount ??
          (l.amount != null ? Number(String(l.amount).replace(/,/g, "")) : null),
        leverage: l.leverage ?? null,
        label: l.label,
      });

      const rest = runLegs.filter((l) => l.n > leg.n && l.status !== "ok").map((l) => carry(l));
      const summary = String(
        strategyMetaRef.current.strategy_summary || submitted || "Continue strategy",
      );
      void resumeMultiLeg([carry(leg, amount), ...rest], summary);
    },
    [runLegs, resumeMultiLeg, submitted],
  );

  /**
   * Read after mount, not during render: localStorage does not exist during SSR, and
   * defaulting to 1.3 on the server while the stored floor is 1.4 is a hydration mismatch.
   */
  const [guardianFloor, setGuardianFloor] = useState(1.3);
  useEffect(() => setGuardianFloor(readGuardianFloor()), []);

  const sim = response?.preview?.simulation ?? null;
  const reasons = response?.preview?.risk?.reasons ?? [];
  const decision = response?.preview?.risk?.decision;
  const action = response?.preview?.action;
  const followUp = response?.intent?.template_id ? FOLLOW_UP[response.intent.template_id] : undefined;
  /** Same conditions the auto-submit effect uses, so the notice can't disagree with it. */
  // Multi-leg atomic legs set multi_leg:false — still auto-submit when session signing is on.
  const willAutoSubmit =
    response?.kind === "needs_wallet_sign" &&
    sessionSigning &&
    decision !== "block";
  const txHash = response?.execution?.tx_hash ?? null;

  return (
    <div className="cp-root mx-auto max-w-[1344px] px-5 pt-9 pb-24 sm:px-8 lg:px-12">
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-1.5">
          <Eyebrow as="p">
            <span className="text-violet-500">agent-native</span> · orchestrator
          </Eyebrow>
          <h1 className="text-h5 font-semibold text-vgray-900">
            Vanna <span className="bg-gradient bg-clip-text text-transparent">Copilot</span>
          </h1>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-2 rounded-full border border-vgray-100 bg-surface px-3.5 py-[7px] font-mono text-[11px] text-vgray-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${brainOnline ? "animate-pulse" : ""}`}
              style={{ background: brainOnline ? EMERALD : IMPERIAL }}
            />
            {health
              ? `${health.llm_provider} · mcp ${health.mcp_mode} · ${health.templates} tools`
              : brainOnline
                ? "online"
                : "brain offline"}
          </div>
          {sessionSigning && (
            <div className="flex items-center gap-[7px] rounded-full border border-violet-100 bg-violet-50 px-3.5 py-[7px] font-mono text-[11px] font-semibold text-violet-500">
              <ShieldCheck size={13} /> auto-approve on
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_372px]">
        {/* ── Main column ─────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-5">
          <div className="rounded-3xl border border-vgray-100 bg-surface p-6 shadow-vanna sm:p-9">
            <Eyebrow n="01">State intent</Eyebrow>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(intentText);
              }}
              className="mt-3"
            >
              <div className="flex items-center gap-3 border-b-2 border-vgray-100 pb-3 transition-colors focus-within:border-violet-500">
                <ChevronRight size={22} className="shrink-0 text-violet-500" />
                <input
                  ref={inputRef}
                  value={intentText}
                  onChange={(e) => setIntentText(e.target.value)}
                  placeholder="Ask, or state an action — “deposit 5 XLM as collateral”…"
                  className="min-w-0 flex-1 bg-transparent text-h7 text-vgray-900 placeholder:text-vgray-300 focus:outline-none"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setPaletteOpen((o) => !o)}
                  className={`hidden shrink-0 items-center gap-1.5 px-3 py-2 text-[12px] sm:flex ${BTN_QUIET}`}
                >
                  <LayoutTemplate size={12} /> Prompts
                </button>
                <button
                  type={loading ? "button" : "submit"}
                  disabled={!loading && !intentText.trim()}
                  onClick={loading ? (e) => { e.preventDefault(); cancelInFlight(); } : undefined}
                  className={
                    loading
                      ? `shrink-0 px-[22px] py-2.5 ${BTN_QUIET}`
                      : `shrink-0 px-[22px] py-2.5 ${BTN_GRADIENT}`
                  }
                >
                  {loading ? "Cancel" : "Run"}
                </button>
              </div>
            </form>

            {paletteOpen && (
              <div className="mt-4 max-h-72 overflow-y-auto rounded-2xl border border-vgray-100 bg-vgray-50 p-4">
                <div className="mb-2.5 flex items-center justify-between">
                  <Eyebrow>what you can ask</Eyebrow>
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(false)}
                    className="text-vgray-400 transition-colors hover:text-vgray-700"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  {Object.entries(PROMPTS).map(([cat, items]) => (
                    <div key={cat} className="flex flex-col gap-1.5">
                      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-violet-500">{cat}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((q) => (
                          <button
                            key={q}
                            type="button"
                            onClick={() => run(q)}
                            className="rounded-r2 border border-vgray-100 bg-surface px-3 py-[7px] text-[12.5px] font-medium text-vgray-800 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="my-7 h-px bg-vgray-100" />

            {/* Idle — what the agent can run */}
            {phase === "idle" && (
              <div>
                <Eyebrow n="02">What the agent can run</Eyebrow>
                <div className="mt-[18px] grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {CAPABILITIES.map((c) => {
                    const color = c.tone === "read" ? EMERALD : c.tone === "multi" ? AMBER : VIOLET;
                    return (
                      <button
                        key={c.label}
                        type="button"
                        onClick={() => run(c.label)}
                        className="flex flex-col gap-2 rounded-2xl border border-vgray-100 bg-surface px-[18px] py-4 text-left transition-colors hover:border-violet-400"
                      >
                        <span
                          className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em]"
                          style={{ color }}
                        >
                          <span className="h-[5px] w-[5px] rounded-full" style={{ background: color }} />
                          {c.tag}
                        </span>
                        <span className="text-h9 font-semibold text-vgray-900">{c.label}</span>
                        <span className="font-mono text-[11px] text-vgray-400">{c.tool}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* A turn in flight or complete */}
            {phase !== "idle" && (
              <div style={{ animation: "cp-in 300ms ease-out forwards" }}>
                {submitted && <p className="mb-[18px] text-h7 leading-snug text-vgray-900">{submitted}</p>}

                {/* A multi-leg run gets the live execution card — one card that advances
                    in place, narrating each leg as it settles. The plain step list stays
                    for single-turn work, where there is no chain to narrate. */}
                {multiLeg && runLegs.length > 0 ? (
                  <RunExecutionCard
                    eyebrow="02"
                    legs={runLegs}
                    hf={liveHf}
                    floor={
                      // "keep me above 1.4" in the prompt wins over the stored default.
                      strategyMetaRef.current.min_hf != null &&
                      Number.isFinite(Number(strategyMetaRef.current.min_hf))
                        ? Number(strategyMetaRef.current.min_hf)
                        : guardianFloor
                    }
                    busy={loading}
                    signerLive={sessionSigning}
                    signerText={
                      sessionSigning
                        ? "vanna embedded signer"
                        : walletKind === "privy"
                          ? "privy wallet"
                          : "freighter wallet"
                    }
                    onCancel={loading ? cancelInFlight : undefined}
                    onSubmitAmount={submitLegAmount}
                  />
                ) : (
                  <>
                    <Eyebrow n="02">Agent run</Eyebrow>
                    <StepList steps={steps} running={loading} />
                  </>
                )}

                {/* The run card carries its own in-flight indicator; a second spinner
                    underneath read as a separate thing still loading. */}
                {loading && !(multiLeg && runLegs.length > 0) && (
                  <div className="mt-5 flex items-center gap-2 text-body-2 text-violet-500">
                    <Loader2 size={15} className="animate-spin" /> working…
                  </div>
                )}

                {/* Answer / note — also keep strategy card while a hop is in flight */}
                {(phase === "answer" || (phase === "running" && multiLeg)) && (response || multiLeg) && (
                  <div className="mt-[26px]" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Eyebrow n="03">
                        {multiLeg ? "Strategy" : isError ? "Note" : "Answer"}
                      </Eyebrow>
                      {decision && !multiLeg && <RiskChip decision={decision} />}
                    </div>
                    {multiLeg ? (
                      <>
                        {response?.answer && (
                          <div
                            className="mt-4 rounded-2xl px-5 py-4"
                            style={{
                              border: "1px solid var(--cp-g100)",
                              background: "var(--cp-surface)",
                            }}
                          >
                            <AnswerView answer={response.answer} />
                          </div>
                        )}
                        {/* No strategy card here. The plan is reviewed once in
                            "03 Approve plan"; from then on "02 Agent run" IS the live
                            step view. Repeating the same legs in a second card during and
                            after execution showed them twice with nothing left to decide. */}
                      </>
                    ) : response ? (
                      <div className="mt-3 flex gap-3">
                        {isError ? (
                          <CircleAlert size={18} className="mt-1.5 shrink-0 text-imperial-500" />
                        ) : (
                          <Sparkles size={18} className="mt-1.5 shrink-0 text-violet-500" />
                        )}
                        {/* Structured answer when the model returned data; the prose
                            paragraph remains for errors, clarifications, Hinglish and
                            anything the structured call could not produce. */}
                        {response.answer && !isError ? (
                          <div className="min-w-0 flex-1">
                            <AnswerView answer={response.answer} />
                          </div>
                        ) : (
                          <p
                            className={`whitespace-pre-wrap text-[20px] leading-[32px] ${
                              isError ? "text-imperial-600" : "text-vgray-800"
                            }`}
                          >
                            {response.message}
                          </p>
                        )}
                      </div>
                    ) : null}
                    {sim && !multiLeg && <ImpactPanel sim={sim} />}
                    {response?.data && !multiLeg && <FactsGrid data={response.data} />}

                    {/* USDC variant (or other) clarify chips */}
                    {response?.kind === "clarification" &&
                      response.clarify_options &&
                      response.clarify_options.length > 0 && (
                        <div className="mt-5 flex flex-col gap-2.5">
                          <p className="font-mono text-[10.5px] uppercase tracking-[0.15em] text-vgray-400">
                            choose usdc type
                          </p>
                          <div className="flex flex-wrap gap-2.5">
                            {response.clarify_options.map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                disabled={loading}
                                onClick={() => void pickClarifyOption(opt)}
                                title={opt.description}
                                className="rounded-r3 border border-violet-100 bg-violet-50 px-4 py-3 text-left transition-colors hover:border-violet-400 disabled:opacity-50"
                              >
                                <span className="block font-mono text-[13px] font-semibold text-violet-600">
                                  {opt.label}
                                </span>
                                {opt.description && (
                                  <span className="mt-0.5 block max-w-[220px] text-[12px] leading-snug text-vgray-500">
                                    {opt.description}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                    <div className="mt-[22px] flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        onClick={reset}
                        className={`px-[18px] py-2.5 ${BTN_QUIET}`}
                      >
                        Ask another
                      </button>
                      {followUp && (
                        <button
                          type="button"
                          onClick={() => run(followUp)}
                          className={`px-[18px] py-2.5 ${BTN_TINT}`}
                        >
                          {followUp}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Multi-leg plan awaiting approval. Nothing has executed yet — the
                    server froze these steps and will only run them if we post the same
                    plan back, fingerprint intact. */}
                {phase === "plan" && response?.plan && (
                  <PlanApprovalCard
                    plan={response.plan}
                    busy={loading}
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

                {/* Staged write — MCP built the XDR, wallet signs once */}
                {phase === "staged" && response && (
                  <div className="mt-[26px]" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {/* With auto-approve on this never waits for a click, so calling it
                          "Staged action" and showing a signature request — then submitting
                          a second later anyway — read as the copilot changing its mind. */}
                      <Eyebrow n="03">{willAutoSubmit ? "Auto-approving" : "Staged action"}</Eyebrow>
                      {decision && <RiskChip decision={decision} />}
                    </div>

                    <div className="mt-3.5 flex flex-wrap items-start justify-between gap-6">
                      <div className="max-w-[560px]">
                        <p className="whitespace-pre-wrap text-h6 font-semibold text-vgray-900">
                          {response.preview?.human_summary || response.message}
                        </p>
                        {/* Full agent note (e.g. the 2-step plan). Suppressed while
                            auto-approving: it talks about needing a signature. */}
                        {!willAutoSubmit &&
                          response.message &&
                          response.preview?.human_summary &&
                          response.message.trim() !== response.preview.human_summary.trim() && (
                            <p className="mt-2 whitespace-pre-wrap text-body-2 leading-relaxed text-vgray-600">
                              {response.message}
                            </p>
                          )}
                      </div>
                      {action?.op && (
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-[13px] text-vgray-900">{action.op}</p>
                          <p className="mt-[3px] font-mono text-[10.5px] uppercase tracking-[0.15em] text-vgray-400">
                            mcp op
                          </p>
                        </div>
                      )}
                    </div>

                    {action?.multi_leg && (
                      <p className="mt-3.5 rounded-2xl border border-vgray-100 bg-surface px-[18px] py-3 font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: AMBER }}>
                        multi-step strategy · legs are not atomic
                      </p>
                    )}

                    {sim && <ImpactPanel sim={sim} />}

                    {reasons.length > 0 && (
                      <div className="mt-4 flex flex-col gap-[7px]">
                        {reasons.map((r, i) => {
                          const bad = decision === "block";
                          const color = bad ? IMPERIAL : action?.multi_leg ? AMBER : EMERALD;
                          return (
                            <span key={i} className="flex items-start gap-2.5 text-body-2 text-vgray-500">
                              {bad || action?.multi_leg ? (
                                <CircleAlert size={14} className="mt-[3px] shrink-0" style={{ color }} />
                              ) : (
                                <ShieldCheck size={14} className="mt-[3px] shrink-0" style={{ color }} />
                              )}
                              {r}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {action?.amount != null && (
                      <div className="mt-5 flex items-baseline gap-2.5">
                        <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-vgray-400">amount</span>
                        <span className="font-mono text-h7 text-vgray-900">
                          {action.amount} {action.asset ?? ""}
                        </span>
                      </div>
                    )}

                    {response.data && <FactsGrid data={response.data} />}

                    {sessionSigning && !willAutoSubmit && (
                      <p className="mt-[18px] flex items-start gap-[7px] font-mono text-[11px]" style={{ color: AMBER }}>
                        <CircleAlert size={13} className="mt-px shrink-0" />
                        {action?.multi_leg
                          ? "auto-approve is on, but multi-leg strategies always need your click"
                          : "auto-approve is on, but the risk gate flagged this — needs your click"}
                      </p>
                    )}

                    {/* One state, not two. Auto-approve shows a progress line and no
                        button at all — offering "Approve & sign" for a second before
                        submitting on its own is the confusing part. */}
                    {willAutoSubmit ? (
                      <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
                        <div className="flex flex-1 items-center gap-2.5 rounded-r3 border border-violet-50 bg-violet-50 px-6 py-4 font-mono text-[12px] font-semibold text-violet-500">
                          <Loader2 size={15} className="animate-spin" />
                          auto-approving — signing and submitting for you, no click needed
                        </div>
                        <button
                          type="button"
                          onClick={reset}
                          className="rounded-r3 px-[18px] py-[15px] text-[14px] font-semibold text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
                        <button
                          type="button"
                          disabled={!address || signing}
                          onClick={signWithWallet}
                          className="flex-1 rounded-r3 bg-gradient px-6 py-[15px] text-[15px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                          style={{ boxShadow: "0 12px 30px -10px rgba(112,58,230,.6)" }}
                        >
                          {signing
                            ? "Signing…"
                            : !address
                              ? "Connect wallet to sign"
                              : action?.multi_leg
                                ? "Confirm all legs & sign"
                                : "Approve & sign"}
                        </button>
                        {/* Modify is re-prompting, not inline editing — the original wording
                            goes back in the composer so it can be reworded and re-run. */}
                        <button
                          type="button"
                          onClick={() => {
                            setIntentText(submitted || "");
                            setResponse(null);
                            inputRef.current?.focus();
                          }}
                          className="rounded-r3 border border-vgray-100 bg-transparent px-[22px] py-[15px] text-[14px] font-semibold text-vgray-800 transition-colors hover:border-violet-50 hover:bg-violet-50 hover:text-violet-500"
                        >
                          Modify
                        </button>
                        <button
                          type="button"
                          onClick={reset}
                          className="rounded-r3 px-[18px] py-[15px] text-[14px] font-semibold text-vgray-500 transition-colors hover:bg-violet-50 hover:text-violet-500"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
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
                    {sim && <ImpactPanel sim={sim} />}
                    <div className="rounded-r4 border border-violet-100 bg-violet-50 p-4">
                      <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-violet-600">
                        <ShieldCheck size={14} /> enable auto-sign
                      </p>
                      {!address && <p className="mb-3 text-body-2" style={{ color: AMBER }}>Connect your wallet first.</p>}
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
                          className={`px-[18px] py-2.5 ${BTN_QUIET}`}
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

                {/* Executed */}
                {phase === "done" && response && (
                  <div className="mt-[26px]" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                    <Eyebrow n="04">{multiLeg ? "Response" : "Executed"}</Eyebrow>
                    {/* Closing summary of what actually ran. Server-side when the brain
                        finishes the last leg; client-signed finals POST summarize_execution. */}
                    {/* A receipt is the last thing the user reads after money moved, so it
                        gets the emphasis of a result rather than the flat panel a read
                        answer sits in: a violet left rule marking it as the conclusion of
                        the run above, and a surface that reads as raised, not as another
                        row in the list. */}
                    {response.answer && (
                      <div
                        className="mt-4 overflow-hidden rounded-2xl"
                        style={{
                          border: "1px solid var(--cp-g100)",
                          borderLeft: "3px solid var(--cp-violet-500)",
                          background: "var(--cp-surface)",
                          padding: "18px 20px 20px",
                        }}
                      >
                        <AnswerView answer={response.answer} />
                      </div>
                    )}
                    {multiLeg ? (
                      /* Once every leg has settled the plan has served its purpose: it
                         exists to be reviewed BEFORE approving. Repeating it underneath
                         the summary showed the same four legs twice, the second time with
                         nothing left to decide. While legs remain it stays — that is the
                         progress view. */
                      /* Nothing. "02 Agent run" above already lists every leg with its
                         live status, and the summary sits directly beneath it. */
                      null
                    ) : (
                      <>
                        <div className="mt-4 flex items-center gap-4">
                          <span
                            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
                            style={{ background: "rgba(16,185,129,.15)", color: EMERALD }}
                          >
                            <Check size={26} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-h6 font-semibold text-vgray-900">
                              {response.preview?.human_summary || "Submitted on-chain"}
                            </p>
                            <p className="mt-1 text-body-2 text-vgray-500">{response.message}</p>
                          </div>
                        </div>
                        <div className="mt-[18px] grid grid-cols-1 gap-x-8 rounded-2xl border border-vgray-100 bg-vgray-50 px-5 py-4 sm:grid-cols-2">
                          <Row k="tx hash" v={truncHash(txHash)} />
                          <Row k="status" v={response.execution?.status || "submitted"} />
                          <Row k="mcp tool" v={response.mcp?.tool || "—"} />
                          <Row
                            k="signer"
                            v={
                              sessionSigning
                                ? "session key"
                                : walletKind === "privy"
                                  ? "privy"
                                  : "freighter"
                            }
                          />
                        </div>
                        {response.data && <FactsGrid data={response.data} />}
                      </>
                    )}
                    <div className="mt-[22px] flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        onClick={reset}
                        className={`px-[18px] py-2.5 ${BTN_QUIET}`}
                      >
                        New intent
                      </button>
                      {txHash && (
                        <a
                          href={txUrl(txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`flex items-center gap-1.5 px-[18px] py-2.5 ${BTN_QUIET}`}
                        >
                          View on Stellar Expert <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Session log */}
          <div className="rounded-3xl border border-vgray-100 bg-surface px-6 py-6 sm:px-7">
            <div className="flex items-center justify-between">
              <Eyebrow>Session log</Eyebrow>
              <span className="font-mono text-[11px] text-vgray-400">
                {log.length} {log.length === 1 ? "turn" : "turns"}
              </span>
            </div>
            {log.length === 0 ? (
              <p className="mt-3 font-mono text-[11px] text-vgray-400">
                nothing yet — every intent, tool call and signature this session lands here.
              </p>
            ) : (
              <div className="mt-2">
                {log.map((e) => (
                  <div key={e.id} className="border-b border-vgray-100 py-3 last:border-0">
                    <div className="flex items-center gap-3.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.color }} />
                      <span className="min-w-0 flex-1 truncate text-body-2 text-vgray-700" title={e.prompt}>
                        {e.prompt}
                      </span>
                      <span className="hidden shrink-0 font-mono text-[11px] text-vgray-400 sm:block">
                        {e.strategy ? "strategy" : e.tool}
                      </span>
                      <span
                        className="w-[74px] shrink-0 text-right font-mono text-[11px]"
                        style={{ color: e.color }}
                      >
                        {e.status}
                      </span>
                    </div>
                    {e.strategy && e.legs && e.legs.length > 0 && (
                      <ul className="mt-2 ml-5 space-y-1 border-l border-vgray-100 pl-3">
                        {e.legs.map((leg, j) => (
                          <li
                            key={`${e.id}-leg-${j}`}
                            className="flex items-center gap-2 font-mono text-[11px] text-vgray-500"
                          >
                            <span className="text-vgray-400">{j + 1}.</span>
                            <span className="min-w-0 flex-1 truncate text-vgray-600">{leg.label}</span>
                            <span className="shrink-0 text-vgray-400">{leg.status}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right rail ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-5">
          {/* Account — the dial replaces the flat ratio + linear bar. A number cannot show
              proximity: 1.35 and 3.40 read alike in a table, and only one of them is close
              to being liquidated. The tile carries its own zone tint, so the rail changes
              colour when the position does. */}
          {!address ? (
            <div className="rounded-3xl border border-vgray-100 bg-surface p-6">
              <Eyebrow>Your account</Eyebrow>
              <p className="mt-3 text-body-1 text-vgray-500">
                Connect your wallet for account actions.
              </p>
            </div>
          ) : !effHasAccount ? (
            <div className="rounded-3xl border border-vgray-100 bg-surface p-6">
              <Eyebrow>Your account</Eyebrow>
              <p className="mt-3 text-body-1 text-vgray-500">
                No margin account yet — open one and the dial appears here.
              </p>
              <div className="mt-[18px] flex flex-col">
                <Row k="wallet" v={truncAddr(address)} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <HealthDial
                hf={liveHf}
                floor={guardianFloor}
                collateralUsd={collateralValue ?? null}
                debtUsd={borrowedValue ?? null}
                noDebt={(borrowedValue ?? 0) < 0.5}
              />
              <div className="rounded-3xl border border-vgray-100 bg-surface p-6">
                <div className="flex flex-col">
                  <Row k="wallet" v={truncAddr(address)} />
                  <Row k="smart acct" v={truncAddr(effSmartAccount)} />
                  <Row k="collateral" v={usd(collateralValue)} />
                  <Row k="debt" v={usd(borrowedValue)} />
                  <Row k="net value" v={usd(netValue)} />
                </div>
              </div>
            </div>
          )}

          {/* Autonomy */}
          <div className="rounded-3xl border border-vgray-100 bg-surface p-6">
            <div className="flex items-center justify-between gap-3">
              <Eyebrow>Autonomy</Eyebrow>
              <span
                className="flex items-center gap-[7px] font-mono text-[11px] font-semibold"
                style={{ color: sessionSigning ? VIOLET : "var(--color-vgray-400)" }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: sessionSigning ? VIOLET : "var(--color-vgray-400)" }}
                />
                {sessionSigning ? "auto-approve on" : "manual signing"}
              </span>
            </div>

            {/*
              The real switch, moved here from the wallet dropdown: this setting only
              affects the copilot, so it belongs on the copilot's own surface where the
              user can see its state while a write is staged — buried in the wallet menu
              it was invisible at the moment it mattered.
            */}
            <button
              type="button"
              role="switch"
              aria-checked={sessionSigning}
              disabled={!sessionSigningAvailable || loading}
              onClick={() => {
                if (!address) return;
                if (sessionSigning) {
                  // Turning off: local toggle + MCP disable.
                  setAutoApprove(address, false);
                  void enableAutoSign("disable");
                  toast.success("Auto-approve off");
                  return;
                }
                // Turning on: same as MCP — ask for default caps (from MCP) or custom.
                setSubmitted("Enable auto-approve");
                void (async () => {
                  await postCopilot(
                    {
                      message: "enable auto-sign",
                      auto_sign: { action: "start" },
                    },
                    "Enable auto-approve",
                  );
                })();
              }}
              className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-vgray-100 bg-vgray-50 p-3 text-left transition-colors enabled:hover:border-violet-400 disabled:opacity-60"
            >
              <ShieldCheck size={16} className="shrink-0" style={{ color: sessionSigning ? VIOLET : "var(--color-vgray-400)" }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-vgray-900">Auto-approve</span>
                <span className="block text-[11px] text-vgray-500">
                  {!sessionSigningAvailable
                    ? "Vanna embedded wallet only"
                    : sessionSigning
                      ? (() => {
                          try {
                            const raw = localStorage.getItem("vanna_copilot_auto_caps");
                            if (raw) {
                              const c = JSON.parse(raw) as {
                                max_per_tx_usd?: number;
                                max_per_day_usd?: number;
                              };
                              return `Caps $${c.max_per_tx_usd ?? 1000}/tx · $${c.max_per_day_usd ?? 1000}/day`;
                            }
                          } catch {
                            /* ignore */
                          }
                          return "Defaults (MCP default_cap_usd)";
                        })()
                      : "Turn on → choose MCP defaults or custom caps"}
                </span>
              </span>
              <span
                className="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200"
                style={{ background: sessionSigning ? VIOLET : "var(--color-vgray-200)" }}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
                    sessionSigning ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </span>
            </button>
            <p className="mt-3 text-body-2 text-vgray-500">
              {sessionSigning
                ? "Writes that clear the Sign Service policy execute without a signing prompt. Liquidation guardian is also on: if HF drops under your floor (default 1.3, or the last “keep HF above X” you said), copilot auto-repays a slice of debt."
                : sessionSigningAvailable
                  ? "Every write waits for an explicit Approve & sign. Turn on session signing to let cleared actions run themselves and enable HF guardian auto-repay."
                  : "Every write is signed in your wallet. Session signing (and HF guardian) is available for Vanna embedded wallets."}
            </p>
            <div className="mt-4 flex flex-col">
              <Row
                k="signing"
                v={sessionSigning ? "session key" : "wallet prompt"}
                color={sessionSigning ? VIOLET : undefined}
              />
              <Row
                k="guardian"
                v={
                  sessionSigning
                    ? (() => {
                        try {
                          const f = localStorage.getItem("vanna_copilot_guardian_min_hf");
                          return f ? `auto-repay if HF < ${f}` : "auto-repay if HF < 1.3";
                        } catch {
                          return "auto-repay if HF < 1.3";
                        }
                      })()
                    : "off (enable auto-approve)"
                }
                color={sessionSigning ? VIOLET : undefined}
              />
              <Row k="signer" v={walletKind === "privy" ? "vanna embedded" : address ? "freighter" : "—"} />
              <Row k="enforcement" v="mcp + sign service" />
              <Row k="custody" v="non-custodial" />
            </div>
          </div>

          {/* This session's writes */}
          <div className="rounded-3xl border border-vgray-100 bg-surface p-6">
            <Eyebrow>On-chain this session</Eyebrow>
            {activity.length === 0 ? (
              <p className="mt-3 font-mono text-[11px] text-vgray-400">
                no writes yet — signed transactions appear here with their hash.
              </p>
            ) : (
              <div className="mt-2">
                {activity.map((a) => (
                  <a
                    key={a.hash}
                    href={txUrl(a.hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2.5 border-b border-vgray-100 py-[11px] last:border-0"
                  >
                    <span
                      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-r2 bg-vgray-50"
                      style={{ color: EMERALD }}
                    >
                      <Check size={13} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold leading-[19px] text-vgray-800">{a.label}</p>
                      <p className="font-mono text-[10.5px] text-vgray-400">{truncHash(a.hash)}</p>
                    </div>
                    <span className="shrink-0 font-mono text-[10.5px] text-vgray-400">{relTime(a.ts)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          <p className="text-center text-body-3 text-vgray-400">
            Every action runs the same safety checks — nothing touches the chain until policy passes.
          </p>
        </div>
      </div>
    </div>
  );
}

export default CopilotWorkspace;
