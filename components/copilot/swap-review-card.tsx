"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import { quoteDexExactOut, quoteDexSwap } from "@/lib/copilot/swap-quote";

interface SwapReviewCardProps {
  workflow: WorkflowView;
  wallet: string | null;
  busy: boolean;
  autoSign: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

interface LiveQuote { key: string; expectedOut: number; checkedAt: number }

function amount(value: number | string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 7 }) : String(value);
}

/** The user's stated side stays visible even if the risk gate refused this plan. */
export function SwapIntentPreviewCard({ intent, wallet, refusal }: {
  intent: NonNullable<ResearchView["swapIntent"]>;
  wallet: string | null;
  refusal?: string | null;
}) {
  const [quote, setQuote] = useState<{ key: string; amountIn: number; expectedOut: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const exactOutput = intent.amountAsset === "assetOut";
  const quoteKey = [intent.tokenIn, intent.tokenOut, intent.venue, intent.amount, intent.amountAsset, wallet].join("|");
  const activeQuote = quote?.key === quoteKey ? quote : null;

  useEffect(() => {
    if (!wallet) return;
    let current = true;
    let inFlight = false;
    async function refresh() {
      if (!wallet || inFlight) return;
      inFlight = true;
      setChecking(true);
      const result = exactOutput
        ? await quoteDexExactOut({ targetOut: Number(intent.amount), tokenIn: intent.tokenIn,
            tokenOut: intent.tokenOut, venue: intent.venue, simulator: wallet })
        : await quoteDexSwap({ amountIn: Number(intent.amount), tokenIn: intent.tokenIn,
            tokenOut: intent.tokenOut, venue: intent.venue, simulator: wallet });
      if (current) {
        setQuote(result ? { key: quoteKey, amountIn: exactOutput ? (result as { amountIn: number }).amountIn : Number(intent.amount),
          expectedOut: exactOutput ? (result as { expectedOut: number }).expectedOut : (result as { expected: number }).expected } : null);
        setChecking(false);
      }
      inFlight = false;
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [intent, wallet, exactOutput, refreshKey, quoteKey]);

  return (
    <section aria-label="Swap quote" className="rounded-xl border border-violet-100 bg-surface p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-violet-500">Swap quote</p>
          <p className="mt-0.5 text-[13px] text-vgray-500">{intent.venue === "aquarius" ? "Aquarius" : "Soroswap"} · live venue estimate</p>
        </div>
        <button type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={checking}
          className="inline-flex items-center gap-1.5 rounded-lg border border-vgray-100 px-2.5 py-1.5 text-[12px] text-vgray-700 disabled:opacity-50">
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-vgray-100 bg-vgray-50 p-3.5">
          <dt className="text-[12px] text-vgray-500">{exactOutput ? "Input needed · live estimate" : "You spend · fixed from your request"}</dt>
          <dd className="mt-1 text-[20px] font-semibold tabular-nums text-vgray-900">{exactOutput ? activeQuote ? amount(activeQuote.amountIn) : wallet ? "Checking…" : "Connect wallet" : amount(intent.amount)} {intent.tokenIn}</dd>
        </div>
        <div className="rounded-xl border border-vgray-100 bg-vgray-50 p-3.5">
          <dt className="text-[12px] text-vgray-500">{exactOutput ? "You requested · fixed target" : "You receive · live estimate"}</dt>
          <dd className="mt-1 text-[20px] font-semibold tabular-nums text-vgray-900">{exactOutput ? amount(intent.amount) : activeQuote ? amount(activeQuote.expectedOut) : wallet ? "Checking…" : "Connect wallet"} {intent.tokenOut}</dd>
        </div>
      </dl>
      {checking && <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-violet-500"><Loader2 size={13} className="animate-spin" /> Reading the pool…</p>}
      {!checking && wallet && !activeQuote && <p role="alert" className="mt-2 text-[12.5px] text-imperial-600">The venue did not return a quote for this amount.</p>}
      {refusal && <p role="alert" className="mt-3 text-[12.5px] leading-5 text-imperial-600">The risk gate did not prepare this swap: {refusal} To continue at this price, state in chat that you accept the quoted loss.</p>}
      {!refusal && <p className="mt-3 text-[12.5px] text-vgray-500">A confirmable plan appears after account and risk checks. This estimate alone cannot execute a trade.</p>}
    </section>
  );
}

/** A read-only quote. The proposal amount remains the server's sealed amount. */
export function SwapReviewCard({ workflow, wallet, busy, autoSign, onConfirm, onCancel }: SwapReviewCardProps) {
  const swap = workflow.swap;
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const quoteKey = [workflow.id, workflow.revision, swap?.tokenIn, swap?.tokenOut, swap?.venue, swap?.amountIn, wallet].join("|");
  const activeQuote = quote?.key === quoteKey ? quote : null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!swap || !wallet || workflow.status !== "proposed") return;
    let current = true;
    let inFlight = false;
    async function refresh() {
      if (!swap || !wallet || inFlight) return;
      inFlight = true;
      setChecking(true);
      const result = await quoteDexSwap({
        amountIn: Number(swap.amountIn), tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut, venue: swap.venue, simulator: wallet,
      });
      if (current) {
        setQuote(result ? { key: quoteKey, expectedOut: result.expected, checkedAt: Date.now() } : null);
        setError(result ? null : "The venue did not return a live quote. Refresh before confirming.");
        setChecking(false);
      }
      inFlight = false;
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [swap, wallet, workflow.status, refreshKey, quoteKey]);

  if (!swap || workflow.status !== "proposed") return null;
  const minimum = Number(swap.minOut);
  const isFresh = !!activeQuote && now - activeQuote.checkedAt < 45_000;
  const meetsFloor = !!activeQuote && Number.isFinite(minimum) && activeQuote.expectedOut >= minimum;
  const expiresSoon = workflow.expiresAt <= now;
  const canConfirm = isFresh && meetsFloor && !expiresSoon && !busy && !checking;
  const exactOutput = swap.targetOut !== null;

  return (
    <section aria-label="Swap review" className="rounded-xl border border-violet-100 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-violet-500">Review swap</p>
          <p className="mt-0.5 text-[13px] text-vgray-500">{swap.venue === "aquarius" ? "Aquarius" : "Soroswap"} · live venue quote</p>
        </div>
        <button type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={checking || busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-vgray-100 px-2.5 py-1.5 text-[12px] text-vgray-700 disabled:opacity-50">
          <RefreshCw size={13} aria-hidden="true" /> Refresh quote
        </button>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-vgray-100 bg-vgray-50 p-3.5">
          <dt className="text-[12px] text-vgray-500">{exactOutput ? "You spend · calculated for your target" : "You spend · fixed from your request"}</dt>
          <dd className="mt-1 text-[20px] font-semibold tabular-nums text-vgray-900">{amount(swap.amountIn)} {swap.tokenIn}</dd>
        </div>
        <div className="rounded-xl border border-vgray-100 bg-vgray-50 p-3.5">
          <dt className="text-[12px] text-vgray-500">{exactOutput ? "You requested at least" : "You receive · current estimate"}</dt>
          <dd className="mt-1 text-[20px] font-semibold tabular-nums text-vgray-900">
            {exactOutput ? amount(swap.targetOut!) : activeQuote ? amount(activeQuote.expectedOut) : wallet ? "Checking…" : "Connect wallet"} {swap.tokenOut}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[12.5px] leading-5 text-vgray-600">
        {activeQuote ? `The venue currently quotes ${amount(activeQuote.expectedOut)} ${swap.tokenOut} for this fixed input. ` : ""}
        The transaction requires at least {amount(swap.minOut)} {swap.tokenOut}; otherwise it reverts.
        {exactOutput ? " The input includes the plan's quote buffer and is not editable here." : ""}
      </p>
      {checking && <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-violet-500"><Loader2 size={13} className="animate-spin" /> Checking the pool…</p>}
      {(error || !meetsFloor && activeQuote || expiresSoon || !isFresh && activeQuote) && (
        <p role="alert" className="mt-2 text-[12.5px] text-imperial-600">
          {expiresSoon ? "This plan expired. Ask for a new quote." : error ?? (!isFresh ? "The quote is stale. Refresh it." : "The pool now pays less than the plan's minimum. Ask for a new plan.")}
        </p>
      )}
      <p className="mt-3 text-[12px] text-vgray-500">
        {autoSign
          ? "Auto sign is on. Confirming starts the risk check; the capped signer may submit if it passes."
          : "Auto sign is off. Confirming starts the risk check, then your wallet must sign."}
      </p>
      {workflow.steps.length > 1 && (
        <div className="mt-3 text-[12.5px] text-vgray-600">
          <p className="font-semibold">This confirmation covers {workflow.steps.length} steps:</p>
          <ol className="mt-1 list-inside list-decimal space-y-0.5">{workflow.steps.map((step) => <li key={step.id}>{step.label}</li>)}</ol>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} disabled={!canConfirm}
          className="rounded-r2 bg-gradient px-4 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">
          {busy ? "Checking…" : "Confirm swap"}
        </button>
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-r2 border border-vgray-100 px-4 py-2.5 text-[13px] font-semibold text-vgray-700 disabled:opacity-45">Cancel</button>}
      </div>
    </section>
  );
}
