import { OP_FLOW, type WorkflowOp } from "./workflow/types";
import { assetForVenueSpelling, resolveAssetDef } from "./registry/assets";

export type WalletBalanceKey = "XLM" | "BLEND_USDC" | "AQUARIUS_USDC" | "SOROSWAP_USDC";
export type EarnDepositKey = "XLM" | "USDC" | "AQUARIUS_USDC" | "SOROSWAP_USDC";
export type FundingPocket = "wallet" | "earn" | "account";

function assetDef(asset: string) {
  return resolveAssetDef(asset)
    ?? assetForVenueSpelling("earn", asset)
    ?? assetForVenueSpelling("margin", asset);
}

/** Wallet store key for a copilot asset id or venue spelling (USDC on Earn = BLUSDC). */
export function walletBalanceKey(asset: string): WalletBalanceKey | null {
  const def = assetDef(asset);
  if (!def) return null;
  switch (def.id) {
    case "XLM": return "XLM";
    case "BLUSDC": return "BLEND_USDC";
    case "AQUSDC": return "AQUARIUS_USDC";
    case "SOUSDC": return "SOROSWAP_USDC";
    default: return null;
  }
}

export function earnDepositKey(asset: string): EarnDepositKey | null {
  const key = walletBalanceKey(asset);
  if (key === "BLEND_USDC") return "USDC";
  if (key === "XLM" || key === "AQUARIUS_USDC" || key === "SOROSWAP_USDC") return key;
  return null;
}

export function marginBalanceKey(asset: string): string | null {
  return assetDef(asset)?.marginSymbol ?? null;
}

/** Pocket whose live balance must still cover a stated spend. Borrow/debt is capacity, not a balance. */
export function spendPocket(op: WorkflowOp): FundingPocket | null {
  const from = OP_FLOW[op].from;
  if (from === "wallet" || from === "earn" || from === "account") return from;
  return null;
}

/**
 * `null` means the live read is missing — do not block Approve; the server re-checks.
 * `false` means we know the pocket cannot cover the sealed amount.
 */
export function fundingCovers(available: number | null, needed: number): boolean | null {
  if (available == null || !Number.isFinite(available) || !Number.isFinite(needed)) return null;
  return available + 1e-9 >= needed;
}
