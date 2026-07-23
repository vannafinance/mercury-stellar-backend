// Copilot write executor (Phase 2).
//
// The orchestrator "brain" classifies a write and returns a structured `action`
// (see ChatResponse.preview.action). We DON'T use the MCP's native write path —
// it's blocked contract-side — so execution runs through the app's own AUDITED
// on-chain services (the exact same ones the Earn / Margin pages and the Privy
// margin-account flow use). Each service builds → signs (via wallet-adapter:
// Freighter or Privy) → submits → polls, and returns { success, hash?, error? }.
//
// This module only MAPS an action to the right service call. It never signs by
// itself and is only ever invoked after the user clicks "Approve & sign".

import { ContractService, ASSET_TYPES, type AssetType } from "@/lib/stellar-utils";
import { MarginAccountService } from "@/lib/margin-utils";

export interface CopilotAction {
  op: string;
  asset?: string | null;
  amount?: number | null;
  requires_amount?: boolean;
  requires_account?: boolean;
  multi_leg?: boolean;
  smart_account?: string | null;
  trader?: string | null;
}

export interface ExecuteContext {
  amount: number; // user-entered / confirmed amount
  walletAddress: string | null; // connected G-address
  smartAccount: string | null; // C-address (margin account)
}

export type ExecuteResult = { ok: true; hash?: string } | { ok: false; error: string };

// Operations that actually move funds and are wired to a working service today.
export const EXECUTABLE_OPS = new Set([
  "lend",
  "redeem",
  "deposit_collateral",
  "withdraw_collateral",
  "borrow",
  "repay",
  "deposit_and_borrow",
  "create_account",
]);

export function isExecutable(action: CopilotAction | null | undefined): boolean {
  return !!action && EXECUTABLE_OPS.has(action.op);
}

/** Decimal amount → 18-decimal WAD string, precise (no float rounding). */
function toWad(amount: number): string {
  const [intPart, fracPart = ""] = String(amount).split(".");
  const frac = (fracPart + "0".repeat(18)).slice(0, 18);
  return (BigInt(intPart || "0") * 1_000000000000000000n + BigInt(frac || "0")).toString();
}

/** Map a free-text asset symbol to a pool AssetType for ContractService. */
function toAssetType(asset?: string | null): AssetType {
  switch ((asset || "").toUpperCase()) {
    case "XLM":
      return ASSET_TYPES.XLM;
    case "USDC":
      return ASSET_TYPES.USDC;
    case "BLUSDC":
    case "BLEND_USDC":
      return ASSET_TYPES.BLEND_USDC;
    case "AQUSDC":
    case "AQUARIUS_USDC":
      return ASSET_TYPES.AQUARIUS_USDC;
    case "SOUSDC":
    case "SOROSWAP_USDC":
      return ASSET_TYPES.SOROSWAP_USDC;
    default:
      return ASSET_TYPES.USDC;
  }
}

function norm(r: { success: boolean; hash?: string; error?: string }): ExecuteResult {
  return r.success ? { ok: true, hash: r.hash } : { ok: false, error: r.error || "Transaction failed" };
}

/**
 * Execute a copilot write action through the app's audited services.
 * Assumes the caller has already validated the amount and shown a preview.
 */
export async function executeAction(action: CopilotAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  const { amount, walletAddress, smartAccount } = ctx;
  const asset = action.asset || "USDC";

  const needsWallet = () => {
    if (!walletAddress) return { ok: false as const, error: "Connect your wallet first." };
    return null;
  };
  const needsAccount = () => {
    if (!smartAccount) return { ok: false as const, error: "You need a Vanna smart account for this." };
    return null;
  };
  const needsAmount = () => {
    if (!(amount > 0)) return { ok: false as const, error: "Enter a valid amount." };
    return null;
  };

  switch (action.op) {
    case "create_account": {
      const g = needsWallet();
      if (g) return g;
      const r = await MarginAccountService.createMarginAccount(walletAddress!);
      return r.success
        ? { ok: true, hash: (r as { hash?: string }).hash }
        : { ok: false, error: (r as { error?: string }).error || "Failed to create smart account" };
    }

    case "lend": {
      const w = needsWallet() || needsAmount();
      if (w) return w;
      return norm(await ContractService.deposit(walletAddress!, amount, toAssetType(asset)));
    }
    case "redeem": {
      const w = needsWallet() || needsAmount();
      if (w) return w;
      return norm(await ContractService.withdraw(walletAddress!, amount, toAssetType(asset)));
    }

    case "deposit_collateral": {
      const w = needsAccount() || needsAmount();
      if (w) return w;
      return norm(await MarginAccountService.depositCollateralTokens(smartAccount!, asset, toWad(amount)));
    }
    case "withdraw_collateral": {
      const w = needsAccount() || needsAmount();
      if (w) return w;
      return norm(await MarginAccountService.withdrawCollateralBalance(smartAccount!, asset, toWad(amount)));
    }
    case "borrow": {
      const w = needsAccount() || needsAmount();
      if (w) return w;
      return norm(await MarginAccountService.borrowTokens(smartAccount!, asset, toWad(amount)));
    }
    case "repay": {
      const w = needsAccount() || needsAmount();
      if (w) return w;
      return norm(await MarginAccountService.repayLoan(smartAccount!, asset, toWad(amount)));
    }

    case "deposit_and_borrow": {
      const w = needsAccount() || needsAmount();
      if (w) return w;
      // multiplier defaults to 2x when the user didn't state one; the preview
      // labels this a multi-leg strategy requiring explicit confirmation.
      return norm(await MarginAccountService.depositAndBorrow(smartAccount!, amount, 2, asset));
    }

    default:
      return { ok: false, error: `“${action.op}” isn't wired for execution yet.` };
  }
}
