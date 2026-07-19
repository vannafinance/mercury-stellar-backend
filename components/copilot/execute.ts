"use client";

// Copilot write-execution layer (Option B: reuse the app's existing, battle-tested
// on-chain services + Freighter signing).
//
// The orchestrator stays the brain — it parses intent, picks the audited template,
// runs the risk gate, and returns a preview. It does NOT build/sign anything. When
// the user approves a write preview, we map (template_id + slots + amount) to the
// SAME service functions the Earn/Margin pages use. Those handle the XDR build,
// Freighter signature, submit, poll, and store refresh. Zero new signing code.
//
// Contract reality (Vanna PRD): only 1× deposit/lend works today; borrow /
// leverage>1 is disabled on-chain (lend_to fix pending) and will surface a clear
// error from the service. Automation/conditional templates (take-profit, close-if,
// rebalance, …) are NOT one-shot actions — there is nothing to sign now, so we say
// so instead of pretending.

import { ContractService, type AssetType } from "@/lib/stellar-utils";
import { MarginAccountService } from "@/lib/margin-utils";

export interface ExecuteResult {
  ok: boolean;
  hash?: string;
  error?: string;
  /** Set when the template isn't an immediate on-chain action (nothing to sign). */
  note?: string;
}

// number → WAD (18-decimal fixed point) string, matching lib/*-utils conventions.
const toWad = (amount: number): string => BigInt(Math.floor(amount * 1e18)).toString();

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

// Copilot slot symbols → the app's AssetType. XLM/USDC map directly; the leveraged
// pool aliases collapse to USDC's AssetType where relevant.
function toAssetType(symbol: string): AssetType {
  const s = symbol.toUpperCase();
  if (s === "XLM") return "XLM" as AssetType;
  if (s === "USDC" || s === "BUSD") return "USDC" as AssetType;
  return s as AssetType;
}

/** Which templates are immediate, executable on-chain writes (vs automations). */
export const EXECUTABLE_TEMPLATES = new Set([
  "lend_open_vanna",
  "lend_blend_5x",
  "lend_blend_custom",
  "repay_and_close",
]);

export function isExecutable(templateId: string | undefined | null): boolean {
  return !!templateId && EXECUTABLE_TEMPLATES.has(templateId);
}

/**
 * Execute an approved copilot write preview via the app's existing services.
 * Freighter will prompt for a signature inside these calls.
 */
export async function executeTemplate(params: {
  templateId: string;
  slots: Record<string, unknown>;
  amount: number;
  walletAddress: string | null;
  smartAccount: string | null;
}): Promise<ExecuteResult> {
  const { templateId, slots, amount, walletAddress, smartAccount } = params;
  const asset = String(slots.asset ?? slots.token_a ?? "XLM");

  if (!walletAddress) return { ok: false, error: "Connect your wallet first." };

  if (!EXECUTABLE_TEMPLATES.has(templateId)) {
    return {
      ok: false,
      note:
        "This is a monitoring / automation rule (e.g. take-profit, close-if, rebalance), " +
        "not a one-shot on-chain action — there's nothing to sign right now. " +
        "Executable actions: lend/deposit, leveraged lend, repay.",
    };
  }

  if (amount <= 0) return { ok: false, error: "Enter an amount greater than 0." };

  try {
    switch (templateId) {
      // 1× deposit into a Vanna lending position (the free-tier, works-today path).
      case "lend_open_vanna": {
        const r = await ContractService.deposit(walletAddress, amount, toAssetType(asset));
        return r.success ? { ok: true, hash: r.hash } : { ok: false, error: r.error };
      }

      // Leveraged lending on Blend. leverage>1 needs the on-chain borrow path,
      // which is currently disabled — the service returns a clear error for it.
      case "lend_blend_5x":
      case "lend_blend_custom": {
        if (!smartAccount) return { ok: false, error: "Open a Vanna margin account first, then retry." };
        const leverage = templateId === "lend_blend_5x" ? 5 : num(slots.leverage, 1);
        const r = await MarginAccountService.depositAndBorrow(smartAccount, amount, leverage, asset);
        return r.success ? { ok: true, hash: r.hash } : { ok: false, error: r.error };
      }

      // Repay borrowed funds against the margin account.
      case "repay_and_close": {
        if (!smartAccount) return { ok: false, error: "No margin account found for this wallet." };
        const r = await MarginAccountService.repayLoan(smartAccount, asset, toWad(amount));
        return r.success ? { ok: true, hash: r.hash } : { ok: false, error: r.error };
      }

      default:
        return { ok: false, error: `No executor mapped for '${templateId}'.` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Execution failed." };
  }
}
