import { OP_FLOW, type ReviewFundingPocket, type WorkflowOp, type WorkflowView } from "./workflow/types";
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

export interface ProjectedFundingRow {
  id: string;
  stepId: string;
  label: string;
  pocket: ReviewFundingPocket;
  asset: string;
  needed: number;
  available: number | null;
  projected: boolean;
}

/** Replay sealed steps in order, crediting earlier outputs before later spends. */
export function projectFundingRows(
  steps: WorkflowView["steps"],
  readBalance: (pocket: ReviewFundingPocket, asset: string) => number | null,
): ProjectedFundingRow[] {
  const projected = new Map<string, number | null>();
  const changed = new Set<string>();
  const rows: ProjectedFundingRow[] = [];
  const keyOf = (pocket: ReviewFundingPocket, asset: string) => `${pocket}:${asset}`;
  const balance = (pocket: ReviewFundingPocket, asset: string) => {
    const key = keyOf(pocket, asset);
    if (!projected.has(key)) projected.set(key, readBalance(pocket, asset));
    return projected.get(key) ?? null;
  };

  for (const step of steps) {
    const legacyPocket = spendPocket(step.op);
    const funding = step.funding ?? {
      spends: legacyPocket ? [{ pocket: legacyPocket, asset: step.asset, amount: step.amount }] : [],
      receives: [],
    };
    for (const movement of funding.spends) {
      const needed = Number(movement.amount);
      if (!Number.isFinite(needed) || needed < 0) continue;
      const key = keyOf(movement.pocket, movement.asset);
      const available = balance(movement.pocket, movement.asset);
      rows.push({
        id: `${step.id}:${key}`,
        stepId: step.id,
        label: step.label,
        pocket: movement.pocket,
        asset: movement.asset,
        needed,
        available,
        projected: changed.has(key),
      });
      if (available !== null) projected.set(key, available - needed);
      changed.add(key);
    }
    for (const movement of funding.receives) {
      const received = Number(movement.amount);
      if (!Number.isFinite(received) || received < 0) continue;
      const key = keyOf(movement.pocket, movement.asset);
      const available = balance(movement.pocket, movement.asset);
      if (available !== null) projected.set(key, available + received);
      changed.add(key);
    }
  }
  return rows;
}
