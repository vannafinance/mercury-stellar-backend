"use client";

// Vanna Copilot — full-page agentic workspace (/copilot).
//
// Design: "one card morphs" (editorial, light, spotlight). A single centered
// surface changes its face by phase — ASK → THINKING → PREVIEW/ANSWER → LIVE.
// Prose uses Plus Jakarta Sans (the site font); numbers & technical labels use
// monospace (brand guideline: monospace for numeric/price data). Health-positive
// is green, caution amber, danger imperial-red, primary actions the brand gradient.
//
// Not a support chatbot: the user states an INTENT; the copilot parses it, runs
// the deterministic risk gate, previews, and executes on approval via the app's
// existing Freighter-signed services. Data: POST /api/copilot per intent;
// GET /api/copilot once for { health, templates }.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, LayoutTemplate, X, Check, Loader2, CircleAlert } from "lucide-react";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, checkUserMarginAccount } from "@/store/margin-account-info-store";
import { executeTemplate, isExecutable, type ExecuteResult } from "./execute";
import type { BrainHealth, CatalogAction, CatalogEntry, ChatResponse, Preview } from "./types";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function usd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtSlots(slots: Record<string, unknown>): string {
  const e = Object.entries(slots ?? {});
  return e.length ? e.map(([k, v]) => `${k} ${String(v)}`).join(" · ") : "";
}

const EXAMPLES = [
  "What's the price of XLM?",
  "Show me the USDC pool stats",
  "Open a lending position in Vanna for USDC",
  "What are my positions?",
];

// ---- trace (reasoning receipts) -------------------------------------------

type StepStatus = "ok" | "warn" | "error" | "wait";
interface TraceStep { fn: string; label: string; detail: string; status: StepStatus }

const FN_LABELS: Record<string, string> = {
  "parse_intent()": "Understood your request",
  "validate_slots()": "Checked the details",
  "plan()": "Planned the steps",
  "check_guards()": "Ran safety checks",
  "request_approval()": "Ready for your approval",
  "answer()": "Answered",
  "execute()": "Executing",
  "pipeline()": "Error",
};

function buildTrace(data: ChatResponse): TraceStep[] {
  const steps: TraceStep[] = [];
  const intent = data.intent;
  const push = (fn: string, detail: string, status: StepStatus) =>
    steps.push({ fn, label: FN_LABELS[fn] ?? fn, detail, status });

  if (intent?.template_id) {
    push("parse_intent()", `${intent.template_id} · conf ${(intent.confidence ?? 0).toFixed(2)}`, "ok");
  } else {
    push("parse_intent()", data.kind === "error" ? "parse failed" : "no match", data.kind === "error" ? "error" : "warn");
  }
  if (data.kind === "clarification") { push("validate_slots()", data.message, "warn"); return steps; }
  if (intent?.template_id) push("validate_slots()", "complete", "ok");

  switch (data.kind) {
    case "answer": push("answer()", "done", "ok"); break;
    case "unavailable": push("plan()", data.message, "warn"); break;
    case "blocked": push("check_guards()", data.message, "error"); break;
    case "error": push("pipeline()", data.message, "error"); break;
    case "preview": {
      const p = data.preview;
      if (p) {
        push("plan()", p.tool_calls.map((t) => t.tool).join(" → ") || "—", "ok");
        const r = p.risk;
        push("check_guards()", r.decision === "allow" ? "policy ok" : r.reasons.join(" · ") || r.decision,
          r.decision === "allow" ? "ok" : r.decision === "block" ? "error" : "warn");
        if (r.decision !== "block") push("request_approval()", "awaiting you", "wait");
      }
      break;
    }
  }
  return steps;
}

// ---- small presentational pieces ------------------------------------------

// Editorial section eyebrow, e.g. "01 · INTENT"
function Eyebrow({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-vgray-400">
      {n ? <><span className="text-violet-500">{n}</span> · </> : null}{children}
    </p>
  );
}

const STEP_DOT: Record<StepStatus, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  error: "text-imperial-500",
  wait: "text-violet-500",
};

function ReceiptRow({ step, i }: { step: TraceStep; i: number }) {
  return (
    <div
      className="flex items-start gap-3 border-b border-vgray-100 py-2.5 opacity-0 last:border-0"
      style={{ animation: `copilot-in 300ms ease-out ${i * 80}ms forwards` }}
    >
      <span className={`mt-0.5 shrink-0 ${STEP_DOT[step.status]}`}>
        {step.status === "wait" ? <Loader2 size={14} className="animate-spin" /> : step.status === "ok" ? <Check size={14} /> : <CircleAlert size={14} />}
      </span>
      <div className="min-w-0">
        <p className="text-body-2 text-vgray-800">{step.label}</p>
        <p className="mt-0.5 break-words font-mono text-[11.5px] text-vgray-400">{step.detail}</p>
      </div>
    </div>
  );
}

// Giant health-factor readout (green healthy / amber caution / red danger).
function HealthReadout({ hf }: { hf: number | null | undefined }) {
  const isInf = hf != null && hf >= 999;
  const label = hf == null ? "—" : isInf ? "∞" : hf.toFixed(2);
  const tone = hf == null ? "text-vgray-300" : isInf || hf >= 1.5 ? "text-emerald-500" : hf >= 1.3 ? "text-amber-500" : "text-imperial-500";
  const word = hf == null ? "" : isInf || hf >= 1.5 ? "HEALTHY" : hf >= 1.3 ? "CAUTION" : "AT RISK";
  return (
    <div>
      <p className={`font-mono text-[64px] font-semibold leading-none tracking-tight ${tone}`}>{label}</p>
      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.25em] text-vgray-400">
        health factor{word ? ` · ${word}` : ""}
      </p>
    </div>
  );
}

// A monospace stat cell (number over label).
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="font-mono text-[15px] text-vgray-900">{value}</p>
      <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-widest text-vgray-400">{label}</p>
    </div>
  );
}

const SAMPLE: Record<string, string> = { asset: "USDC", token_a: "XLM", token_b: "USDC", dex: "Aquarius", leverage: "3", threshold: "5", value: "1.4", profit: "10", loss: "5", cadence: "weekly" };
const fillPhrase = (p: string) => p.replace(/\{(\w+)\}/g, (_, n: string) => SAMPLE[n] ?? n.toUpperCase());

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function CopilotWorkspace() {
  const address = useUserStore((s) => s.address);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const healthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  const collateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const borrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);

  const [intentText, setIntentText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [amount, setAmount] = useState("");
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null);

  const [health, setHealth] = useState<BrainHealth | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/copilot").then((r) => r.json()).then((d) => {
      if (!alive) return;
      setHealth(d.health ?? null);
      setCatalog(Array.isArray(d.templates) ? d.templates : []);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) { e.preventDefault(); inputRef.current?.focus(); }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const actions = useMemo(() => catalog.filter((c): c is CatalogAction => c.type === "action"), [catalog]);
  const actionsByCategory = useMemo(() => {
    const g: Record<string, CatalogAction[]> = {};
    for (const a of actions) (g[a.category] ??= []).push(a);
    return g;
  }, [actions]);

  const trace = useMemo(() => (response ? buildTrace(response) : []), [response]);
  const preview: Preview | null = response?.kind === "preview" ? (response.preview ?? null) : null;
  const templateId = preview?.template_id ?? response?.intent?.template_id ?? null;
  const isWrite = isExecutable(templateId);
  const amountNum = parseFloat(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const canExecute = !!preview && preview.risk.decision !== "block" && !executing && !execResult?.ok && (!isWrite || amountValid);
  const brainOnline = health?.status === "ok";

  const run = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || loading) return;
    setSubmitted(t); setIntentText(t); setLoading(true); setResponse(null);
    setAmount(""); setExecResult(null); setPaletteOpen(false);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: address ?? "guest", message: t, tier: "paid", smart_account: smartAccount ?? null }),
      });
      setResponse((await res.json()) as ChatResponse);
    } catch {
      setResponse({ kind: "error", message: "Copilot is unreachable. Is the orchestrator running?" });
    } finally { setLoading(false); }
  }, [address, loading, smartAccount]);

  const handleExecute = useCallback(async () => {
    if (!preview || !templateId) return;
    setExecuting(true); setExecResult(null);
    try {
      const result = await executeTemplate({
        templateId, slots: preview.slots, amount: amountValid ? amountNum : 0,
        walletAddress: address, smartAccount,
      });
      setExecResult(result);
      if (result.ok) {
        toast.success(`Executed — ${templateId}${result.hash ? ` · ${result.hash.slice(0, 8)}…` : ""}`);
        if (address) checkUserMarginAccount(address).catch(() => {});
      } else if (result.note) toast(result.note, { icon: "ℹ️" });
      else toast.error(result.error || "Execution failed");
    } catch (e) {
      setExecResult({ ok: false, error: e instanceof Error ? e.message : "Execution failed" });
    } finally { setExecuting(false); }
  }, [preview, templateId, amountValid, amountNum, address, smartAccount]);

  const reset = () => { setSubmitted(null); setResponse(null); setAmount(""); setExecResult(null); setIntentText(""); inputRef.current?.focus(); };

  // phase for the morphing content area
  const phase: "idle" | "thinking" | "answer" | "preview" | "message" | "live" =
    execResult?.ok ? "live"
    : loading ? "thinking"
    : preview ? "preview"
    : response?.kind === "answer" ? "answer"
    : response ? "message"
    : "idle";

  return (
    <div className="mx-auto max-w-[820px] px-5 pb-24 pt-10">
      <style>{`@keyframes copilot-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>

      {/* header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-h5 font-semibold text-vgray-900">
            Vanna <span className="bg-gradient bg-clip-text text-transparent">Copilot</span>
          </h1>
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-vgray-400">copilot</span>
        </div>
        <span className="flex items-center gap-2 font-mono text-[11px] text-vgray-400">
          <span className={`h-1.5 w-1.5 rounded-full ${brainOnline ? "bg-emerald-500" : "bg-imperial-500"}`} />
          {brainOnline ? `${health!.llm_provider} · ${health!.mcp_mode}` : "offline"}
        </span>
      </div>

      {/* ── the morphing card ─────────────────────────────────────────── */}
      <div className="rounded-3xl border border-vgray-100 bg-surface p-6 shadow-vanna sm:p-9">
        {/* 01 · ASK — the command line is always here */}
        <Eyebrow n="01">Ask</Eyebrow>
        <form onSubmit={(e) => { e.preventDefault(); run(intentText); }} className="mt-3">
          <div className="flex items-center gap-3 border-b-2 border-vgray-100 pb-3 transition-colors focus-within:border-violet-500">
            <ChevronRight size={22} className="shrink-0 text-violet-500" />
            <input
              ref={inputRef}
              value={intentText}
              onChange={(e) => setIntentText(e.target.value)}
              placeholder="Open a conservative lending position in USDC…"
              className="min-w-0 flex-1 bg-transparent text-h7 text-vgray-900 placeholder:text-vgray-300 focus:outline-none"
              spellCheck={false}
            />
            <button type="button" onClick={() => setPaletteOpen((o) => !o)}
              className="hidden shrink-0 items-center gap-1.5 rounded-full border border-vgray-200 px-3 py-1.5 font-mono text-[11px] text-vgray-500 transition-colors hover:border-violet-400 hover:text-violet-600 sm:flex">
              <LayoutTemplate size={12} /> templates
            </button>
            <button type="submit" disabled={loading || !intentText.trim()}
              className="shrink-0 rounded-full bg-gradient px-5 py-2 text-btn-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-30">
              {loading ? "…" : "Run"}
            </button>
          </div>
        </form>

        {/* policy line */}
        <p className="mt-3 font-mono text-[11px] text-vgray-400">
          max 10× · min HF 1.30 · approval required · non-custodial
        </p>

        {/* template palette */}
        {paletteOpen && (
          <div className="mt-4 max-h-64 overflow-y-auto rounded-2xl border border-vgray-100 bg-vgray-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <Eyebrow n="">{actions.length} templates</Eyebrow>
              <button type="button" onClick={() => setPaletteOpen(false)} className="text-vgray-400 hover:text-vgray-700"><X size={14} /></button>
            </div>
            {Object.entries(actionsByCategory).map(([cat, items]) => (
              <div key={cat} className="mb-3">
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-violet-500/80">{cat.replace(/_/g, " ")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((t) => (
                    <button key={t.id} type="button" disabled={!t.available}
                      title={t.available ? t.title : `${t.title} — not live yet`}
                      onClick={() => { setIntentText(fillPhrase(t.intent_phrase)); inputRef.current?.focus(); setPaletteOpen(false); }}
                      className="flex items-center gap-1.5 rounded-full border border-vgray-200 bg-surface px-2.5 py-1 font-mono text-[11px] text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600 disabled:cursor-not-allowed disabled:opacity-40">
                      {t.id}
                      <span className={`rounded px-1 text-[9px] uppercase ${t.free_tier ? "bg-emerald-500/15 text-emerald-600" : "bg-violet-500/15 text-violet-600"}`}>{t.free_tier ? "free" : "paid"}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!actions.length && <p className="font-mono text-body-3 text-vgray-400">{brainOnline ? "no templates" : "brain offline"}</p>}
          </div>
        )}

        {/* divider */}
        <div className="my-7 h-px bg-vgray-100" />

        {/* ── morphing content ─────────────────────────────────────────── */}

        {/* idle → examples */}
        {phase === "idle" && (
          <div>
            <Eyebrow n="02">Try</Eyebrow>
            <div className="mt-4 flex flex-col divide-y divide-vgray-100">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => run(ex)}
                  className="group flex items-center justify-between gap-3 py-3.5 text-left">
                  <span className="text-h8 text-vgray-700 transition-colors group-hover:text-vgray-900">{ex}</span>
                  <ChevronRight size={18} className="shrink-0 text-vgray-300 transition-all group-hover:translate-x-1 group-hover:text-violet-500" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* the submitted command echo (all non-idle phases) */}
        {phase !== "idle" && submitted && (
          <p className="mb-6 text-h7 leading-snug text-vgray-900">{submitted}</p>
        )}

        {/* thinking → receipts */}
        {phase === "thinking" && (
          <div>
            <Eyebrow n="02">Working</Eyebrow>
            <div className="mt-3 flex items-center gap-2 text-body-2 text-violet-500">
              <Loader2 size={15} className="animate-spin" /> reasoning…
            </div>
          </div>
        )}

        {/* answer → editorial answer + receipts */}
        {phase === "answer" && response && (
          <div>
            <Eyebrow n="02">Answer</Eyebrow>
            <p className="mt-3 whitespace-pre-wrap text-subtext leading-relaxed text-vgray-800">{response.message}</p>
            <div className="mt-6">{trace.map((s, i) => <ReceiptRow key={i} step={s} i={i} />)}</div>
          </div>
        )}

        {/* message (clarification / blocked / unavailable / error) */}
        {phase === "message" && response && (
          <div>
            <Eyebrow n="02">{response.kind === "blocked" ? "Blocked" : response.kind === "clarification" ? "Need a bit more" : "Note"}</Eyebrow>
            <p className={`mt-3 text-subtext leading-relaxed ${response.kind === "blocked" || response.kind === "error" ? "text-imperial-600" : "text-vgray-800"}`}>{response.message}</p>
            <div className="mt-6">{trace.map((s, i) => <ReceiptRow key={i} step={s} i={i} />)}</div>
          </div>
        )}

        {/* preview → reasoning receipts + giant HF + stats + approve */}
        {phase === "preview" && preview && (
          <div className="space-y-7">
            <div>
              <Eyebrow n="02">Reasoning</Eyebrow>
              <div className="mt-3">{trace.map((s, i) => <ReceiptRow key={i} step={s} i={i} />)}</div>
            </div>

            <div>
              <Eyebrow n="03">Preview</Eyebrow>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
                <div>
                  <p className="text-h6 font-semibold text-vgray-900">{preview.template_id}</p>
                  {fmtSlots(preview.slots) && <p className="mt-1 font-mono text-body-2 text-vgray-500">{fmtSlots(preview.slots)}</p>}
                </div>
                <HealthReadout hf={preview.risk.projected_health_factor} />
              </div>

              {/* guards */}
              <div className="mt-5 flex flex-wrap gap-x-8 gap-y-2">
                {preview.risk.reasons.length ? preview.risk.reasons.map((r, i) => (
                  <span key={i} className="flex items-center gap-2 text-body-2 text-vgray-500">
                    <CircleAlert size={14} className={preview.risk.decision === "block" ? "text-imperial-500" : "text-amber-500"} /> {r}
                  </span>
                )) : (
                  <span className="flex items-center gap-2 text-body-2 text-vgray-500"><Check size={14} className="text-emerald-500" /> within your policy</span>
                )}
              </div>

              {/* amount (write actions) */}
              {isWrite && (
                <div className="mt-5">
                  <label className="font-mono text-[11px] uppercase tracking-widest text-vgray-400">amount {preview.slots.asset ? `(${String(preview.slots.asset)})` : ""}</label>
                  <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0" disabled={executing || execResult?.ok}
                    className="mt-1 block w-full min-w-0 border-b-2 border-vgray-200 bg-transparent pb-2 font-mono text-h7 text-vgray-900 placeholder:text-vgray-300 focus:border-violet-500 focus:outline-none disabled:opacity-50" />
                </div>
              )}

              <button type="button" disabled={!canExecute} onClick={handleExecute}
                className={`mt-6 w-full rounded-full px-6 py-3.5 text-btn-md font-semibold transition-all ${
                  canExecute ? "bg-gradient text-white shadow-[0_12px_30px_-10px_rgba(112,58,230,0.6)] hover:opacity-90" : "cursor-not-allowed bg-vgray-100 text-vgray-400"}`}>
                {executing ? "Signing…" : isWrite ? "Approve & sign" : "Approve"}
              </button>

              {execResult && !execResult.ok && (
                <p className="mt-3 text-body-2 text-vgray-500">{execResult.note || execResult.error}</p>
              )}
            </div>
          </div>
        )}

        {/* live → confirmation */}
        {phase === "live" && preview && (
          <div>
            <Eyebrow n="04">Live</Eyebrow>
            <div className="mt-4 flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500"><Check size={30} /></span>
              <div>
                <p className="text-h5 font-semibold text-vgray-900">Position live</p>
                <p className="mt-0.5 text-body-1 text-vgray-500">{preview.template_id} submitted on-chain{execResult?.hash ? "" : ""}.</p>
              </div>
            </div>
            {execResult?.hash && <p className="mt-4 break-all font-mono text-body-3 text-vgray-400">tx {execResult.hash}</p>}
            <button type="button" onClick={reset} className="mt-6 rounded-full border border-vgray-200 px-5 py-2 text-btn-sm font-semibold text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600">
              New intent
            </button>
          </div>
        )}
      </div>

      {/* ── account strip ─────────────────────────────────────────────── */}
      <div className="mt-6 rounded-3xl border border-vgray-100 bg-surface p-6">
        <Eyebrow n="">Your account</Eyebrow>
        {address ? (
          hasMarginAccount ? (
            <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
              <Stat value={healthFactor >= 999 ? "∞" : healthFactor ? healthFactor.toFixed(2) : "—"} label="health" />
              <Stat value={usd(collateralValue)} label="collateral" />
              <Stat value={usd(borrowedValue)} label="borrowed" />
              <Stat value={truncAddr(smartAccount)} label="smart acct" />
            </div>
          ) : (
            <p className="mt-3 text-body-1 text-vgray-500">Wallet connected ({truncAddr(address)}) — no Vanna margin account yet.</p>
          )
        ) : (
          <p className="mt-3 text-body-1 text-vgray-500">Connect your wallet to see balances, collateral &amp; debt.</p>
        )}
      </div>

      <p className="mt-6 text-center text-body-3 text-vgray-400">
        Every action runs the same safety checks — nothing happens on-chain until you approve &amp; sign.
      </p>
    </div>
  );
}

export default CopilotWorkspace;
