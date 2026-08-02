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
// light/dark toggle with no per-page theme state. The only colours the app's
// tokens don't invert are the violet-tinted panels, handled by the scoped
// `--cp-*` vars below.

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
    | "needs_wallet_sign";
  message: string;
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
function hfLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "no debt";
  if (v >= 1.5) return "healthy";
  if (v >= 1.3) return "caution";
  return "at risk";
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

function Eyebrow({ n, children }: { n?: string; children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-vgray-400">
      {n ? (
        <>
          <span className="text-violet-500">{n}</span> ·{" "}
        </>
      ) : null}
      {children}
    </p>
  );
}

/** Mono key → value row; the repeating unit of every panel in the right rail. */
function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-vgray-100 py-2 last:border-0">
      <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">{k}</span>
      <span className="font-mono text-[13px] text-vgray-900" style={color ? { color } : undefined}>
        {v}
      </span>
    </div>
  );
}

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

type MultiLegStepUi = {
  index?: number;
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
  headline,
  onResume,
  resumeBusy,
}: {
  data: Record<string, unknown>;
  headline?: string | null;
  onResume?: (legs: ResumeLeg[], summary: string) => void;
  resumeBusy?: boolean;
}) {
  const steps = (Array.isArray(data.multi_leg_steps) ? data.multi_leg_steps : []) as MultiLegStepUi[];
  if (!steps.length) return null;

  const summary = String(data.strategy_summary || data.plan_summary || "Strategy");
  const minHf = data.min_hf != null ? Number(data.min_hf) : null;
  const finalHf = data.final_hf != null ? Number(data.final_hf) : null;
  const sa = data.smart_account != null ? String(data.smart_account) : null;
  const title = String(data.headline || headline || "Strategy progress");
  const resumeLegs = (Array.isArray(data.resume_legs) ? data.resume_legs : []) as ResumeLeg[];
  const canResume = data.can_resume === true && resumeLegs.length > 0 && !!onResume;

  const anyFail = steps.some((s) =>
    ["error", "blocked", "stopped_hf"].includes(String(s.status || "")),
  );
  const allOk = steps.every((s) => s.status === "ok");

  const tone = (status?: string) => {
    if (status === "ok") return EMERALD;
    if (status === "needs_sign" || status === "pending" || status === "clarification") return AMBER;
    if (status === "error" || status === "blocked" || status === "stopped_hf") return IMPERIAL;
    return "var(--color-vgray-400)";
  };
  const mark = (status?: string) => {
    if (status === "ok") return "Done";
    if (status === "needs_sign") return "Sign";
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
          const showDetail =
            s.message &&
            st !== "ok" &&
            st !== "pending" &&
            st !== "skipped";
          return (
            <li key={i} className="flex gap-3 px-3 py-3.5">
              <span
                className="mt-0.5 flex h-6 min-w-[3.25rem] shrink-0 items-center justify-center rounded-full px-2 font-mono text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: tone(st), background: `${tone(st)}18` }}
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
        <p className="text-[12px] leading-relaxed text-vgray-500">
          {allOk
            ? "All steps completed on-chain."
            : anyFail
              ? "Stopped early. Only steps marked Done are on-chain — nothing later was claimed as done."
              : "In progress or waiting on the next action."}
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
              className="rounded-full bg-gradient px-4 py-2 text-btn-sm font-semibold text-white disabled:opacity-40"
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
  const [log, setLog] = useState<LogEntry[]>([]);
  /** Parent strategy prompt for client next_step hops (session log grouping). */
  const strategyParentRef = useRef<{ id: string; prompt: string } | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

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
        const id = data.request_id || `strat-${Date.now()}`;
        const parentPrompt =
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
          const without = prev.filter((e) => e.id !== id);
          return [
            {
              id,
              prompt: parentPrompt,
              tool: "multi_leg",
              status: overall,
              color: overall === "executed" ? EMERALD : color,
              strategy: true,
              legs,
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
          const hopKey = hopLabel.toLowerCase();
          const legIdx = legs.findIndex((l) => {
            const ll = l.label.toLowerCase();
            return (
              ll === hopKey ||
              l.tool === tool ||
              hopKey.includes(l.tool.replace(/_/g, " ")) ||
              ll.includes(tool.replace(/^vanna_/, "").replace(/_/g, " "))
            );
          });
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
      setLoading(true);
      setResponse(null);
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
        });
        const data = (await res.json()) as ChatResponse;
        // Strip markdown stars so the UI never shows **BLUSDC**
        if (data.message) data.message = stripMarkdownLite(data.message);
        if (data.preview?.human_summary) {
          data.preview.human_summary = stripMarkdownLite(data.preview.human_summary);
        }
        setResponse(data);
        // Agent-chain hops (pending_write / explicit chain) fold into the parent log row.
        // Full multi_leg payloads create/refresh the parent strategy row.
        pushLog(promptLabel, data, {
          chainHop: !!(opts?.chainHop || body.pending_write || body.resume_multi_leg),
          hopLabel: promptLabel,
        });
        if (data.kind === "executed") {
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
      } catch {
        const failed: ChatResponse = { kind: "error", message: "Copilot request failed." };
        setResponse(failed);
        pushLog(promptLabel, failed);
        return failed;
      } finally {
        setLoading(false);
      }
    },
    [address, smartAccount, pushLog, pushActivity, refreshRailStats],
  );

  const run = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || loading) return;
      setSubmitted(t);
      setIntentText(t);
      setPaletteOpen(false);
      await postCopilot({ message: t }, t);
    },
    [loading, postCopilot],
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
        const remainingFromData = Array.isArray((response?.data as any)?.remaining_legs)
          ? ((response!.data as any).remaining_legs as Array<{
              op: string;
              asset?: string | null;
              amount?: number | null;
              leverage?: number | null;
              label?: string;
            }>)
          : null;
        const preferResume =
          (response?.data as any)?.prefer_resume_multi_leg === true ||
          (remainingFromData && remainingFromData.length > 0);

        if (preferResume && remainingFromData && remainingFromData.length > 0) {
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
              remaining_legs: null,
              prefer_resume_multi_leg: false,
            },
          });
          await new Promise((r) => setTimeout(r, 2200));
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
            data: response?.data ?? null,
          });
          await new Promise((r) => setTimeout(r, 2200));
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

        setResponse({
          kind: "executed",
          message: `Submitted with your wallet${result.hash ? ` · ${result.hash}` : ""}.`,
          mcp: response?.mcp ?? null,
          preview: response?.preview ?? null,
          execution: { status: "signed_and_submitted", tx_hash: result.hash ?? null },
          request_id: response?.request_id,
          data: response?.data ?? null,
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
  }, [response, address, smartAccount, submitted, pushActivity, postCopilot, refreshRailStats]);

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

    // Prefer full remaining multi-leg resume (swap→farm has 3+ legs after first)
    const remaining = Array.isArray((response.data as any)?.remaining_legs)
      ? ((response.data as any).remaining_legs as Array<{
          op: string;
          asset?: string | null;
          amount?: number | null;
          leverage?: number | null;
          label?: string;
        }>)
      : null;
    const preferResume =
      (response.data as any)?.prefer_resume_multi_leg === true ||
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
        await new Promise((r) => setTimeout(r, 2200));
        await refreshRailStats({ force: true });
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
      await new Promise((r) => setTimeout(r, 2200));
      await refreshRailStats({ force: true });
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
  }, [response, loading, signing, postCopilot, refreshRailStats, submitted]);

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

    const readFloor = (): number => {
      try {
        const raw = localStorage.getItem("vanna_copilot_guardian_min_hf");
        const n = raw != null ? Number(raw) : NaN;
        return Number.isFinite(n) && n >= 1 ? n : 1.3;
      } catch {
        return 1.3;
      }
    };

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
        const amt = Number(
          (row as { amount?: number; balance?: number; amount_human?: string })?.amount ??
            (row as { balance?: number })?.balance ??
            (row as { amount_human?: string })?.amount_human ??
            0,
        );
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

  const reset = () => {
    setSubmitted(null);
    setResponse(null);
    setIntentText("");
    setShowCustom(false);
    autoSubmittedRef.current = null;
    nextStepFiredRef.current = null;
    strategyParentRef.current = null;
    inputRef.current?.focus();
  };

  const brainOnline = health?.status === "ok";
  const multiLeg = isMultiLegResponse(response?.data ?? null);
  // Multi-leg uses a structured card — don't paint the whole turn imperial red.
  const isError =
    !multiLeg && (response?.kind === "error" || response?.kind === "blocked");
  const phase = loading
    ? "running"
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
        { label: "MCP tool call", detail: "pending", state: "pending" },
        { label: "Composing response", detail: "pending", state: "pending" },
      ];
    }
    if (!response) return [];
    const template = response.intent?.template_id || response.preview?.template_id || "—";
    const tool = response.mcp?.tool || "—";
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
  }, [loading, response]);

  const sim = response?.preview?.simulation ?? null;
  const reasons = response?.preview?.risk?.reasons ?? [];
  const decision = response?.preview?.risk?.decision;
  const action = response?.preview?.action;
  const followUp = response?.intent?.template_id ? FOLLOW_UP[response.intent.template_id] : undefined;
  /** Same conditions the auto-submit effect uses, so the notice can't disagree with it. */
  const willAutoSubmit =
    response?.kind === "needs_wallet_sign" &&
    sessionSigning &&
    !action?.multi_leg &&
    decision !== "block";
  const txHash = response?.execution?.tx_hash ?? null;

  return (
    <div className="cp-root mx-auto max-w-[1344px] px-5 pt-9 pb-24 sm:px-8 lg:px-12">
      <style>{`
        .cp-root{--cp-violet-soft:#f1ebfd;--cp-violet-soft-border:#d3c2f7;}
        html.dark .cp-root{--cp-violet-soft:#2a1a3e;--cp-violet-soft-border:#3b2560;}
        @keyframes cp-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        @keyframes cp-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
      `}</style>

      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-1.5">
          <Eyebrow>
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
            <div
              className="flex items-center gap-[7px] rounded-full px-3.5 py-[7px] font-mono text-[11px] font-semibold text-violet-500"
              style={{ background: "var(--cp-violet-soft)", border: "1px solid var(--cp-violet-soft-border)" }}
            >
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
                  className="hidden shrink-0 items-center gap-1.5 rounded-full border border-vgray-200 px-3 py-1.5 font-mono text-[11px] text-vgray-500 transition-colors hover:border-violet-400 hover:text-violet-600 sm:flex"
                >
                  <LayoutTemplate size={12} /> prompts
                </button>
                <button
                  type="submit"
                  disabled={loading || !intentText.trim()}
                  className="shrink-0 rounded-full bg-gradient px-5 py-2 text-btn-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-30"
                >
                  {loading ? "…" : "Run"}
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
                            className="rounded-full border border-vgray-200 bg-surface px-[11px] py-[5px] text-[12px] text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
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

                <Eyebrow n="02">Agent run</Eyebrow>
                <StepList steps={steps} running={loading} />

                {loading && (
                  <div className="mt-5 flex items-center gap-2 text-body-2 text-violet-500">
                    <Loader2 size={15} className="animate-spin" /> working…
                  </div>
                )}

                {/* Answer / note */}
                {phase === "answer" && response && (
                  <div className="mt-[26px]" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Eyebrow n="03">
                        {multiLeg ? "Strategy" : isError ? "Note" : "Answer"}
                      </Eyebrow>
                      {decision && !multiLeg && <RiskChip decision={decision} />}
                    </div>
                    {multiLeg && response.data ? (
                      <MultiLegStrategyCard
                        data={response.data}
                        headline={response.message}
                        onResume={resumeMultiLeg}
                        resumeBusy={loading}
                      />
                    ) : (
                      <div className="mt-3 flex gap-3">
                        {isError ? (
                          <CircleAlert size={18} className="mt-1.5 shrink-0 text-imperial-500" />
                        ) : (
                          <Sparkles size={18} className="mt-1.5 shrink-0 text-violet-500" />
                        )}
                        <p
                          className={`whitespace-pre-wrap text-[20px] leading-[32px] ${
                            isError ? "text-imperial-600" : "text-vgray-800"
                          }`}
                        >
                          {response.message}
                        </p>
                      </div>
                    )}
                    {sim && !multiLeg && <ImpactPanel sim={sim} />}
                    {response.data && !multiLeg && <FactsGrid data={response.data} />}

                    {/* USDC variant (or other) clarify chips */}
                    {response.kind === "clarification" &&
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
                                className="rounded-2xl border border-violet-300/50 bg-[var(--cp-violet-soft)] px-4 py-3 text-left transition-colors hover:border-violet-500 disabled:opacity-50"
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
                        className="rounded-full border border-vgray-200 px-5 py-2.5 text-btn-sm font-semibold text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
                      >
                        Ask another
                      </button>
                      {followUp && (
                        <button
                          type="button"
                          onClick={() => run(followUp)}
                          className="rounded-full px-5 py-2.5 text-btn-sm font-semibold text-violet-500 transition-colors hover:border-violet-400"
                          style={{
                            background: "var(--cp-violet-soft)",
                            border: "1px solid var(--cp-violet-soft-border)",
                          }}
                        >
                          {followUp}
                        </button>
                      )}
                    </div>
                  </div>
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
                      <div
                        className="mt-[22px] flex items-center gap-2.5 rounded-full px-6 py-4 font-mono text-[12px] font-semibold text-violet-500"
                        style={{ background: "var(--cp-violet-soft)", border: "1px solid var(--cp-violet-soft-border)" }}
                      >
                        <Loader2 size={15} className="animate-spin" />
                        auto-approving — signing and submitting for you, no click needed
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={!address || signing}
                        onClick={signWithWallet}
                        className="mt-[22px] w-full rounded-full bg-gradient px-6 py-4 text-btn-md font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
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
                    )}
                    <button
                      type="button"
                      onClick={reset}
                      className="mt-3.5 text-btn-sm font-semibold text-vgray-400 transition-colors hover:text-vgray-700"
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
                    {sim && <ImpactPanel sim={sim} />}
                    <div
                      className="rounded-2xl p-4"
                      style={{
                        background: "var(--cp-violet-soft)",
                        border: "1px solid var(--cp-violet-soft-border)",
                      }}
                    >
                      <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-violet-600">
                        <ShieldCheck size={14} /> enable auto-sign
                      </p>
                      {!address && <p className="mb-3 text-body-2" style={{ color: AMBER }}>Connect your wallet first.</p>}
                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        <button
                          type="button"
                          disabled={!address || loading}
                          onClick={() => enableAutoSign("use_defaults")}
                          className="rounded-full bg-gradient px-5 py-2.5 text-btn-sm font-semibold text-white disabled:opacity-40"
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
                          className="rounded-full border border-vgray-200 bg-surface px-5 py-2.5 text-btn-sm font-semibold text-vgray-700 disabled:opacity-40"
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
                            className="rounded-full bg-gradient px-5 py-2.5 text-btn-sm font-semibold text-white disabled:opacity-40 sm:col-span-2"
                          >
                            Enable custom
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={reset}
                      className="text-btn-sm font-semibold text-vgray-400 transition-colors hover:text-vgray-700"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Executed */}
                {phase === "done" && response && (
                  <div className="mt-[26px]" style={{ animation: "cp-in 300ms ease-out forwards" }}>
                    <Eyebrow n="04">{multiLeg ? "Strategy" : "Executed"}</Eyebrow>
                    {multiLeg && response.data ? (
                      <MultiLegStrategyCard
                        data={response.data}
                        headline={response.message}
                        onResume={resumeMultiLeg}
                        resumeBusy={loading}
                      />
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
                        className="rounded-full border border-vgray-200 px-5 py-2.5 text-btn-sm font-semibold text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
                      >
                        New intent
                      </button>
                      {txHash && (
                        <a
                          href={txUrl(txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 rounded-full border border-vgray-200 px-5 py-2.5 text-btn-sm font-semibold text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
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
          {/* Account */}
          <div className="rounded-3xl border border-vgray-100 bg-surface p-6">
            <Eyebrow>Your account</Eyebrow>
            {!address ? (
              <p className="mt-3 text-body-1 text-vgray-500">Connect your wallet for account actions.</p>
            ) : (
              <>
                <div className="mt-4 flex items-end justify-between gap-3">
                  <div>
                    <p
                      className="font-mono text-h5 font-bold leading-none"
                      style={{ color: effHasAccount ? hfColor(liveHf) : "var(--color-vgray-400)" }}
                    >
                      {effHasAccount ? fmtHf(liveHf) : "—"}
                    </p>
                    <p className="mt-1.5 font-mono text-[10.5px] uppercase tracking-[0.15em] text-vgray-400">
                      health factor
                    </p>
                  </div>
                  <span
                    className="rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em]"
                    style={
                      effHasAccount
                        ? {
                            color: hfColor(liveHf),
                            background:
                              liveHf == null || liveHf >= 1.5
                                ? "rgba(16,185,129,.12)"
                                : liveHf >= 1.3
                                  ? "rgba(245,158,11,.14)"
                                  : "rgba(252,84,87,.14)",
                          }
                        : { color: "var(--color-vgray-400)", background: "var(--color-vgray-50)" }
                    }
                  >
                    {effHasAccount ? hfLabel(liveHf) : "no margin account"}
                  </span>
                </div>
                <div className="relative mt-3.5 h-2 overflow-hidden rounded-full bg-vgray-100">
                  {effHasAccount && (
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
                      style={{ width: liveHf == null ? "100%" : hfPct(liveHf), background: hfColor(liveHf) }}
                    />
                  )}
                  <div className="absolute inset-y-0 left-[33.3%] w-0.5" style={{ background: IMPERIAL }} />
                  <div className="absolute inset-y-0 left-[43.3%] w-0.5" style={{ background: AMBER }} />
                </div>
                <div className="mt-[18px] flex flex-col">
                  <Row k="wallet" v={truncAddr(address)} />
                  <Row k="smart acct" v={truncAddr(effSmartAccount)} />
                  <Row k="collateral" v={usd(collateralValue)} />
                  <Row k="debt" v={usd(borrowedValue)} />
                  <Row k="net value" v={usd(netValue)} />
                </div>
              </>
            )}
          </div>

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
