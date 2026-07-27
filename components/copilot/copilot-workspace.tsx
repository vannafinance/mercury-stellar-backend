"use client";

// Vanna Copilot — full-page agentic workspace (/copilot).  PHASE 2: reads + writes.
//
// Flow: the user states an intent → the orchestrator "brain" (MCP + Gemini)
// parses it, runs the deterministic risk gate, and returns either
//   • an ANSWER (read: live data explained in plain English + structured facts), or
//   • a PREVIEW (write: a structured `action` the UI executes via the app's
//     AUDITED on-chain services after the user clicks "Approve & sign").
// Nothing signs or moves funds until that click. Signing goes through the app's
// wallet-adapter (Freighter or Privy) inside the services themselves.
//
// Design: Plus Jakarta Sans for prose; monospace for numeric/technical labels
// (brand guideline). Primary action = brand gradient; health-positive green,
// caution amber, danger imperial-red.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutTemplate, X, Loader2, Sparkles, Check, CircleAlert, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, checkUserMarginAccount } from "@/store/margin-account-info-store";
import { useCopilotSettingsStore } from "@/store/copilot-settings";
import { executeAction, isExecutable, type CopilotAction, type ExecuteResult } from "./execute";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface BrainHealth {
  status: string;
  llm_provider: string;
  mcp_mode: string;
  templates: number;
}
interface RiskResult {
  decision: "allow" | "block" | "needs_confirmation" | string;
  reasons: string[];
  projected_health_factor?: number | null;
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
interface Preview {
  template_id: string;
  human_summary: string;
  slots: Record<string, unknown>;
  risk: RiskResult;
  requires_signature: boolean;
  action?: CopilotAction | null;
  simulation?: Simulation | null;
}
interface ChatResponse {
  kind: "answer" | "clarification" | "unavailable" | "blocked" | "error" | "preview";
  message: string;
  preview?: Preview | null;
  data?: Record<string, unknown> | null;
  intent?: { template_id?: string | null } | null;
  request_id?: string | null;
}

// ---------------------------------------------------------------------------
// static content
// ---------------------------------------------------------------------------

const EXAMPLES = [
  "What's the price of XLM?",
  "How is the USDC pool doing?",
  "Deposit 5 USDC as collateral",
  "Borrow 10 USDC against my collateral",
];

const PROMPTS: Record<string, string[]> = {
  market: ["Price of XLM", "Prices of XLM, USDC and AQUA", "USDC pool stats", "Borrow APR on the XLM pool"],
  "my account": ["What's my health factor?", "How much have I deposited?", "How much do I owe?", "Can I borrow 100 USDC?"],
  actions: ["Deposit 5 USDC as collateral", "Borrow 10 USDC", "Repay 5 USDC", "Supply 20 USDC to the pool"],
};

// ---------------------------------------------------------------------------
// helpers + pieces
// ---------------------------------------------------------------------------

function truncAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function prettyKey(k: string): string {
  return k
    .replace(/_pct$/, " %")
    .replace(/_usd$/, " (USD)")
    .replace(/_human$/, "")
    .replace(/_/g, " ")
    .trim();
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

function Eyebrow({ n, children }: { n: string; children: React.ReactNode }) {
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
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="font-mono text-[15px] text-vgray-900">{value}</p>
      <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-widest text-vgray-400">{label}</p>
    </div>
  );
}

// Structured facts extracted from a read result → clean two-column rows.
function FactsPanel({ data }: { data: Record<string, unknown> }) {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === "") continue;
    if (typeof v === "object") {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv != null && typeof sv !== "object") rows.push([`${sk}`, prettyVal(sv)]);
      }
    } else {
      rows.push([prettyKey(k), prettyVal(v)]);
    }
  }
  if (!rows.length) return null;
  return (
    <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 rounded-2xl border border-vgray-100 bg-vgray-50 p-4 sm:grid-cols-2">
      {rows.slice(0, 10).map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 border-b border-vgray-100/70 pb-1.5 last:border-0">
          <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">{k}</span>
          <span className="font-mono text-[13px] text-vgray-900">{v}</span>
        </div>
      ))}
    </div>
  );
}

// Health factor tone helpers.
function hfTone(hf: number | null): string {
  if (hf == null) return "text-emerald-500"; // no debt → infinite → healthy
  return hf >= 1.5 ? "text-emerald-500" : hf >= 1.3 ? "text-amber-500" : "text-imperial-500";
}
function hfLabel(hf: number | null): string {
  return hf == null ? "∞" : hf.toFixed(2);
}
const usd0 = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// Before → after projection for a margin write. Shows the real impact on the
// account's health factor, collateral and debt BEFORE the user signs.
function SimulationPanel({ sim }: { sim: Simulation }) {
  const Row = ({ label, before, after, tone }: { label: string; before: string; after: string; tone?: string }) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">{label}</span>
      <span className="flex items-center gap-2 font-mono text-[14px]">
        <span className="text-vgray-500">{before}</span>
        <ChevronRight size={13} className="text-vgray-300" />
        <span className={`font-semibold ${tone ?? "text-vgray-900"}`}>{after}</span>
      </span>
    </div>
  );
  return (
    <div className="mt-5 rounded-2xl border border-vgray-100 bg-vgray-50 p-4">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-violet-500/80">projected impact</p>
      <Row label="health factor" before={hfLabel(sim.hf_before)} after={hfLabel(sim.hf_after)} tone={hfTone(sim.hf_after)} />
      <Row label="collateral" before={usd0(sim.collateral_before)} after={usd0(sim.collateral_after)} />
      <Row label="debt" before={usd0(sim.debt_before)} after={usd0(sim.debt_after)} />
      <p className="mt-2 font-mono text-[10px] text-vgray-400">
        liquidation at HF 1.00 · safety floor 1.30 · est. ~{usd0(sim.amount_usd)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function CopilotWorkspace() {
  const address = useUserStore((s) => s.address);
  const walletKind = useUserStore((s) => s.walletKind);
  const smartAccount = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const healthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  // Per-wallet "session signing" toggle (Privy only). ON → skip the manual
  // Approve & sign click for single-leg, risk-allowed writes.
  const autoApprove = useCopilotSettingsStore((s) => (address ? !!s.autoApproveByWallet[address] : false));

  const [intentText, setIntentText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [amount, setAmount] = useState("");
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null);
  const [health, setHealth] = useState<BrainHealth | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoFiredRef = useRef<string | null>(null); // guards one auto-approve per turn

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

  const run = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || loading) return;
      setSubmitted(t);
      setIntentText(t);
      setLoading(true);
      setResponse(null);
      setAmount("");
      setExecResult(null);
      setPaletteOpen(false);
      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: address ?? "guest",
            message: t,
            tier: "paid",
            smart_account: smartAccount ?? null,
          }),
        });
        setResponse((await res.json()) as ChatResponse);
      } catch {
        setResponse({ kind: "error", message: "Copilot is unreachable. Is the brain running?" });
      } finally {
        setLoading(false);
      }
    },
    [address, smartAccount, loading],
  );

  const preview = response?.kind === "preview" ? response.preview ?? null : null;
  const action = preview?.action ?? null;
  const requiresAmount = !!action?.requires_amount;
  // Amount already stated in the prompt ("borrow 500 USDC") → don't re-ask.
  const promptAmount = typeof action?.amount === "number" && action.amount > 0 ? action.amount : null;
  const typedAmount = parseFloat(amount);
  const effectiveAmount = promptAmount ?? (Number.isFinite(typedAmount) ? typedAmount : 0);
  // We only need to COLLECT an amount when the op needs one and the prompt didn't
  // already provide it.
  const amountMissing = requiresAmount && promptAmount == null;
  const amountValid = !requiresAmount || effectiveAmount > 0;
  const blocked = preview?.risk.decision === "block";
  const canExecute = !!action && isExecutable(action) && !blocked && amountValid && !executing && !execResult?.ok;

  const approve = useCallback(async () => {
    if (!action) return;
    setExecuting(true);
    setExecResult(null);
    try {
      const result = await executeAction(action, {
        amount: effectiveAmount,
        walletAddress: address,
        smartAccount,
      });
      setExecResult(result);
      // Report the on-chain outcome to the copilot log (fire-and-forget, tied to
      // this turn's request_id). Never blocks or errors the user.
      fetch("/api/copilot/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: response?.request_id ?? null,
          op: action.op,
          asset: action.asset ?? null,
          amount: effectiveAmount,
          ok: result.ok,
          hash: result.ok ? result.hash ?? null : null,
          error: result.ok ? null : result.error,
          wallet: address,
        }),
      }).catch(() => {});
      if (result.ok) {
        toast.success(`Done${result.hash ? ` · ${result.hash.slice(0, 8)}…` : ""}`);
        if (address) checkUserMarginAccount(address).catch(() => {});
      } else {
        toast.error(result.error);
      }
    } catch (e) {
      setExecResult({ ok: false, error: e instanceof Error ? e.message : "Execution failed" });
    } finally {
      setExecuting(false);
    }
  }, [action, effectiveAmount, address, smartAccount, response]);

  const reset = () => {
    setSubmitted(null);
    setResponse(null);
    setAmount("");
    setExecResult(null);
    setIntentText("");
    autoFiredRef.current = null;
    inputRef.current?.focus();
  };

  // Auto-approve (session signing): when the toggle is ON for a Privy wallet and
  // the write is single-leg + risk-allowed + has its amount, execute it once
  // automatically — no manual "Approve & sign" click. Multi-leg / needs-
  // confirmation / blocked writes ALWAYS require a manual click (safety), and
  // Freighter never auto-approves.
  const autoEligible =
    autoApprove &&
    walletKind === "privy" &&
    !!preview &&
    !!action &&
    isExecutable(action) &&
    preview.risk.decision === "allow" &&
    !amountMissing &&
    amountValid &&
    !!address;

  useEffect(() => {
    if (autoEligible && !executing && !execResult && autoFiredRef.current !== submitted) {
      autoFiredRef.current = submitted;
      approve();
    }
  }, [autoEligible, executing, execResult, submitted, approve]);

  const brainOnline = health?.status === "ok";
  const isError = response?.kind === "error" || response?.kind === "blocked";
  const phase: "idle" | "thinking" | "answer" | "preview" =
    loading ? "thinking" : preview ? "preview" : response ? "answer" : "idle";

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

      {/* ── card ──────────────────────────────────────────────────────── */}
      <div className="rounded-3xl border border-vgray-100 bg-surface p-6 shadow-vanna sm:p-9">
        {/* 01 · ASK */}
        <Eyebrow n="01">Ask</Eyebrow>
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
              placeholder="Ask, or state an action — “deposit 5 USDC as collateral”…"
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

        <p className="mt-3 font-mono text-[11px] text-vgray-400">
          max 10× · min HF 1.30 · approval required · non-custodial
        </p>

        {/* prompt palette */}
        {paletteOpen && (
          <div className="mt-4 max-h-64 overflow-y-auto rounded-2xl border border-vgray-100 bg-vgray-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <Eyebrow n="">what you can ask</Eyebrow>
              <button type="button" onClick={() => setPaletteOpen(false)} className="text-vgray-400 hover:text-vgray-700">
                <X size={14} />
              </button>
            </div>
            {Object.entries(PROMPTS).map(([cat, items]) => (
              <div key={cat} className="mb-3">
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-violet-500/80">{cat}</p>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => run(q)}
                      className="rounded-full border border-vgray-200 bg-surface px-2.5 py-1 text-[12px] text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="my-7 h-px bg-vgray-100" />

        {/* ── content ─────────────────────────────────────────────────── */}

        {phase === "idle" && (
          <div>
            <Eyebrow n="02">Try</Eyebrow>
            <div className="mt-4 flex flex-col divide-y divide-vgray-100">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => run(ex)}
                  className="group flex items-center justify-between gap-3 py-3.5 text-left"
                >
                  <span className="text-h8 text-vgray-700 transition-colors group-hover:text-vgray-900">{ex}</span>
                  <ChevronRight size={18} className="shrink-0 text-vgray-300 transition-all group-hover:translate-x-1 group-hover:text-violet-500" />
                </button>
              ))}
            </div>
          </div>
        )}

        {phase !== "idle" && submitted && <p className="mb-6 text-h7 leading-snug text-vgray-900">{submitted}</p>}

        {phase === "thinking" && (
          <div className="flex items-center gap-2 text-body-2 text-violet-500">
            <Loader2 size={15} className="animate-spin" /> thinking…
          </div>
        )}

        {/* ANSWER (read) */}
        {phase === "answer" && response && (
          <div style={{ animation: "copilot-in 300ms ease-out forwards" }}>
            <Eyebrow n="02">{isError ? "Note" : "Answer"}</Eyebrow>
            <div className="mt-3 flex gap-3">
              {!isError && <Sparkles size={18} className="mt-0.5 shrink-0 text-violet-500" />}
              <p className={`whitespace-pre-wrap text-subtext leading-relaxed ${isError ? "text-imperial-600" : "text-vgray-800"}`}>
                {response.message}
              </p>
            </div>
            {!isError && response.data && <FactsPanel data={response.data} />}
            <button
              type="button"
              onClick={reset}
              className="mt-6 rounded-full border border-vgray-200 px-5 py-2 text-btn-sm font-semibold text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
            >
              Ask another
            </button>
          </div>
        )}

        {/* PREVIEW (write) */}
        {phase === "preview" && preview && (
          <div className="space-y-6" style={{ animation: "copilot-in 300ms ease-out forwards" }}>
            {/* confirmed state */}
            {execResult?.ok ? (
              <div>
                <Eyebrow n="03">Done</Eyebrow>
                <div className="mt-4 flex items-center gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                    <Check size={26} />
                  </span>
                  <div>
                    <p className="text-h6 font-semibold text-vgray-900">{preview.human_summary}</p>
                    <p className="mt-0.5 text-body-2 text-vgray-500">Submitted on-chain and signed with your wallet.</p>
                  </div>
                </div>
                {execResult.hash && <p className="mt-4 break-all font-mono text-body-3 text-vgray-400">tx {execResult.hash}</p>}
                <button
                  type="button"
                  onClick={reset}
                  className="mt-6 rounded-full border border-vgray-200 px-5 py-2 text-btn-sm font-semibold text-vgray-600 transition-colors hover:border-violet-400 hover:text-violet-600"
                >
                  New intent
                </button>
              </div>
            ) : (
              <>
                <div>
                  <Eyebrow n="02">Preview</Eyebrow>
                  <div className="mt-3">
                    <p className="text-h6 font-semibold text-vgray-900">{preview.human_summary}</p>
                    {action?.multi_leg && (
                      <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-amber-500">
                        multi-step strategy
                      </p>
                    )}
                  </div>

                  {/* before → after projection */}
                  {preview.simulation && <SimulationPanel sim={preview.simulation} />}

                  {/* risk / guard reasons */}
                  <div className="mt-4 flex flex-col gap-1.5">
                    {preview.risk.reasons.map((r, i) => (
                      <span key={i} className="flex items-center gap-2 text-body-2 text-vgray-500">
                        {blocked ? (
                          <CircleAlert size={14} className="text-imperial-500" />
                        ) : action?.multi_leg ? (
                          <CircleAlert size={14} className="text-amber-500" />
                        ) : (
                          <ShieldCheck size={14} className="text-emerald-500" />
                        )}
                        {r}
                      </span>
                    ))}
                  </div>

                  {/* amount — collect only if the prompt didn't already give one */}
                  {amountMissing ? (
                    <div className="mt-5">
                      <label className="font-mono text-[11px] uppercase tracking-widest text-vgray-400">
                        amount {action?.asset ? `(${action.asset})` : ""}
                      </label>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                        autoFocus
                        disabled={executing || execResult?.ok}
                        className="mt-1 block w-full min-w-0 border-b-2 border-vgray-200 bg-transparent pb-2 font-mono text-h7 text-vgray-900 placeholder:text-vgray-300 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                      />
                    </div>
                  ) : promptAmount != null ? (
                    <div className="mt-5 flex items-baseline gap-2">
                      <span className="font-mono text-[11px] uppercase tracking-widest text-vgray-400">amount</span>
                      <span className="font-mono text-h7 text-vgray-900">
                        {promptAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} {action?.asset ?? ""}
                      </span>
                    </div>
                  ) : null}

                  {/* not connected hint */}
                  {!address && (
                    <p className="mt-4 text-body-2 text-amber-600">Connect your wallet to sign this action.</p>
                  )}
                  {action?.requires_account && address && !smartAccount && (
                    <p className="mt-4 text-body-2 text-amber-600">
                      You need a Vanna smart account first — create one, then retry.
                    </p>
                  )}

                  {autoEligible && (
                    <p className="mt-4 flex items-center gap-1.5 font-mono text-[11px] text-violet-500">
                      <ShieldCheck size={13} /> auto-approve on — running without a manual signature
                    </p>
                  )}

                  <button
                    type="button"
                    disabled={!canExecute || !address}
                    onClick={approve}
                    className={`mt-6 w-full rounded-full px-6 py-3.5 text-btn-md font-semibold transition-all ${
                      canExecute && address
                        ? "bg-gradient text-white shadow-[0_12px_30px_-10px_rgba(112,58,230,0.6)] hover:opacity-90"
                        : "cursor-not-allowed bg-vgray-100 text-vgray-400"
                    }`}
                  >
                    {executing ? "Signing…" : autoEligible ? "Auto-approving…" : blocked ? "Blocked by risk policy" : "Approve & sign"}
                  </button>

                  {execResult && !execResult.ok && (
                    <p className="mt-3 text-body-2 text-imperial-600">{execResult.error}</p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={reset}
                  className="text-btn-sm font-semibold text-vgray-400 transition-colors hover:text-vgray-700"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── account strip (passive read) ──────────────────────────────── */}
      <div className="mt-6 rounded-3xl border border-vgray-100 bg-surface p-6">
        <Eyebrow n="">Your account</Eyebrow>
        {address ? (
          <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
            <Stat value={truncAddr(address)} label="wallet" />
            <Stat value={truncAddr(smartAccount)} label="smart acct" />
            <Stat
              value={hasMarginAccount && healthFactor ? (healthFactor >= 999 ? "∞" : healthFactor.toFixed(2)) : "—"}
              label="health"
            />
          </div>
        ) : (
          <p className="mt-3 text-body-1 text-vgray-500">
            Connect your wallet to act on your account. Market questions work either way.
          </p>
        )}
      </div>

      <p className="mt-6 text-center text-body-3 text-vgray-400">
        Every action runs the same safety checks — nothing happens on-chain until you approve &amp; sign.
      </p>
    </div>
  );
}

export default CopilotWorkspace;
