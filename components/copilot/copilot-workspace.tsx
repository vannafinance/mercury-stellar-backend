"use client";

// Vanna Copilot — full-page agentic execution workspace (/copilot).
//
// Not a support chatbot: the user states an INTENT ("deposit X and run Y,
// keep HF above Z"), optionally picks a template, and the copilot shows a
// live execution TRACE (parse → validate → plan → guards → approval) plus a
// POSITION PREVIEW with the risk gate's verdict. Nothing signs without the
// user pressing Approve — and actual Freighter signing is the next milestone,
// so approval currently surfaces the unsigned tx bundle honestly instead of
// faking an execution.
//
// Data flow: POST /api/copilot (proxy → orchestrator /chat) per intent;
// GET /api/copilot once on mount for { health, templates }.
//
// Visual language: a dark "pro" terminal surface, but branded with the Vanna
// gradient (imperial #FC5457 → violet #703AE6) — gradient hairlines, section
// markers, focus rings and glows all derive from the same brand ramp used
// across the site (.bg-gradient in globals.css).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  ChevronRight,
  LayoutTemplate,
  ShieldCheck,
  X,
  CircleCheck,
  CircleAlert,
  CircleX,
  CircleDashed,
} from "lucide-react";
import { useUserStore } from "@/store/user";
import type {
  BrainHealth,
  CatalogAction,
  CatalogEntry,
  ChatResponse,
  Preview,
} from "./types";

// ---------------------------------------------------------------------------
// Trace model — synthesized client-side from the orchestrator's ChatResponse
// so the pipeline's real stages render as terminal-style steps.
// ---------------------------------------------------------------------------

type StepStatus = "ok" | "warn" | "error" | "wait";

interface TraceStep {
  fn: string;
  detail: string;
  status: StepStatus;
}

function fmtSlots(slots: Record<string, unknown>): string {
  const entries = Object.entries(slots ?? {});
  if (!entries.length) return "no slots";
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(" · ");
}

function buildTrace(data: ChatResponse): TraceStep[] {
  const steps: TraceStep[] = [];
  const intent = data.intent;

  // 1. parse_intent — always first; mirrors app/orchestrator/intent.py
  if (intent?.template_id) {
    steps.push({
      fn: "parse_intent()",
      detail: `${intent.template_id} · confidence ${Math.round((intent.confidence ?? 0) * 100)}% · ${fmtSlots(intent.slots)}`,
      status: "ok",
    });
  } else {
    steps.push({
      fn: "parse_intent()",
      detail: data.kind === "error" ? "parse failed" : "no template matched — out of scope",
      status: data.kind === "error" ? "error" : "warn",
    });
  }

  // 2. validate_slots — deterministic completeness gate
  if (data.kind === "clarification") {
    steps.push({ fn: "validate_slots()", detail: data.message, status: "warn" });
    return steps;
  }
  if (intent?.template_id) {
    steps.push({ fn: "validate_slots()", detail: "required slots complete", status: "ok" });
  }

  switch (data.kind) {
    case "answer":
      steps.push({ fn: "answer()", detail: data.message, status: "ok" });
      break;
    case "unavailable":
      steps.push({ fn: "plan()", detail: data.message, status: "warn" });
      break;
    case "blocked":
      steps.push({ fn: "check_guards()", detail: data.message, status: "error" });
      break;
    case "error":
      steps.push({ fn: "pipeline()", detail: data.message, status: "error" });
      break;
    case "preview": {
      const p = data.preview;
      if (p) {
        steps.push({
          fn: "plan()",
          detail: p.tool_calls.map((t) => t.tool).join(" → ") || "no tool calls",
          status: "ok",
        });
        const risk = p.risk;
        steps.push({
          fn: "check_guards()",
          detail:
            risk.decision === "allow"
              ? `policy ok${risk.projected_health_factor != null ? ` · projected HF ${risk.projected_health_factor}` : ""}`
              : risk.reasons.join(" · ") || risk.decision,
          status: risk.decision === "allow" ? "ok" : risk.decision === "block" ? "error" : "warn",
        });
        if (risk.decision !== "block") {
          steps.push({
            fn: "request_approval()",
            detail: "awaiting you… nothing signs without it",
            status: "wait",
          });
        }
      }
      break;
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  StepStatus,
  { color: string; accent: string; Icon: typeof CircleCheck }
> = {
  ok: { color: "text-electric-500", accent: "bg-gradient", Icon: CircleCheck },
  warn: { color: "text-rose-300", accent: "bg-rose-400", Icon: CircleAlert },
  error: { color: "text-imperial-500", accent: "bg-imperial-500", Icon: CircleX },
  wait: { color: "text-violet-300", accent: "bg-violet-400 animate-pulse", Icon: CircleDashed },
};

// Section label with the brand-gradient tick used across the workspace.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-white/45">
      <span className="h-3 w-[3px] shrink-0 rounded-full bg-gradient" />
      {children}
    </p>
  );
}

function TraceRow({ step, index }: { step: TraceStep; index: number }) {
  const meta = STATUS_META[step.status];
  return (
    <div
      className="relative rounded-xl border border-white/[0.06] bg-white/[0.03] py-3 pl-5 pr-4 opacity-0 transition-colors hover:bg-white/[0.05]"
      style={{ animation: `copilot-step-in 320ms ease-out ${index * 70}ms forwards` }}
    >
      <span className={`absolute bottom-3 left-0 top-3 w-[2.5px] rounded-full ${meta.accent}`} />
      <div className={`flex items-center gap-2 font-mono text-[13px] ${meta.color}`}>
        <ChevronRight size={13} className="shrink-0 text-white/30" />
        {step.fn}
        <meta.Icon size={13} className="ml-auto shrink-0" />
      </div>
      <p className="mt-1 break-words pl-5 font-mono text-[12.5px] leading-relaxed text-white/60">{step.detail}</p>
    </div>
  );
}

// Semicircular health-factor gauge. HF 1.0 → empty, HF ≥ 2.0 → full arc;
// 999 is the orchestrator's "no debt / ∞" sentinel.
function HealthGauge({ hf }: { hf: number | null | undefined }) {
  const isInf = hf != null && hf >= 999;
  const frac = hf == null ? 0 : isInf ? 1 : Math.max(0, Math.min(1, (hf - 1) / 1));
  const R = 54;
  const CIRC = Math.PI * R;
  const label = hf == null ? "—" : isInf ? "∞" : hf.toFixed(2);
  return (
    <div className="flex items-center gap-4">
      <svg width="128" height="74" viewBox="0 0 128 74" aria-label={`health factor ${label}`}>
        <defs>
          <linearGradient id="hf-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FC5457" />
            <stop offset="100%" stopColor="#703AE6" />
          </linearGradient>
        </defs>
        <path d="M 10 68 A 54 54 0 0 1 118 68" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
        <path
          d="M 10 68 A 54 54 0 0 1 118 68"
          fill="none"
          stroke="url(#hf-grad)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${CIRC * frac} ${CIRC}`}
          style={{
            transition: "stroke-dasharray 700ms ease",
            filter: frac > 0 ? "drop-shadow(0 0 5px rgba(112,58,230,0.55))" : undefined,
          }}
        />
      </svg>
      <div>
        <p
          className={`font-mono text-[26px] leading-none ${
            hf == null ? "text-white/30" : "bg-gradient bg-clip-text text-transparent"
          }`}
        >
          {label}
        </p>
        <p className="mt-1 font-mono text-[10.5px] uppercase tracking-widest text-white/35">health factor</p>
      </div>
    </div>
  );
}

function tierBadge(t: CatalogAction) {
  return t.free_tier ? (
    <span className="rounded bg-electric-500/15 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-electric-500">free</span>
  ) : (
    <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-violet-300">paid</span>
  );
}

// Fill an intent phrase's {placeholders} with sensible samples so a clicked
// template lands in the input as a runnable sentence the user can tweak.
const SAMPLE: Record<string, string> = {
  asset: "USDC",
  token_a: "XLM",
  token_b: "USDC",
  dex: "Aquarius",
  leverage: "3",
  threshold: "5",
  value: "1.4",
  profit: "10",
  loss: "5",
  cadence: "weekly",
};
function fillPhrase(phrase: string): string {
  return phrase.replace(/\{(\w+)\}/g, (_, name: string) => SAMPLE[name] ?? name.toUpperCase());
}

// ---------------------------------------------------------------------------
// Main workspace
// ---------------------------------------------------------------------------

export function CopilotWorkspace() {
  const address = useUserStore((s) => s.address);

  const [intentText, setIntentText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [approved, setApproved] = useState(false);

  const [health, setHealth] = useState<BrainHealth | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Mount: fetch brain health + template catalog (single proxy round-trip).
  useEffect(() => {
    let alive = true;
    fetch("/api/copilot")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setHealth(d.health ?? null);
        setCatalog(Array.isArray(d.templates) ? d.templates : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Keyboard: "/" focuses the intent bar (unless already typing), Esc closes palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const actions = useMemo(
    () => catalog.filter((c): c is CatalogAction => c.type === "action"),
    [catalog],
  );
  const actionsByCategory = useMemo(() => {
    const groups: Record<string, CatalogAction[]> = {};
    for (const a of actions) (groups[a.category] ??= []).push(a);
    return groups;
  }, [actions]);

  const trace = useMemo(() => (response ? buildTrace(response) : []), [response]);
  const preview: Preview | null = response?.kind === "preview" ? (response.preview ?? null) : null;
  const canApprove = !!preview && preview.risk.decision !== "block" && !approved;

  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;
      setSubmitted(trimmed);
      setLoading(true);
      setResponse(null);
      setApproved(false);
      setPaletteOpen(false);
      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: address ?? "guest", message: trimmed, tier: "free" }),
        });
        setResponse((await res.json()) as ChatResponse);
      } catch {
        setResponse({ kind: "error", message: "Copilot is unreachable. Is the orchestrator running?" });
      } finally {
        setLoading(false);
      }
    },
    [address, loading],
  );

  const brainOnline = health?.status === "ok";

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-8">
      <style>{`@keyframes copilot-step-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }`}</style>

      {/* Page header — sits on the app theme, ties the workspace to the site */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h1 className="text-h7 font-semibold text-vgray-900">
            Vanna <span className="bg-gradient bg-clip-text text-transparent">Copilot</span>
          </h1>
          <p className="mt-0.5 text-body-3 text-vgray-500">
            State an intent — the copilot plans it, the risk gate bounds it, you approve it.
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-vgray-100 px-3 py-1.5 font-mono text-[10.5px] text-vgray-500">
          <span className={`h-1.5 w-1.5 rounded-full ${brainOnline ? "bg-electric-500" : "bg-imperial-500"}`} />
          {brainOnline ? `${health!.llm_provider} · ${health!.mcp_mode}` : "brain offline"}
        </span>
      </div>

      {/* Workspace shell — dark terminal surface with a brand-gradient border */}
      <div
        className="rounded-[26px] p-[1.5px] shadow-vanna"
        style={{ backgroundImage: "linear-gradient(135deg, rgba(252,84,87,0.5) 0%, rgba(112,58,230,0.55) 60%, rgba(112,58,230,0.25) 100%)" }}
      >
        <div className="relative overflow-hidden rounded-[25px] bg-[#0b0b11]">
          {/* Ambient brand glows */}
          <div className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full bg-violet-500/[0.14] blur-3xl" />
          <div className="pointer-events-none absolute -bottom-32 -left-28 h-80 w-80 rounded-full bg-rose-500/[0.09] blur-3xl" />

          {/* Chrome bar */}
          <div className="relative flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="flex gap-1.5">
                <i className="h-2.5 w-2.5 rounded-full bg-imperial-500" />
                <i className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                <i className="h-2.5 w-2.5 rounded-full bg-violet-500" />
              </span>
              <span className="font-mono text-[11.5px] text-white/40">app.vanna.finance / copilot</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[10.5px] text-white/40">
              <span className={`h-1.5 w-1.5 rounded-full ${brainOnline ? "bg-electric-500" : "bg-imperial-500"}`} />
              {brainOnline ? "guardian on · non-custodial" : "brain offline"}
            </div>
          </div>
          {/* Gradient hairline under the chrome bar */}
          <div className="h-px bg-gradient opacity-40" />

          <div className="relative px-5 pb-6 pt-5 sm:px-7">
            {/* Intent */}
            <p className="font-mono text-[10.5px] uppercase tracking-[0.2em]">
              <span className="bg-gradient bg-clip-text text-transparent">your intent</span>
            </p>
            {/* Gradient focus ring via the padded-wrapper trick */}
            <div className="mt-2 rounded-2xl bg-white/10 p-[1.5px] transition-all duration-300 focus-within:bg-gradient focus-within:shadow-[0_6px_28px_-10px_rgba(112,58,230,0.6)]">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(intentText);
                }}
                className="flex items-center gap-3 rounded-[14.5px] bg-[#111118] px-4 py-3.5"
              >
                <ChevronRight size={15} className="shrink-0 text-violet-400" />
                <input
                  ref={inputRef}
                  value={intentText}
                  onChange={(e) => setIntentText(e.target.value)}
                  placeholder='Try: "Open a lending position in Vanna for USDC"  ( / to focus )'
                  className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-white/90 placeholder:text-white/25 focus:outline-none"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setPaletteOpen((o) => !o)}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] transition-colors ${
                    paletteOpen
                      ? "border-violet-500/60 bg-violet-500/15 text-violet-300"
                      : "border-white/10 text-white/50 hover:border-violet-500/40 hover:text-violet-300"
                  }`}
                >
                  <LayoutTemplate size={12} />
                  templates
                </button>
                <button
                  type="submit"
                  disabled={loading || !intentText.trim()}
                  className="rounded-lg bg-gradient px-4 py-1.5 font-mono text-[11px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(252,84,87,0.5)] transition-all hover:opacity-90 disabled:opacity-35 disabled:shadow-none"
                >
                  run
                </button>
              </form>
            </div>

            {/* Policy bounds — mirrors the orchestrator's deterministic risk gate defaults */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
              <span className="mr-1 text-white/30">policy bounds:</span>
              <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-300">max 10x</span>
              <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-300">min HF 1.30</span>
              <span className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">approval required</span>
              <span className="rounded-md border border-electric-500/30 bg-electric-500/10 px-2 py-0.5 text-electric-500">non-custodial</span>
            </div>

            {/* Template palette */}
            {paletteOpen && (
              <div className="mt-4 max-h-72 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <SectionLabel>{actions.length} action templates</SectionLabel>
                  <button type="button" onClick={() => setPaletteOpen(false)} className="text-white/40 hover:text-white/80">
                    <X size={14} />
                  </button>
                </div>
                {Object.entries(actionsByCategory).map(([cat, items]) => (
                  <div key={cat} className="mb-3">
                    <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-violet-400/80">
                      {cat.replace(/_/g, " ")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          disabled={!t.available}
                          title={t.available ? t.title : `${t.title} — tools not live on MCP yet`}
                          onClick={() => {
                            setIntentText(fillPhrase(t.intent_phrase));
                            inputRef.current?.focus();
                          }}
                          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-white/70 transition-colors hover:border-violet-500/50 hover:bg-violet-500/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          {t.id}
                          {tierBadge(t)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {!actions.length && (
                  <p className="font-mono text-[12px] text-white/40">
                    {brainOnline ? "no templates" : "brain offline — start the orchestrator to load templates"}
                  </p>
                )}
              </div>
            )}

            {/* Submitted intent echo */}
            {submitted && (
              <div className="mt-5 break-words rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 font-mono text-[12.5px] text-white/50">
                <span className="bg-gradient bg-clip-text text-transparent">&gt;</span> {submitted}
              </div>
            )}

            {/* Main grid */}
            <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_330px]">
              {/* Trace */}
              <section className="min-h-[280px] rounded-2xl border border-white/[0.07] bg-black/25 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <SectionLabel>copilot trace</SectionLabel>
                  {loading && (
                    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-violet-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
                      planning…
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {trace.map((s, i) => (
                    <TraceRow key={`${submitted}-${i}`} step={s} index={i} />
                  ))}
                  {approved && preview && (
                    <>
                      <TraceRow
                        step={{
                          fn: "request_approval()",
                          detail: `approved by you · ${preview.unsigned_xdrs.length} unsigned tx in bundle`,
                          status: "ok",
                        }}
                        index={0}
                      />
                      <TraceRow
                        step={{
                          fn: "execute()",
                          detail: "Freighter signing is the next integration milestone — nothing was submitted on-chain",
                          status: "wait",
                        }}
                        index={1}
                      />
                    </>
                  )}
                  {!trace.length && !loading && (
                    <p className="px-1 pt-6 text-center font-mono text-[12px] text-white/25">
                      state an intent above — the pipeline trace will stream here
                    </p>
                  )}
                </div>
              </section>

              {/* Position preview */}
              <aside className="rounded-2xl border border-white/[0.07] bg-black/25 p-4">
                <SectionLabel>position preview</SectionLabel>

                {/* Strategy box */}
                <div className="relative mt-3 rounded-xl border border-white/[0.07] bg-white/[0.03] py-3 pl-4 pr-3.5 font-mono text-[12px]">
                  <span className="absolute bottom-3 left-0 top-3 w-[2.5px] rounded-full bg-gradient" />
                  {preview ? (
                    <>
                      <p>
                        <span className="text-white/35">strategy </span>
                        <span className="bg-gradient bg-clip-text font-semibold text-transparent">{preview.template_id}</span>
                      </p>
                      <p className="mt-1 text-white/55">{fmtSlots(preview.slots)}</p>
                    </>
                  ) : (
                    <p className="text-white/30">{loading ? "parsing intent…" : "parsed intent → awaiting…"}</p>
                  )}
                </div>

                <div className="mt-4">
                  <HealthGauge hf={preview?.risk.projected_health_factor} />
                </div>

                {/* Guards & policy */}
                <div className="mt-5">
                  <SectionLabel>guards &amp; policy</SectionLabel>
                </div>
                <div className="mt-2 space-y-1.5 font-mono text-[11.5px]">
                  {preview ? (
                    <>
                      {preview.risk.reasons.length ? (
                        preview.risk.reasons.map((r, i) => (
                          <div key={i} className="flex items-start gap-2">
                            {preview.risk.decision === "block" ? (
                              <CircleX size={13} className="mt-0.5 shrink-0 text-imperial-500" />
                            ) : (
                              <CircleAlert size={13} className="mt-0.5 shrink-0 text-rose-300" />
                            )}
                            <span className="text-white/55">{r}</span>
                          </div>
                        ))
                      ) : (
                        <div className="flex items-center gap-2">
                          <CircleCheck size={13} className="shrink-0 text-electric-500" />
                          <span className="text-white/55">within your policy · risk gate passed</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <ShieldCheck size={13} className="shrink-0 text-electric-500" />
                        <span className="text-white/55">approval required — nothing signs without you</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-white/25">guards run once a plan exists</p>
                  )}
                </div>

                {/* Approve */}
                <button
                  type="button"
                  disabled={!canApprove}
                  onClick={() => setApproved(true)}
                  className={`mt-5 w-full rounded-xl px-4 py-3 font-mono text-[12.5px] font-semibold transition-all ${
                    approved
                      ? "cursor-default bg-electric-500/15 text-electric-500"
                      : canApprove
                        ? "bg-gradient text-white shadow-[0_10px_30px_-8px_rgba(112,58,230,0.65)] hover:opacity-90"
                        : "cursor-not-allowed bg-white/[0.05] text-white/30"
                  }`}
                >
                  {approved ? "✓ Approved · awaiting signer" : "Approve & execute"}
                </button>

                {approved && preview && (
                  <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-2.5 font-mono text-[11px] text-white/45">
                    bundle: {preview.tool_calls.length} tool call{preview.tool_calls.length === 1 ? "" : "s"} ·{" "}
                    {preview.unsigned_xdrs.length} unsigned XDR · Soroban
                    <br />
                    <span className="text-violet-300">freighter signing lands next — position not yet live</span>
                  </div>
                )}
              </aside>
            </div>

            {/* Footer note */}
            <p className="mt-5 text-center font-mono text-[10.5px] text-white/25">
              every agentic action is bounded by the same deterministic risk gate — the LLM only fills slots, never invents steps
            </p>
          </div>
        </div>
      </div>

      {/* Non-blocking hint when wallet is disconnected */}
      {!address && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-body-3 text-vgray-500">
          <Sparkles size={12} />
          connect your wallet to scope intents to your account — browsing works without it
        </p>
      )}
    </div>
  );
}

export default CopilotWorkspace;
