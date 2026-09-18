"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import {
  earnDepositKey,
  fundingCovers,
  marginBalanceKey,
  spendPocket,
  walletBalanceKey,
} from "@/lib/copilot/plan-funding";
import { refreshWalletBalancesOnChain } from "@/hooks/use-wallet";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";

interface PlanReviewCardProps {
  workflow: WorkflowView;
  wallet: string | null;
  busy: boolean;
  autoSign: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

function amount(value: number | string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 7 }) : String(value);
}

function parseBalance(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Earn / Farm / Margin review: keep the sealed amounts, refresh the pockets they spend
 * while the user reads. Swap has its own quote card; this is the same idea for balances.
 */
export function PlanReviewCard({ workflow, wallet, busy, autoSign, onConfirm, onCancel }: PlanReviewCardProps) {
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const depositedBalances = useUserStore((s) => s.depositedBalances);
  const collateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  const [checking, setChecking] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!wallet || workflow.status !== "proposed") return;
    let current = true;
    let inFlight = false;
    async function refresh() {
      if (!wallet || inFlight) return;
      inFlight = true;
      setChecking(true);
      try {
        await refreshWalletBalancesOnChain(wallet);
        if (current) setFresh(true);
      } catch {
        /* Server re-checks on Approve; a missed Horizon read must not freeze the card. */
      } finally {
        if (current) setChecking(false);
        inFlight = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [wallet, workflow.status, workflow.id, workflow.revision, refreshKey]);

  const rows = useMemo(() => {
    return workflow.steps.flatMap((step) => {
      const pocket = spendPocket(step.op);
      if (!pocket) return [];
      const needed = Number(step.amount);
      let available: number | null = null;
      let source = "";
      if (pocket === "wallet") {
        const key = walletBalanceKey(step.asset);
        available = key ? parseBalance(tokenBalances[key]) : null;
        source = "wallet";
      } else if (pocket === "earn") {
        const key = earnDepositKey(step.asset);
        available = key ? parseBalance(depositedBalances[key]) : null;
        source = "Earn";
      } else {
        const key = marginBalanceKey(step.asset);
        available = key ? parseBalance(collateralBalances[key]?.amount) : null;
        source = "margin account";
      }
      const covers = fundingCovers(available, needed);
      return [{
        id: step.id,
        label: step.label,
        asset: step.asset,
        needed,
        available,
        source,
        short: fresh && covers === false,
      }];
    });
  }, [workflow.steps, tokenBalances, depositedBalances, collateralBalances, fresh]);

  const shortfall = rows.some((row) => row.short);
  const canConfirm = !busy && !shortfall;
  const showsHealth = workflow.steps.some((step) => step.op === "borrow" || step.op === "withdraw_collateral" || step.op === "repay");

  if (workflow.status !== "proposed") return null;

  return (
    <section aria-label="Plan for approval" className="rounded-xl border border-violet-100 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-violet-500">Plan for approval</p>
          <p className="mt-0.5 text-[13px] text-vgray-500">Sealed amounts · live pockets while you wait</p>
        </div>
        <button type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={checking || busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-vgray-100 px-2.5 py-1.5 text-[12px] text-vgray-700 disabled:opacity-50">
          <RefreshCw size={13} aria-hidden="true" /> Refresh balances
        </button>
      </div>

      <p className="mt-3 text-[15px] leading-6 text-vgray-900">{workflow.objective}</p>
      <p className="mt-1 max-w-[68ch] text-[13px] leading-5 text-vgray-500">{workflow.message}</p>

      <ol className="mt-3 space-y-1.5">
        {workflow.steps.map((step, stepIndex) => (
          <li key={step.id} className="flex gap-2.5 text-[13px] leading-5 text-vgray-800">
            <span className="w-4 shrink-0 text-right tabular-nums text-vgray-400">{stepIndex + 1}</span>
            <span className="min-w-0 break-words">
              {step.label}
              <span className="tabular-nums text-vgray-500"> ({step.amount} {step.asset})</span>
            </span>
          </li>
        ))}
      </ol>

      {rows.length > 0 && (
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-xl border border-vgray-100 bg-vgray-50 p-3.5">
              <dt className="text-[12px] text-vgray-500">{row.source} · {row.asset}</dt>
              <dd className="mt-1 text-[16px] font-semibold tabular-nums text-vgray-900">
                {fresh && row.available != null ? amount(row.available) : wallet ? "Checking…" : "Connect wallet"} available
              </dd>
              <dd className="mt-0.5 text-[12.5px] text-vgray-500">Plan spends {amount(row.needed)}</dd>
            </div>
          ))}
        </dl>
      )}

      {showsHealth && Number.isFinite(avgHealthFactor) && avgHealthFactor > 0 && (
        <p className="mt-3 text-[12.5px] text-vgray-600">
          Live health factor {avgHealthFactor === Number.POSITIVE_INFINITY ? "∞" : avgHealthFactor.toFixed(2)}. Approve re-checks it before anything is submitted.
        </p>
      )}

      {checking && (
        <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-violet-500">
          <Loader2 size={13} className="animate-spin" /> Reading live balances…
        </p>
      )}
      {shortfall && (
        <p role="alert" className="mt-2 text-[12.5px] text-imperial-600">
          A pocket no longer covers this plan. Refresh, or ask for a new plan — clicking Approve would fail the live check.
        </p>
      )}
      <p className="mt-3 text-[12px] text-vgray-500">
        {autoSign
          ? "Auto sign is on. Confirming starts the risk check; the capped signer may submit if it passes."
          : "Auto sign is off. The plan stays open until you click. Confirming re-reads live funds, then your wallet must sign."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} disabled={!canConfirm}
          className="rounded-r2 bg-gradient px-4 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">
          {busy ? "Checking…" : "Approve and run"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded-r2 border border-vgray-100 px-4 py-2.5 text-[13px] font-semibold text-vgray-700 disabled:opacity-45">
            Cancel remaining steps
          </button>
        )}
      </div>
    </section>
  );
}
