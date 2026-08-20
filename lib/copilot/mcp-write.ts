/**
 * Map copilot write ops → live MCP tools, then optionally auto-sign via Sign Service.
 *
 * Risk / HF / caps are enforced by MCP + Sign Service — not by this layer.
 */

import { isUnfundedWalletError, unfundedWalletMessage } from "@/lib/errors/normalize";
import {
  classifyTrustlineFailure,
  isTrustlineMissingError,
} from "./asset-readiness";
import { cleanExecutionCopy, humanizeStroopCounts } from "./execution-copy";
import type { MCPClient } from "./mcp-client";
import type { AccountCtx } from "./tool-args";
import { earnPoolSymbols, resolveAssetDef } from "./registry/assets";

/**
 * Earn pool symbols, from the registry rather than from a doc.
 *
 * The previous list was transcribed from a spec PDF and carried alias spellings
 * (AQUARIUS_USDC, SOROSWAP_USDC) that `earnPoolSymbol` had already normalised away, so
 * half of it was unreachable. The registry's claim is checked against a recorded
 * `pool_stats` probe per symbol — see tests/lib/asset-registry.test.ts.
 */
export const EARN_POOL_SYMBOLS: readonly string[] = earnPoolSymbols();

/** Minimum human amount we'll attempt to lend (reject dust / zero / negative). */
const MIN_LEND_AMOUNT = 1e-6;

export interface WriteStep {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export interface McpWriteResult {
  tool: string;
  label: string;
  build: Record<string, unknown>;
  unsigned_xdr?: string | null;
  submitted?: Record<string, unknown> | null;
  status:
    | "built"
    | "signed_and_submitted"
    | "needs_auto_sign"
    | "needs_wallet_sign"
    | "rejected"
    | "error"
    | "done";
  message: string;
  /** SS spend-cap: stage for wallet, but in-app auto-approve must not silent-sign. */
  forbid_session_sign?: boolean;
  /** Always set so the UI can prove MCP was used */
  mcp_trace: {
    tool: string;
    simulation_success?: boolean;
    auto_sign?: string | null;
    auto_sign_error?: string | null;
    has_unsigned_xdr: boolean;
  };
}

function pickXdr(data: Record<string, unknown>): string | null {
  for (const k of ["unsigned_xdr", "xdr", "envelope_xdr", "transaction"]) {
    const v = data[k];
    if (typeof v === "string" && v.length > 20) return v;
  }
  return null;
}

function looksG(a?: string | null): a is string {
  return !!a && /^G[A-Z0-9]{55}$/.test(a);
}
function looksC(a?: string | null): a is string {
  return !!a && /^C[A-Z0-9]{55}$/.test(a);
}

/**
 * Three distinct testnet USDC SACs (post 2026-07-19 rewire). They are NOT
 * interchangeable — users must pick one. Plain "USDC" is ambiguous.
 */
export const USDC_VARIANT_OPTIONS = [
  {
    id: "BLUSDC",
    label: "BLUSDC (Blend USDC)",
    description:
      "Blend-side USDC — earn Blend USDC pool; margin uses MCP symbol USDC for this token",
  },
  {
    id: "AQUSDC",
    label: "AQUSDC",
    description: "Aquarius USDC — earn AqUSDC pool + Aquarius margin collateral",
  },
  {
    id: "SOUSDC",
    label: "SOUSDC",
    description: "Soroswap USDC — earn SoUSDC pool + Soroswap margin collateral",
  },
] as const;

export type UsdcVariantId = (typeof USDC_VARIANT_OPTIONS)[number]["id"];

/**
 * True when the user said bare USDC without naming BLUSDC / AQUSDC / SOUSDC.
 *
 * Deliberately an EXACT match on the normalised string rather than a substring scan:
 * "USDC pool" and "USDCX" are not the ambiguous form, and treating them as such would
 * pop a variant prompt on text that names no token at all.
 */
export function needsUsdcVariant(asset?: string | null): boolean {
  if (asset == null || String(asset).trim() === "") return false;
  const a = String(asset).toUpperCase().replace(/\s+/g, "");
  // A concrete asset — including every variant spelling — is never ambiguous.
  if (resolveAssetDef(a)) return false;
  return a === "USDC";
}

/**
 * Which asset slot — if any — is genuinely ambiguous and may prompt for a variant.
 *
 * The gate used to be `needsUsdcVariant(action.asset)`, one slot for an action that has
 * two. A levered write carries collateral AND loan, and they are ambiguous
 * independently: "deposit 500 AQUSDC and borrow XLM" names both concretely, yet the
 * single-slot check saw a borrow leg that had inherited the string "USDC" from a
 * default and asked which USDC the user meant — about a token the user never mentioned.
 *
 * Returns null when nothing is ambiguous, which is the answer for every message that
 * names a concrete token: AQUSDC, BLUSDC, SOUSDC, XLM, AQUA. Only bare "USDC" prompts.
 */
export function ambiguousUsdcSlot(action: {
  asset?: string | null;
  borrow_asset?: string | null;
}): "collateral" | "borrow" | null {
  if (needsUsdcVariant(action.asset)) return "collateral";
  if (needsUsdcVariant(action.borrow_asset)) return "borrow";
  return null;
}

const USDC_VARIANT_BULLETS: Record<UsdcVariantId, string> = {
  BLUSDC: "• BLUSDC — Blend USDC (most common for Vanna earn / Blend farm)",
  AQUSDC: "• AQUSDC — Aquarius USDC",
  SOUSDC: "• SOUSDC — Soroswap USDC",
};

/**
 * Every USDC-naming write used to get the same three-way list regardless of what it
 * actually supports. Reported live: "swap 10 XLM to USDC" offered BLUSDC as one of the
 * three choices, even though `mapOpToMcpStep`'s own swap case (above) explicitly
 * refuses BLUSDC — "Blend USDC is not a DEX token. Neither venue trades it" — so picking
 * it would only bounce back with a second, contradicting message. A swap can only ever
 * settle in whichever variant its venue trades: AQUSDC on Aquarius, SOUSDC on Soroswap.
 * `variants` narrows the list to what the calling write can actually accept; every
 * non-swap caller keeps the full three.
 */
export function usdcVariantClarifyMessage(
  context: string,
  variants: readonly UsdcVariantId[] = USDC_VARIANT_OPTIONS.map((o) => o.id),
): string {
  const count = variants.length === 3 ? "three separate tokens" : `${variants.length} separate tokens`;
  return (
    `Which USDC do you mean for ${context}? On this testnet there are ${count} ` +
    `(not interchangeable):\n` +
    variants.map((v) => USDC_VARIANT_BULLETS[v]).join("\n") +
    `\n` +
    `Pick one below (or type e.g. “${context === "the swap" ? "swap 10 XLM to " + variants[0] : "lend 10 " + variants[0]}”).`
  );
}

/**
 * The symbol the margin contract wants for this asset.
 *
 * Not cosmetic: the contract REJECTS the string "BLUSDC" and accepts "USDC" for the
 * same token (verified in chain-facts.json, allowed=false / true). An unknown symbol
 * passes through unchanged so the protocol — not this function — gets to refuse it.
 * Call needsUsdcVariant() first when the user only said "USDC".
 */
export function marginCollateralSymbol(asset?: string | null): string {
  const a = (asset || "").toUpperCase();
  if (!a) return "USDC";
  return resolveAssetDef(a)?.marginSymbol ?? a;
}

/** Human label for UI (keep BLUSDC when user picked Blend USDC). */
export function displayUsdcLabel(mcpSymbol: string, userPick?: string | null): string {
  const u = (userPick || "").toUpperCase();
  if (u === "BLUSDC" || u === "BLEND_USDC") return "BLUSDC";
  if (mcpSymbol === "USDC" && (!userPick || u === "USDC")) return "USDC (Blend)";
  return mcpSymbol;
}

/**
 * Leverage split (industry standard for “Nx position”):
 *
 *   equity / deposit = D
 *   total position   ≈ D × L
 *   borrow           = D × (L − 1)
 *
 * Examples:
 *   2× → deposit 20, borrow 20  (total 40, equity 20 → 2×)
 *   3× → deposit 20, borrow 40  (total 60, equity 20 → 3×)
 *
 * This is NOT “borrow = L × deposit” (that would be ~3× total if L=2).
 *
 * @param maxBorrowOverDeposit Optional extra cap as multiple of deposit
 *   (e.g. 0.8 = never borrow more than 0.8×D). Default null = no extra cap;
 *   protocol can_borrow still enforces risk. Do not use 1.0 thinking it means
 *   “full leverage” — that wrongly caps 3× down to borrow=D.
 */
export function splitLeverageAmounts(
  deposit: number,
  leverage?: number | null,
  borrowExplicit?: number | null,
  maxBorrowOverDeposit: number | null = null,
): { deposit: number; borrow: number } {
  if (borrowExplicit != null && borrowExplicit > 0) {
    return { deposit, borrow: borrowExplicit };
  }
  const lev = leverage != null && leverage > 1 ? leverage : 2;
  let borrow = deposit * (lev - 1);
  if (maxBorrowOverDeposit != null && maxBorrowOverDeposit > 0) {
    borrow = Math.min(borrow, deposit * maxBorrowOverDeposit);
  }
  return { deposit, borrow };
}

/** One-line human explanation of the leverage split for copilot messages. */
export function formatLeveragePlanLine(
  deposit: number,
  borrow: number,
  leverage: number | null | undefined,
  assetLabel: string,
): string {
  const L = leverage != null && leverage > 1 ? leverage : 2;
  const total = deposit + borrow;
  return (
    `${L}× means total position ≈ ${total} ${assetLabel} on ${deposit} ${assetLabel} equity ` +
    `(deposit ${deposit} + borrow ${borrow} = ${L}×, not borrow ${deposit * L}).`
  );
}

/**
 * The symbol the earn pool wants for this asset.
 *
 * BLUSDC and USDC are one pool — a live pool_stats read returns identical rates for
 * both, which is what makes the alias a fact rather than an assumption.
 */
export function earnPoolSymbol(asset?: string | null): string {
  const a = (asset || "USDC").toUpperCase();
  return resolveAssetDef(a)?.earnSymbol ?? a;
}

function isSupportedEarnSymbol(symbol: string): boolean {
  return !!resolveAssetDef(symbol)?.earnSymbol || needsUsdcVariant(symbol);
}

/**
 * Parse wallet balance for a lend symbol from vanna_get_wallet_balance.
 * USDC earn uses the BLUSDC SAC on this deploy — plain USDC is not resolvable.
 */
export function walletBalanceForEarn(
  walletData: Record<string, unknown>,
  symbol: string,
): { balance: number; symbolUsed: string; lines: string[] } {
  const want = earnPoolSymbol(symbol).toUpperCase();
  // Prefer exact match; for USDC also accept BLUSDC (and show both if present).
  const candidates =
    want === "USDC" || want === "BLUSDC"
      ? ["BLUSDC", "USDC"]
      : want === "XLM"
        ? ["XLM", "XLM_SAC"]
        : [want];

  const assets = Array.isArray(walletData.assets) ? (walletData.assets as Record<string, unknown>[]) : [];
  const lines: string[] = [];
  let best = 0;
  let symbolUsed = want;

  for (const row of assets) {
    const sym = String(row.symbol || "").toUpperCase();
    const status = String(row.status || "");
    const bal =
      typeof row.balance === "number"
        ? row.balance
        : typeof row.balance === "string"
          ? Number(row.balance)
          : NaN;
    if (status === "ok" && Number.isFinite(bal)) {
      lines.push(`${sym}: ${bal}`);
    }
    if (candidates.includes(sym) && status === "ok" && Number.isFinite(bal) && bal > best) {
      best = bal;
      symbolUsed = sym === "XLM_SAC" ? "XLM" : sym;
    }
  }
  return { balance: best, symbolUsed, lines };
}

/**
 * Static lend checks (no network): amount, dust, unsupported asset.
 * Returns a user-facing blocker or null if OK to proceed to balance preflight.
 */
export function validateLendParams(params: {
  asset?: string | null;
  amount?: number | null;
  trader?: string | null;
}): string | null {
  // Validate the REQUEST before demanding a wallet. Whether "20 DOGE" or "-5 USDC"
  // makes sense has nothing to do with being connected, and checking the wallet
  // first meant every malformed ask came back as "Connect your wallet to lend",
  // hiding the actual reason (Sanujit EW8 / EW10).
  const symbol = earnPoolSymbol(params.asset);
  if (!isSupportedEarnSymbol(symbol)) {
    return (
      `“${(params.asset || "").toUpperCase() || "that asset"}” is not a Vanna earn pool. ` +
      `Supported: XLM, USDC (BLUSDC), AQUSDC, SOUSDC.`
    );
  }
  const amt = params.amount;
  const amountGiven = amt != null && typeof amt === "number" && Number.isFinite(amt);
  if (amountGiven && amt <= 0) {
    return `Amount must be positive — “${amt}” is not valid. e.g. “supply 10 ${symbol}”.`;
  }
  if (amountGiven && amt <= MIN_LEND_AMOUNT) {
    return (
      `That amount (${amt} ${symbol}) is dust — at or below the minimum ${MIN_LEND_AMOUNT}. ` +
      `Try a larger figure, e.g. “supply 1 ${symbol}”.`
    );
  }

  // Request is coherent; now it needs a wallet to go anywhere.
  if (!looksG(params.trader)) return "Connect your wallet to lend into an earn pool.";

  return null; // a missing amount is handled separately (that reply carries live APY)
}

/**
 * Live preflight before vanna_lend: quote wallet balance and block over-balance
 * (Sanujit EW6: "Blocked with the actual wallet balance quoted. No unsigned tx").
 */
export async function preflightLend(
  mcp: MCPClient,
  params: { asset?: string | null; amount: number; trader: string },
  userId?: string,
): Promise<{ ok: true; poolSymbol: string; balance: number } | { ok: false; blocker: string }> {
  const staticBlock = validateLendParams({ ...params, trader: params.trader });
  if (staticBlock) return { ok: false, blocker: staticBlock };

  const poolSymbol = earnPoolSymbol(params.asset);
  // MCP accepts USDC as alias; keep that for the tool call.
  const toolSymbol = poolSymbol === "BLUSDC" ? "USDC" : poolSymbol;

  try {
    const wallet = await mcp.call("vanna_get_wallet_balance", { g_address: params.trader }, userId);
    const { balance, symbolUsed, lines } = walletBalanceForEarn(wallet, poolSymbol);
    if (params.amount > balance + 1e-9) {
      const feeNote =
        poolSymbol === "XLM" || symbolUsed === "XLM"
          ? ` Leave ~${wallet.fee_reserve_xlm ?? "0.5"} XLM free for fees.`
          : "";
      return {
        ok: false,
        blocker:
          `You asked to supply ${params.amount} ${toolSymbol}, but your wallet only has ` +
          `${balance} ${symbolUsed} available for that earn pool.${feeNote}\n` +
          (lines.length ? `Wallet lines: ${lines.slice(0, 6).join(" · ")}.` : "") +
          `\nNo transaction was built — try a smaller amount.`,
      };
    }
    return { ok: true, poolSymbol: toolSymbol, balance };
  } catch {
    // Balance read failed — still allow MCP lend; simulation will catch it.
    return { ok: true, poolSymbol: toolSymbol, balance: Number.POSITIVE_INFINITY };
  }
}

/**
 * Static asset/op mismatches that can NEVER succeed — independent of amount, balance,
 * leverage, or any live chain read. Exported so a proposed multi-leg PLAN can be
 * checked before it is even shown for approval, not only once execution reaches the
 * doomed leg — the exact same conditions `mapOpToMcpStep`'s own per-op blockers below
 * use, factored out here so the two can never disagree.
 *
 * Reported live: "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC" showed a
 * full 4-step "Approve & run" card, the user approved it, and only then did leg 1 turn
 * out to be impossible (BLUSDC cannot be swapped into on any AMM). A step whose
 * asset/op combination is statically impossible should refuse the whole plan upfront,
 * not offer it and fail one signature in.
 */
export function staticStepBlocker(
  op: string,
  params: { asset?: string | null; token_a?: string | null; token_b?: string | null },
): string | null {
  const norm = (s?: string | null) => (s || "").toUpperCase();
  if (op === "swap") {
    // Either side — "swap 10 BLUSDC to XLM" is exactly as impossible as "swap 10 XLM
    // to BLUSDC". BLEND_USDC is the registry's internal alias for the same token.
    const a = norm(params.token_a);
    const b = norm(params.token_b) || norm(params.asset);
    if (a === "BLUSDC" || a === "BLEND_USDC" || b === "BLUSDC" || b === "BLEND_USDC") {
      return (
        "BLUSDC is Blend USDC — it isn't traded on Aquarius or Soroswap, so I can't swap " +
        "into or out of it. Swap to AQUSDC (Aquarius) or SOUSDC (Soroswap) instead, or " +
        "say “USDC” and I'll use the venue's own USDC."
      );
    }
  }
  if (op === "add_liquidity") {
    const aRaw = norm(params.token_a);
    const bRaw = norm(params.token_b) || norm(params.asset);
    if (aRaw === "BLUSDC" || bRaw === "BLUSDC") {
      return (
        "BLUSDC is the Blend-side USDC SAC (margin MCP symbol “USDC” — valid collateral). " +
        "Aquarius AMM LP is a different pool that spends AQUSDC, not BLUSDC. " +
        "Options:\n" +
        "  • LP on Aquarius: “add 15 XLM and 5 AQUSDC to Aquarius XLM/USDC”\n" +
        "  • Or swap first: “swap 5 USDC to AQUSDC via aquarius” then add liquidity\n" +
        "  • Farm Blend with BLUSDC: “farm Blend at 2x with 20 BLUSDC” / “supply 20 BLUSDC to Blend”"
      );
    }
  }
  if (op === "remove_liquidity") {
    const bRaw = norm(params.token_b) || norm(params.asset);
    if (bRaw === "BLUSDC") {
      return (
        "BLUSDC is Blend USDC, not an Aquarius LP token. " +
        "For Aquarius use “remove half my liquidity from XLM/USDC” (AQUSDC pair) " +
        "or name AQUSDC/SOUSDC explicitly."
      );
    }
  }
  if (op === "deploy_to_blend" || op === "supply_to_blend" || op === "withdraw_from_blend") {
    // Same asset-compatibility check for supply AND withdraw — Blend only ever holds
    // XLM/USDC reserves either way. This used to be deploy/supply-only; the withdraw op
    // (added for issue #16's Blend-remove fix) had its own separate inline copy of this
    // exact check, the same "same rule, reimplemented twice" pattern this function exists
    // to prevent — consolidated here so a future Blend-family op only needs to be added
    // to the op list above, not given its own copy of the asset rule.
    const a = norm(params.asset);
    if (a === "AQUSDC" || a === "SOUSDC") {
      const venue = a === "SOUSDC" ? "Soroswap" : "Aquarius";
      const verb = op === "withdraw_from_blend" ? "withdrawn from" : "supplied to";
      return (
        `Blend only holds XLM and USDC (BLUSDC) reserves — ${a} is a different token and ` +
        `cannot be ${verb} Blend. ${op === "withdraw_from_blend" ? `It was never in Blend to begin with — check ${venue}` : `Add liquidity on ${venue} instead`}, or name BLUSDC/USDC/XLM ` +
        `for Blend.`
      );
    }
  }
  return null;
}

/** Map high-level op → MCP tool + args (real server schemas). */
export function mapOpToMcpStep(
  op: string,
  params: {
    asset?: string | null;
    amount?: number | null;
    deposit_amount?: number | null;
    borrow_amount?: number | null;
    leverage?: number | null;
    token_a?: string | null;
    token_b?: string | null;
    amount_a?: number | null;
    amount_b?: number | null;
    /** e.g. 0.5 for remove half LP */
    fraction?: number | null;
    /** aquarius | soroswap for DEX swap / LP */
    venue?: string | null;
    /** Swap: oracle-quoted expected out and min floor for MCP slippage check */
    expected_out?: number | string | null;
    min_out?: number | string | null;
    slippage_pct?: number | string | null;
    /** Resolved Registry blend pool C-address for deploy_to_blend. */
    blend_pool_address?: string | null;
    /** enable_auto_sign only — Sign Service policy caps. */
    use_default_caps?: boolean | null;
    max_per_tx_usd?: number | string | null;
    max_per_day_usd?: number | string | null;
  },
  ctx: AccountCtx,
): { step?: WriteStep; blocker?: string } {
  const trader = looksG(ctx.trader) ? ctx.trader : null;
  const smart = looksC(ctx.smartAccount) ? ctx.smartAccount : null;
  const symbol = (params.asset || "USDC").toUpperCase();
  const amount =
    params.amount != null && params.amount > 0 ? String(params.amount) : null;

  switch (op) {
    case "create_account":
    case "open_account": {
      if (!trader) return { blocker: "Connect your wallet (G-address) to create a smart account." };
      return {
        step: {
          tool: "vanna_open_account",
          args: { trader },
          label: "Create smart account",
        },
      };
    }
    case "lend":
    case "supply": {
      if (!trader) return { blocker: "Connect your wallet to lend." };
      const staticBlock = validateLendParams({
        asset: params.asset,
        amount: params.amount,
        trader,
      });
      if (staticBlock) return { blocker: staticBlock };
      if (!amount) {
        const a = earnPoolSymbol(params.asset);
        return {
          blocker:
            `How much ${a} do you want to supply to the Vanna earn pool? ` +
            `e.g. “lend 10 ${a}” or “supply 25 ${a}”.`,
        };
      }
      const toolSymbol = earnPoolSymbol(symbol);
      const uiLabel = displayUsdcLabel(toolSymbol, symbol);
      return {
        step: {
          tool: "vanna_lend",
          args: { symbol: toolSymbol, amount, lender: trader },
          label: `Deposit ${amount} ${uiLabel} in Lending Pool`,
        },
      };
    }
    case "redeem":
    case "withdraw_supply": {
      if (!trader) return { blocker: "Connect your wallet to redeem." };
      const args: Record<string, unknown> = { symbol, lender: trader };
      if (amount) args.amount = amount;
      else args.redeem_all = true;
      return {
        step: {
          tool: "vanna_redeem",
          args,
          label: amount ? `Redeem ${amount} ${symbol}` : `Redeem all ${symbol}`,
        },
      };
    }
    case "deposit_collateral": {
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to deposit collateral." };
      }
      if (!amount) return { blocker: "How much collateral? e.g. “deposit 5 XLM as collateral”." };
      const collSym = marginCollateralSymbol(symbol);
      const ui = displayUsdcLabel(collSym, symbol);
      return {
        step: {
          tool: "vanna_deposit_collateral",
          args: { smart_account: smart, symbol: collSym, amount, trader },
          label: `Deposit ${amount} ${ui} collateral`,
        },
      };
    }
    case "withdraw_collateral": {
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to withdraw collateral." };
      }
      if (!amount) return { blocker: "How much collateral to withdraw?" };
      const collSym = marginCollateralSymbol(symbol);
      const ui = displayUsdcLabel(collSym, symbol);
      return {
        step: {
          tool: "vanna_withdraw_collateral",
          args: { smart_account: smart, symbol: collSym, amount, trader },
          label: `Withdraw ${amount} ${ui} collateral`,
        },
      };
    }
    case "borrow": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to borrow." };
      if (!amount) return { blocker: "How much do you want to borrow?" };
      const borSym = marginCollateralSymbol(symbol);
      const ui = displayUsdcLabel(borSym, symbol);
      return {
        step: {
          tool: "vanna_borrow",
          args: { smart_account: smart, symbol: borSym, amount, trader },
          label: `Borrow ${amount} ${ui}`,
        },
      };
    }
    case "repay": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to repay." };
      if (!amount) return { blocker: "How much do you want to repay?" };
      const repSym = marginCollateralSymbol(symbol);
      const ui = displayUsdcLabel(repSym, symbol);
      return {
        step: {
          tool: "vanna_repay",
          args: { smart_account: smart, symbol: repSym, amount, trader },
          label: `Repay ${amount} ${ui}`,
        },
      };
    }
    case "add_liquidity": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to add LP." };
      const aRaw = (params.token_a || "XLM").toUpperCase();
      const bRaw = (params.token_b || params.asset || "AQUSDC").toUpperCase();
      const aa = params.amount_a ?? params.amount;
      const bb = params.amount_b;
      if (aa == null || !(aa > 0) || bb == null || !(bb > 0)) {
        return {
          blocker:
            "How much of each token? e.g. “add 20 XLM and 5 AQUSDC to Aquarius XLM/USDC”. " +
            "Aquarius LP needs free XLM + AQUSDC in the margin account. " +
            "BLUSDC is a different token (Blend USDC) — do not substitute.",
        };
      }
      // BLUSDC ≠ AQUSDC ≠ SOUSDC. Never silently map BLUSDC → AQUSDC.
      {
        const blocked = staticStepBlocker("add_liquidity", { token_a: aRaw, token_b: bRaw });
        if (blocked) return { blocker: blocked };
      }
      const isSouswap =
        aRaw === "SOUSDC" ||
        bRaw === "SOUSDC" ||
        aRaw === "SOROSWAP_USDC" ||
        bRaw === "SOROSWAP_USDC";
      // Bare USDC with Aquarius venue → AQUSDC; with Soroswap → SOUSDC.
      // Explicit AQUSDC / SOUSDC always win.
      let usdSym: string;
      if (aRaw === "AQUSDC" || bRaw === "AQUSDC" || aRaw === "AQUARIUS_USDC" || bRaw === "AQUARIUS_USDC") {
        usdSym = "AQUSDC";
      } else if (isSouswap) {
        usdSym = "SOUSDC";
      } else if (aRaw === "USDC" || bRaw === "USDC") {
        // Ambiguous bare USDC on LP — Aquarius is the default farm LP on testnet.
        usdSym = "AQUSDC";
      } else {
        usdSym = "AQUSDC";
      }
      const amountXlm = aRaw === "XLM" ? aa : bRaw === "XLM" ? bb : aa;
      const amountUsd = aRaw === "XLM" ? bb : bRaw === "XLM" ? aa : bb;
      return {
        step: {
          tool: "vanna_add_liquidity",
          args: {
            smart_account: smart,
            token_a: "XLM",
            token_b: usdSym,
            amount_a: String(amountXlm),
            amount_b: String(amountUsd),
            min_liquidity_out: "0",
            trader,
            venue: usdSym === "SOUSDC" ? "soroswap" : "aquarius",
          },
          label: `Add ${amountXlm} XLM + ${amountUsd} ${usdSym} LP`,
        },
      };
    }
    case "remove_liquidity": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to remove LP." };
      const bRaw = (params.token_b || params.asset || "AQUSDC").toUpperCase();
      {
        const blocked = staticStepBlocker("remove_liquidity", { token_b: bRaw });
        if (blocked) return { blocker: blocked };
      }
      const isSouswap = bRaw === "SOUSDC" || bRaw === "SOROSWAP_USDC";
      const usdSym = isSouswap ? "SOUSDC" : "AQUSDC";
      const frac =
        params.fraction != null && params.fraction > 0 && params.fraction <= 1
          ? params.fraction
          : null;
      const lpAmt =
        params.amount != null && params.amount > 0 ? String(params.amount) : null;
      if (!frac && !lpAmt) {
        return {
          blocker:
            "How much LP to remove? e.g. “remove half my liquidity from XLM/USDC” or “remove 10 LP from XLM/USDC”.",
        };
      }
      /**
       * MCP takes `liquidity` (a human string) or `remove_all` — it has never taken a
       * fraction.
       *
       * `fraction` / `share_fraction` were sent anyway, so "remove half my liquidity"
       * came back `invalid_input` and the copilot pasted MCP's own DEVELOPER guidance to
       * the user: "liquidity is required for a partial remove (human string, e.g.
       * liquidity="50")… Never pass raw share integers." That is API documentation, not an
       * answer.
       *
       * A full exit maps exactly onto `remove_all`. A PARTIAL share cannot be sized here —
       * it needs the live LP balance, which this pure mapping function has no way to read —
       * so it asks for a figure in the user's own terms instead of sending an argument the
       * server will reject.
       */
      if (frac != null && frac >= 1) {
        // Same wire-value fix as the partial-remove case below — see its own comment.
        const wireTokenBFull = usdSym === "AQUSDC" ? "USDC" : usdSym;
        return {
          step: {
            tool: "vanna_remove_liquidity",
            args: {
              smart_account: smart,
              token_a: "XLM",
              token_b: wireTokenBFull,
              remove_all: true,
              min_a: "0",
              min_b: "0",
              trader,
              venue: isSouswap ? "soroswap" : "aquarius",
            },
            label: `Remove all XLM/${usdSym} LP`,
          },
        };
      }
      if (frac != null && !lpAmt) {
        return {
          blocker:
            `I can't take a ${Math.round(frac * 100)}% slice of an LP position directly — the ` +
            `protocol removes either a specific number of LP tokens or the whole position. ` +
            `Tell me the LP amount (e.g. “remove 10 LP from XLM/${usdSym}”), or say “remove all ` +
            `my XLM/${usdSym} liquidity”.`,
        };
      }
      /**
       * Reported live and reproduced exactly: removing from the Aquarius XLM/AQUSDC
       * pool staged a card reading "LP BALANCE VERIFIED: no — No Aquarius LP tracking
       * symbol for XLM/AQUSDC (only XLM/USDC is tracked as AQ_XLM_USDC today)", and the
       * transaction it signed then landed SUCCESSFUL on-chain (confirmed on Stellar
       * Expert) while the account's real Aquarius LP balance was unchanged before and
       * after — a hard-reloaded Farm page showed the identical LP count, so this is not
       * display staleness. That MCP-side warning text is not in this repo, but its own
       * wording ("only XLM/USDC is tracked") says its tracking-symbol lookup wants the
       * bare, generic ticker for this leg, not the Aquarius-specific one — the exact
       * shape of bug this codebase has hit before in its OWN asset tables (see the
       * registry consolidation history), just on the MCP side this time. Soroswap's
       * SOUSDC removal does not show this warning, so only Aquarius's wire value is
       * changed here. `usdSym` still drives the venue pick, the display label, and
       * `staticStepBlocker` above (BLUSDC still refused) — only the ONE wire field the
       * suspected lookup reads is affected.
       */
      const wireTokenB = usdSym === "AQUSDC" ? "USDC" : usdSym;
      return {
        step: {
          tool: "vanna_remove_liquidity",
          args: {
            smart_account: smart,
            token_a: "XLM",
            token_b: wireTokenB,
            amount: lpAmt,
            liquidity: lpAmt,
            liquidity_amount: lpAmt,
            min_a: "0",
            min_b: "0",
            trader,
            venue: isSouswap ? "soroswap" : "aquarius",
          },
          label: `Remove ${lpAmt} XLM/${usdSym} LP`,
        },
      };
    }
    case "swap": {
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to swap. Create a margin account first." };
      }
      const tokenIn = (params.token_a || params.asset || "XLM").toUpperCase();
      const tokenOut = (params.token_b || "USDC").toUpperCase();
      // Read the RAW slot, not a defaulted one — defaulting first made "did the user name
      // a venue?" always true, so a named variant could never pick its own venue.
      const venueRaw = String(params.venue ?? "").toLowerCase();
      const venueStated = /soro|aqua/.test(venueRaw);
      let venue = venueRaw.includes("soro") ? "soroswap" : "aquarius";

      /**
       * A named USDC variant picks the venue — it must never be silently swapped for a
       * different token.
       *
       * `mapUsdForVenue` below rewrites ANY variant to the venue's own USDC, and the label
       * deliberately kept the USER's word. Live result of "swap 10 XLM to BLUSDC": a card
       * headed "Swap 10 XLM → BLUSDC (aquarius)" over a transaction that actually bought
       * **AQUSDC** — a different, non-interchangeable token, named correctly only in the
       * small print of the summary. That is the exact failure the USDC-variant work exists
       * to prevent, and it is worse here than a wrong prompt: the user gets the wrong asset
       * and the card tells them they got the right one.
       *
       * So: AQUSDC → Aquarius, SOUSDC → Soroswap, unless the user named a venue themselves.
       * Bare "USDC" still takes the venue's own variant, which is what the Trade page does.
       */
      const namesVariant = (t: string) => t === "AQUSDC" || t === "SOUSDC" || t === "BLUSDC";
      const stated = [tokenIn, tokenOut].find(namesVariant) ?? null;
      if (stated && !venueStated) {
        if (stated === "AQUSDC") venue = "aquarius";
        else if (stated === "SOUSDC") venue = "soroswap";
      }
      /**
       * Blend USDC is not a DEX token. Neither venue trades it, so any "swap … to BLUSDC"
       * could only ever be filled with a different token — refuse and name the two that
       * are real, rather than quietly substituting one.
       */
      if (stated === "BLUSDC") {
        const blocked = staticStepBlocker("swap", { token_a: tokenIn, token_b: tokenOut });
        if (blocked) return { blocker: blocked };
      }
      if (stated && venueStated) {
        const venueSym = venue === "soroswap" ? "SOUSDC" : "AQUSDC";
        if (stated !== venueSym) {
          return {
            blocker:
              `${stated} isn't traded on ${venue} — that venue uses ${venueSym}. ` +
              `Ask for ${venueSym} on ${venue}, or name the venue that matches ${stated}.`,
          };
        }
      }
      if (!amount || !(Number(amount) > 0)) {
        return {
          blocker:
            `How much ${tokenIn} do you want to swap? ` +
            `e.g. “swap 10 XLM to USDC via aquarius” or “swap 5 USDC to XLM on soroswap”.`,
        };
      }
      // Website Trade/Swap: XLM ↔ USDC, venue Aquarius or Soroswap.
      // Map UI variants to the venue's USDC SAC (same as one-click-strategy).
      const mapUsdForVenue = (t: string): string => {
        if (t === "XLM" || t === "AQUA") return t;
        if (venue === "soroswap") {
          if (t === "SOUSDC" || t === "USDC" || t === "BLUSDC" || t === "AQUSDC") return "SOUSDC";
        } else {
          // Aquarius DEX uses AQUSDC
          if (t === "AQUSDC" || t === "USDC" || t === "BLUSDC" || t === "SOUSDC") return "AQUSDC";
        }
        return t === "BLUSDC" ? "USDC" : t;
      };
      const inSym = mapUsdForVenue(tokenIn);
      const outSym = mapUsdForVenue(tokenOut);
      if (inSym === outSym) {
        return { blocker: `Cannot swap ${tokenIn} to itself on ${venue} — pick XLM ↔ USDC.` };
      }
      /**
       * The label names the token that will actually be traded.
       *
       * It used to echo the user's own word while the wire carried a different symbol, so
       * a swap into AQUSDC could be presented as a swap into BLUSDC. A label is the last
       * thing the user reads before signing — when it disagrees with the transaction, the
       * transaction wins and the label is simply a false statement.
       */
      const uiIn = inSym;
      const uiOut = outSym;
      // Prefer expected_out from copilot pre-quote; if omitted, MCP auto-quotes
      // from oracle (after MCP redeploy of swap auto-quote).
      const expectedOut =
        params.expected_out != null && Number(params.expected_out) > 0
          ? String(params.expected_out)
          : null;
      const minOut =
        params.min_out != null && Number(params.min_out) > 0 ? String(params.min_out) : null;
      const slip =
        params.slippage_pct != null && Number(params.slippage_pct) > 0
          ? String(params.slippage_pct)
          : "0.5";
      return {
        step: {
          tool: "vanna_swap",
          args: {
            smart_account: smart,
            token_in: inSym,
            token_out: outSym,
            amount_in: amount,
            ...(expectedOut ? { expected_out: expectedOut } : {}),
            ...(minOut ? { min_out: minOut } : {}),
            slippage_pct: slip,
            trader,
            venue,
            protocol: venue,
          },
          label: expectedOut
            ? `Swap ${amount} ${uiIn} → ${Number(expectedOut).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${uiOut} (${venue})`
            : `Swap ${amount} ${uiIn} → ${uiOut} (${venue})`,
        },
      };
    }
    case "deposit_and_borrow": {
      // Prefer sequential deposit → borrow (see runWrite). Combined MCP tool is kept
      // only as an explicit atomic fallback; its pre-flight ignores same-tx deposit.
      if (!trader || !smart) return { blocker: "Need wallet + smart account." };
      const dep = params.deposit_amount ?? params.amount;
      if (dep == null || dep <= 0) return { blocker: "How much to deposit for the leveraged position?" };
      const { borrow: bor } = splitLeverageAmounts(dep, params.leverage, params.borrow_amount);
      const collSym = marginCollateralSymbol(symbol);
      return {
        step: {
          tool: "vanna_deposit_and_borrow",
          args: {
            smart_account: smart,
            deposit_amount: String(dep),
            borrow_amount: String(bor),
            symbol: collSym,
            trader,
          },
          label: `Deposit ${dep} + borrow ${bor} ${collSym}`,
        },
      };
    }
    case "deploy_to_blend":
    case "supply_to_blend": {
      // Farm write via consolidated MCP vanna_farm_blend.
      // FW1 plain supply → action=supply (legacy name vanna_blend_supply).
      // Levered farm → action=deploy (legacy name vanna_deploy_to_blend).
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to supply to Blend. Create a margin account first." };
      }
      const dep = params.deposit_amount ?? params.amount;
      if (dep == null || dep <= 0) {
        return { blocker: "How much do you want to supply to Blend? e.g. “supply 10 XLM to Blend”." };
      }
      /**
       * Blend reserves are XLM or USDC (BLUSDC) ONLY — AQUSDC and SOUSDC are distinct,
       * non-interchangeable SACs for the Aquarius and Soroswap AMMs, not Blend deposits.
       *
       * This used to silently COERCE any of AQUSDC/SOUSDC/anything-unrecognised into
       * "USDC"/"XLM" and supply THAT to Blend instead — live result: a plan resumed after
       * a swap-destination clarify with "SOUSDC" (because BLUSDC itself can't be swapped
       * into) silently supplied real BLUSDC/USDC to Blend, when the user's actual intent
       * (having just swapped into SOUSDC) could only ever have been Soroswap LP. Refusing
       * here — the same pattern the swap and add_liquidity branches in this file already
       * use for exactly this asset confusion — stops money moving into a venue nobody
       * asked for; asking "how much XLM/USDC to Blend?" cannot fix a wrong-venue deposit
       * after the fact.
       */
      const blendCompatible =
        symbol === "BLUSDC" || symbol === "USDC" || symbol === "BLEND_USDC" || symbol === "XLM";
      if (!blendCompatible) {
        const blocked =
          staticStepBlocker(op, { asset: symbol }) ??
          // Fallback for any OTHER unrecognised symbol reaching this point (AQUSDC/SOUSDC
          // are staticStepBlocker's named cases; this only fires for the unexpected rest).
          `Blend only holds XLM and USDC (BLUSDC) reserves — ${symbol} is a different token and ` +
            `cannot be supplied to Blend.`;
        return { blocker: blocked };
      }
      const blendSym = symbol === "XLM" ? "XLM" : "USDC";
      const uiSym = displayUsdcLabel(blendSym, symbol);
      let bor = 0;
      if (params.borrow_amount != null && params.borrow_amount > 0) {
        bor = params.borrow_amount;
      } else if (params.leverage != null && params.leverage > 1) {
        bor = splitLeverageAmounts(dep, params.leverage, null).borrow;
      }
      const leveraged = bor > 0;
      if (!leveraged) {
        // Prefer the simple farm_blend supply path (no deposit_borrow_and_deploy packing).
        // Tokens must already be free inside the margin account (C-address), not only wallet.
        return {
          step: {
            tool: "vanna_blend_supply",
            args: {
              smart_account: smart,
              symbol: blendSym,
              amount: String(dep),
              trader,
            },
            label: `Supply ${dep} ${uiSym} to Blend`,
          },
        };
      }
      const blendPool = params.blend_pool_address;
      if (!blendPool || !looksC(blendPool)) {
        return {
          blocker:
            "Blend pool address is not configured yet — resolve it from the Registry first.",
        };
      }
      return {
        step: {
          tool: "vanna_deploy_to_blend",
          args: {
            smart_account: smart,
            deposit_amount: String(dep),
            borrow_amount: String(bor),
            // Accept both token_symbol and symbol — MCP farm_blend deploy packing.
            token_symbol: blendSym,
            symbol: blendSym,
            blend_pool_address: blendPool,
            pool_address: blendPool,
            blend_tokens_in: [blendSym],
            blend_tokens_out: [blendSym],
            blend_amounts_in: [String(dep + bor)],
            blend_amounts_out_min: ["0"],
            trader,
          },
          label: `Deploy ${dep} + borrow ${bor} ${uiSym} to Blend (~${params.leverage ?? "n"}×)`,
        },
      };
    }
    case "withdraw_from_blend": {
      // Farm write via the same consolidated MCP vanna_farm_blend dispatcher the supply
      // case above uses, action=withdraw (registered alias `vanna_blend_withdraw`,
      // mcp-client.ts) — the underlying on-chain capability already exists
      // (BlendService.withdrawFromBlendPool, used by the Farm page's own Remove panel);
      // it was simply never reachable from the router before this case existed.
      if (!trader || !smart) {
        return { blocker: "Need wallet + smart account to withdraw from Blend. Create a margin account first." };
      }
      const amt = params.amount;
      if (amt == null || amt <= 0) {
        return { blocker: "How much do you want to withdraw from Blend? e.g. “remove 10 XLM from Blend”." };
      }
      // Same asset restriction as supply — Blend only ever holds XLM/USDC reserves, so
      // AQUSDC/SOUSDC (Aquarius/Soroswap-only tokens) were never in it to withdraw.
      const blendCompatible =
        symbol === "BLUSDC" || symbol === "USDC" || symbol === "BLEND_USDC" || symbol === "XLM";
      if (!blendCompatible) {
        const blocked =
          staticStepBlocker(op, { asset: symbol }) ??
          `Blend only holds XLM and USDC (BLUSDC) reserves — ${symbol} is a different token and ` +
            `was never supplied to Blend.`;
        return { blocker: blocked };
      }
      const blendSym = symbol === "XLM" ? "XLM" : "USDC";
      const uiSym = displayUsdcLabel(blendSym, symbol);
      return {
        step: {
          tool: "vanna_blend_withdraw",
          args: {
            smart_account: smart,
            symbol: blendSym,
            amount: String(amt),
            trader,
          },
          label: `Withdraw ${amt} ${uiSym} from Blend`,
        },
      };
    }
    case "settle_account": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to settle." };
      return {
        step: {
          tool: "vanna_settle_account",
          args: { smart_account: smart, trader },
          label: "Settle account",
        },
      };
    }
    case "close_account": {
      if (!trader || !smart) return { blocker: "Need wallet + smart account to close." };
      return {
        step: {
          tool: "vanna_close_account",
          args: { smart_account: smart, trader },
          label: "Close smart account",
        },
      };
    }
    case "enable_auto_sign": {
      if (!trader) return { blocker: "Connect your wallet to enable auto-sign." };
      return {
        step: {
          tool: "vanna_enable_auto_sign",
          args: {
            wallet_address: trader,
            user_id: trader,
            ...(params.use_default_caps != null ? { use_default_caps: params.use_default_caps } : {}),
            ...(params.max_per_tx_usd != null ? { max_per_tx_usd: params.max_per_tx_usd } : {}),
            ...(params.max_per_day_usd != null ? { max_per_day_usd: params.max_per_day_usd } : {}),
          },
          label: "Enable auto-sign",
        },
      };
    }
    case "disable_auto_sign": {
      if (!trader) return { blocker: "Connect your wallet." };
      return {
        step: {
          tool: "vanna_disable_auto_sign",
          args: { wallet_address: trader },
          label: "Disable auto-sign",
        },
      };
    }
    default:
      return { blocker: `Write op “${op}” is not mapped to an MCP tool yet.` };
  }
}

/**
 * Contract-level WAD integer → human units, as a string (no BigInt: the project
 * targets below ES2020, so BigInt literals don't compile).
 */
function wadToHuman(raw: string): string {
  const whole = raw.length > 18 ? raw.slice(0, raw.length - 18) : "0";
  const frac = raw.slice(Math.max(0, raw.length - 18)).padStart(18, "0").replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * MCP surfaces raw WAD integers in its own error text — "deposit_and_borrow of
 * 20000000000000000000 USDC …" — because that's the value it hands the contract.
 * Rewrite those runs into human units so the user reads "20 USDC". Only 19+ digit
 * runs are touched: real WAD amounts are that long, while ledger numbers (~7) and
 * unix timestamps (10–13) are not, so addresses and IDs are left alone.
 */
function humanizeWadAmounts(message: string): string {
  return message.replace(/\b\d{19,}\b/g, (raw) => wadToHuman(raw));
}

/**
 * Does this MCP error represent the deterministic risk gate saying no, rather than
 * something being broken?
 *
 * `health_check_failed` is the MCP server's own taxonomy for "account LTV is too
 * high for this operation" (mcp_server/error_handling.py), raised by the
 * `is_borrow_allowed` pre-flight before any XDR is built. It's a policy decision,
 * so it belongs in the UI's blocked/risk-gate state — surfacing it as a generic
 * error made a working safety check look like a crash.
 */
function isRiskRejection(build: Record<string, unknown>): boolean {
  const code = String(build.error ?? "").toLowerCase();
  const msg = String(build.message ?? "");
  return (
    code === "health_check_failed" ||
    code === "unhealthy_account" ||
    /rejected by risk engine pre-flight|risk engine|ltv is too high|health factor/i.test(msg)
  );
}

/**
 * Turn raw MCP simulation dumps (Contract #3 balance failures, WAD amounts) into
 * a short plain-English note so the UI does not dump the full diagnostic log.
 */
export function humanizeMcpWriteError(
  build: Record<string, unknown>,
  tool: string,
  ctx?: { asset?: string | null; trader?: string | null },
): string {
  const code = String(build.error ?? build.reason ?? "").toLowerCase();
  const asset = ctx?.asset ?? null;
  const raw = humanizeStroopCounts(
    humanizeWadAmounts(String(build.message || build.error || build.reason || "MCP write failed")),
    asset,
  );

  // Checked before everything else: an unfunded wallet fails inside the RPC's
  // account lookup, so MCP reports it as `contract_error` / `simulation_failed`
  // and it would otherwise be swallowed by the simulation branch below and
  // printed as a raw diagnostic dump.
  if (isUnfundedWalletError(raw)) {
    return unfundedWalletMessage(
      tool === "vanna_open_account" ? "open your margin account" : undefined,
    );
  }

  // Fallback only — preflightAssetReadiness should prevent these. Never dump HostError #13.
  //
  // `classifyTrustlineFailure` is itself asset-aware (`${asset} is not ready...`), but this
  // call site never passed one, so every trustline fallback read "XLM is not ready in your
  // wallet" regardless of which asset actually hit HostError #13 — seen live on "borrow 2000
  // BLUSDC" / "borrow 1k BLUSDC" / "borrow 1,000 BLUSDC", all reported as an XLM problem.
  if (isTrustlineMissingError(raw)) {
    return classifyTrustlineFailure(raw, { tool, asset: ctx?.asset ?? null, trader: ctx?.trader ?? null }).message;
  }

  if (code === "collateral_not_allowed" || /not accepted as collateral/i.test(raw)) {
    const allowed = Array.isArray(build.allowed_collateral)
      ? (build.allowed_collateral as string[]).join(", ")
      : "XLM, USDC, AQUSDC, SOUSDC";
    return (
      `That token is not accepted as margin collateral on this deployment. ` +
      `Allowed: ${allowed}. ` +
      `(Tip: Blend USDC is MCP symbol “USDC” — pick BLUSDC in the UI and we map it.)`
    );
  }

  // Contract #3 on lend almost always means insufficient token balance.
  if (
    code === "simulation_failed" ||
    code === "simulation_rejected" ||
    /simulation failed|simulation rejected|hosterror|contract error|#3|error\(contract,\s*#3\)/i.test(raw)
  ) {
    if (tool === "vanna_deploy_to_blend" || tool === "vanna_blend_supply") {
      const firstLine = raw.split(/\n/)[0]?.slice(0, 220) || raw.slice(0, 220);
      const zeroAmount =
        /\[Deposit\].*\[0\]|amount:\s*0|amount_type:\s*0.*amount:\s*0|\[XLM\],\s*\[0\]/i.test(raw);
      if (zeroAmount || /#1216|error\(contract,\s*#1216\)/i.test(raw)) {
        return (
          `Blend farm write failed — MCP/on-chain packed a zero Blend amount ` +
          `(execute_direct shows [Deposit] … [0]).\n\n` +
          `Escalate to MCP: vanna_farm_blend supply/deploy packing. ` +
          `No transaction was submitted.\n\nDetail: ${firstLine}`
        );
      }
      if (/Budget|ExceededLimit|resource/i.test(raw)) {
        if (tool === "vanna_deploy_to_blend") {
          return (
            `Blend levered deploy hit the Soroban CPU budget (ExceededLimit). ` +
            `Use the split plan instead: “farm Blend at 2x with 20 BLUSDC” ` +
            `(deposit → borrow → supply as separate txs).\n\nDetail: ${firstLine}`
          );
        }
        return (
          `Blend supply simulation hit the Soroban CPU budget (ExceededLimit) on this pool. ` +
          `Plain supply from free C-balance can still fail under load. ` +
          `Safer path for wallet XLM/USDC: lend to the Vanna earn pool instead ` +
          `(“lend 20 XLM” or “invest 20 XLM where yield is highest” without forcing farm). ` +
          `For levered farm: “farm Blend at 2x with 20 BLUSDC”.\n\nDetail: ${firstLine}`
        );
      }
      if (/balance is not sufficient|#10|insufficient/i.test(raw)) {
        return (
          `Blend supply needs free balance inside the margin account (C-address).\n` +
          `After a borrow, only the net amount is spendable (~0.3% origination fee is deducted) — ` +
          `supplying the gross borrow size fails on-chain.\n` +
          `Copilot sizes the supply to free balance automatically — retry the supply leg.\n\n` +
          `Detail: ${firstLine}`
        );
      }
      return (
        `Blend farm simulation failed (not a margin collateral deposit).\n` +
        `${firstLine}\n\n` +
        `Need free balance of that asset inside the margin account (C-address), not only the wallet. ` +
        `Try: deposit 20+ as collateral, borrow some free, then “supply N to Blend”. ` +
        `No transaction was submitted.`
      );
    }
    if (tool === "vanna_add_liquidity" || tool === "vanna_remove_liquidity") {
      const firstLine = raw.split(/\n/)[0]?.slice(0, 220) || raw.slice(0, 220);
      if (/balance is not sufficient|#10|insufficient/i.test(raw)) {
        return (
          `LP needs free XLM + the matching USDC variant inside the margin account (C-address).\n` +
          `• Aquarius pair → free XLM + AQUSDC (not BLUSDC)\n` +
          `• Soroswap pair → free XLM + SOUSDC\n\n` +
          `Prep (amounts ≥ 15):\n` +
          `  1) deposit 25 XLM as collateral\n` +
          `  2) deposit 25 AQUSDC as collateral\n` +
          `  3) borrow 15 XLM and 5 AQUSDC (borrow creates free balance)\n` +
          `  4) “add 15 XLM and 5 AQUSDC to Aquarius XLM/USDC”\n\n` +
          `Detail: ${firstLine}`
        );
      }
      return `LP simulation failed: ${firstLine}`;
    }
    if (tool === "vanna_swap") {
      const firstLine = raw.split(/\n/)[0]?.slice(0, 220) || raw.slice(0, 220);
      return (
        `Swap simulation failed. Need free balance of the input token inside the margin account.\n` +
        `${firstLine}`
      );
    }
    if (tool === "vanna_lend") {
      // Try to extract balance from diagnostic: balance], data:9150000000 (7-dec SAC)
      const balMatch = raw.match(/balance\],\s*data:(\d+)/i);
      let balanceHint = "";
      if (balMatch) {
        const rawBal = balMatch[1];
        // Prefer 7-dec (BLUSDC/XLM SAC); fall back to 6-dec display.
        const as7 = Number(rawBal) / 1e7;
        const as6 = Number(rawBal) / 1e6;
        const human =
          Number.isFinite(as7) && as7 < 1e9
            ? as7.toLocaleString("en-US", { maximumFractionDigits: 7 })
            : as6.toLocaleString("en-US", { maximumFractionDigits: 6 });
        balanceHint = ` On-chain wallet balance seen in the sim: ~${human}.`;
      }
      return (
        `Earn supply failed simulation — usually **insufficient wallet balance** for that amount ` +
        `(or the token needs trustline/approval).${balanceHint}\n\n` +
        `No transaction was submitted. Check your wallet balance and try a smaller amount ` +
        `(earn uses XLM or BLUSDC/USDC-family SACs — not plain circle USDC on this testnet).`
      );
    }
    if (tool === "vanna_repay") {
      const firstLine = raw.split(/\n/)[0]?.slice(0, 220) || raw.slice(0, 220);
      return (
        `Margin repay simulation failed. Repay spends free balance **inside the margin account** ` +
        `(C-address), not only what your G-wallet shows as Available.\n\n` +
        `Debt can be larger than free balance because of accrued interest — the Margin page ` +
        `caps repay at spendable and can top up from the wallet; Copilot caps the same way. ` +
        `If free balance is ~0, use Margin → Repay Loan → Pay Now, or free up that token in the account first.\n\n` +
        `Detail: ${firstLine}`
      );
    }
    /**
     * Withdraw trips a budget error in SIMULATION that does not mean the withdraw fails.
     *
     * `MarginAccountService.withdrawCollateralBalance` (lib/margin-utils.ts) treats a
     * budget-class simulation error on `withdraw_collateral_balance` as expected: it
     * logs it, skips the failed prepare, submits the original envelope, and the
     * transaction goes through. That is the behaviour behind the Margin page's Withdraw
     * button, and it is why the site can do something the copilot reports as impossible.
     *
     * The copilot cannot copy that trick through MCP — MCP simulates before it returns
     * an XDR, so a failed simulation means no envelope comes back to submit. Reporting a
     * bare "Simulation failed: HostError: Error(Budget, ExceededLimit)" is therefore
     * doubly wrong: it reads as "your withdraw is impossible" when the same withdraw
     * works from the Margin page one click away.
     */
    if (tool === "vanna_withdraw_collateral" && /Budget|ExceededLimit|resource/i.test(raw)) {
      return (
        `The withdraw hit a Soroban CPU budget limit while MCP was simulating it. That is a ` +
        `simulation limit, not a refusal — the risk engine did not block this withdraw.\n\n` +
        `The Margin page expects this on withdraws and submits anyway, so use Margin → ` +
        `Withdraw for this one and it should go through. A smaller amount, or withdrawing ` +
        `one token at a time, also tends to fit inside the budget here.\n\n` +
        `Nothing was submitted and your collateral is unchanged.`
      );
    }
    // Truncate huge event logs for other tools
    const firstLine = raw.split(/\n/)[0]?.slice(0, 280) || raw.slice(0, 280);
    return `Simulation failed: ${firstLine}`;
  }

  // Cap very long messages
  if (raw.length > 600) return raw.slice(0, 600) + "…";
  return raw;
}

/**
 * Why a risk rejection happened, when the tool makes the reason predictable.
 *
 * `vanna_deposit_and_borrow`'s pre-flight is `is_borrow_allowed(symbol,
 * borrow_amount, smart_account)` (vanna_core/contracts/account_manager.py) — and it
 * runs against the account's CURRENT on-chain state, before the deposit leg of the
 * same atomic call is credited. An account with little or no existing collateral is
 * therefore rejected no matter how large the deposit leg is, which reads as "the
 * copilot is broken" rather than "this combo needs collateral first". Splitting the
 * legs is the working route today.
 */
function rejectionGuidance(tool: string): string {
  if (tool === "vanna_deposit_and_borrow") {
    return (
      "\n\nThe borrow leg is checked against the collateral your account holds " +
      "*before* this transaction, so a combined deposit-and-borrow is refused while " +
      "your collateral is still too low — the deposit in the same call isn't counted " +
      "yet. Deposit the collateral first, then borrow against it as a second step."
    );
  }
  return "";
}

function traceOf(tool: string, build: Record<string, unknown>, xdr?: string | null) {
  return {
    tool,
    simulation_success: build.simulation_success === true || build.simulation_success === "true",
    auto_sign: build.auto_sign != null ? String(build.auto_sign) : null,
    auto_sign_error: build.auto_sign_error != null ? String(build.auto_sign_error) : null,
    has_unsigned_xdr: !!(xdr || pickXdr(build)),
  };
}

/**
 * Build via MCP write tool. Prefer MCP's own auto_sign attempt (many write tools
 * already try Sign Service and return auto_sign / auto_sign_error).
 *
 * Only call vanna_sign_and_submit if XDR exists and MCP has not already reported
 * auto_sign outcome.
 */
/**
 * One sentence for every "MCP built it, the Sign Service did not sign it" outcome.
 *
 * Manual signing is the DEFAULT, so why auto-sign did not happen is not news — it is the
 * setting the user is on. Six call sites each narrated their own version of it ("Vanna is
 * not authorized as a Sign Service signer for this wallet…", "Sign Service has no active
 * session…", and a couple that interpolated the raw reason code), which put signing
 * internals in front of someone who only wanted to approve a deposit.
 *
 * The reason is not lost — it stays on `mcp_trace.auto_sign_error` and in the server log.
 */
function readyToSignMessage(_label: string): string {
  // The card's own headline is the label, so repeating it here says it twice in a row.
  return "Built and ready — approve to sign it with your wallet.";
}

export async function executeMcpWrite(
  mcp: MCPClient,
  step: WriteStep,
  ctx: AccountCtx & { userId: string },
): Promise<McpWriteResult> {
  let build: Record<string, unknown>;
  try {
    build = await mcp.call(step.tool, step.args, ctx.userId);
  } catch (e) {
    // MCP can report the same failure either as a structured error field (handled
    // by humanizeMcpWriteError below) or as an isError result that mcp-client
    // rethrows — so the unfunded-wallet check has to sit on both paths.
    const thrown = e instanceof Error ? e.message : String(e);
    return {
      tool: step.tool,
      label: step.label,
      build: {},
      status: "error",
      message: isUnfundedWalletError(thrown)
        ? unfundedWalletMessage(
            step.tool === "vanna_open_account" ? "open your margin account" : undefined,
          )
        : thrown,
      mcp_trace: {
        tool: step.tool,
        has_unsigned_xdr: false,
        auto_sign: null,
        auto_sign_error: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const xdr = pickXdr(build);
  const baseTrace = traceOf(step.tool, build, xdr);

  // Tool already finished on-chain (e.g. open_account with Sign Service)
  if (
    build.status === "signed_and_submitted" ||
    build.tx_hash ||
    build.submitted === true ||
    build.on_chain === true ||
    build.auto_sign === "submitted" ||
    build.auto_sign === "signed_and_submitted"
  ) {
    const hash = (build.tx_hash as string) || null;
    // Prefer short chat copy — MCP often returns a Sign Service paragraph with
    // full hash + explorer URL; the UI already shows those in dedicated rows.
    const { body } = cleanExecutionCopy({
      label: step.label,
      status: "signed_and_submitted",
      rawMessage: (build.summary as string) || (build.message as string) || null,
      txHash: hash,
    });
    return {
      tool: step.tool,
      label: step.label,
      build,
      submitted: build,
      status: "signed_and_submitted",
      message: body,
      mcp_trace: baseTrace,
    };
  }

  // False "done" without XDR or hash (seen on farm_blend supply) — treat as error.
  if (
    !xdr &&
    !build.tx_hash &&
    !build.error &&
    (build.status === "done" || build.status === "ok" || build.ok === true) &&
    step.tool.startsWith("vanna_") &&
    /lend|redeem|deposit|borrow|repay|blend|liquidity|deploy|withdraw|supply/i.test(step.tool + step.label)
  ) {
    // Only accept bare "done" for non-fund tools (enable_auto_sign etc.)
    if (!/enable_auto_sign|disable_auto_sign|resolve|list_/i.test(step.tool)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        status: "error",
        message:
          `${step.label} returned no transaction and no tx hash from MCP. ` +
          `Nothing was submitted — try again, or check margin-account balances for farm writes.`,
        mcp_trace: baseTrace,
      };
    }
  }

  // Treat simulation_failed / invalid_input even when nested under reason/code.
  const errCode = String(build.error ?? build.reason ?? build.code ?? "").toLowerCase();
  const errMsg = String(build.message ?? "");
  const softFail =
    !!build.error ||
    build.status === "error" ||
    errCode === "simulation_failed" ||
    errCode === "simulation_rejected" ||
    errCode === "invalid_input" ||
    errCode === "collateral_not_allowed" ||
    /simulation failed|simulation rejected|not accepted as collateral|invalid_input/i.test(errMsg + errCode);

  /**
   * The Sign Service declining to auto-sign is NOT a failed transaction.
   *
   * These refusals arrive as a top-level `build.error` with `auto_sign` and
   * `auto_sign_error` both null, so they never reached the auto-sign branches further
   * down — they fell into `softFail` above and were reported as `error`, throwing away
   * the XDR MCP had already built and simulated in the same response.
   *
   * Live effect (owner-reported, reproduced 2026-08-10 on a fresh wallet): "create a
   * margin account for me" worked with auto-approve ON and failed with it OFF — which is
   * the default for every new user. The card showed `wallet_not_bound` and MCP's internal
   * plumbing prose, with no Approve & sign button, while a perfectly signable transaction
   * sat unused in the same payload.
   *
   * Manual signing is the DEFAULT path, not a fallback. So whenever an XDR exists, the
   * refusal to AUTO-sign it is not an error to report — it is the ordinary way through.
   *
   * Matched on the error CODE only. The prose is MCP's and varies; the code is the
   * contract, and matching prose would misread a genuine simulation failure that happens
   * to mention signing.
   */
  /**
   * A genuine Sign Service POLICY rejection (spend cap, allowlist, session identity) is
   * not the same class of thing as the infrastructure refusals below — those mean "the
   * plumbing isn't set up yet, ask the human to sign instead"; this means "this tx must
   * not be signed by anyone right now". `function_not_allowlisted` used to sit in the
   * `autoSignRefused` regex just below, alongside `wallet_not_bound` — an easy mistake
   * since both come back as `auto_sign` refusals, but one is "you haven't connected"
   * and the other is "this call is not permitted". See the block below for the live
   * repro (`over_per_tx_cap`) that exposed this: staged as `needs_wallet_sign`, then
   * auto-signed anyway by the client's own embedded session key, bypassing a cap the
   * Sign Service had already refused twice.
   */
  const policyReason = String(build.reason ?? "").toLowerCase();
  const isGenuinePolicyRejection =
    String(build.auto_sign ?? "").toLowerCase() === "rejected" &&
    /^(over_per_tx_cap|over_daily_cap|contract_not_allowlisted|function_not_allowlisted|source_mismatch|op_source_mismatch|amount_undecodable|session_expired|session_not_active|unauthorized)$/.test(
      policyReason,
    );
  if (isGenuinePolicyRejection) {
    const asset = String(step.args?.symbol ?? step.args?.asset ?? "");
    const detail = humanizeStroopCounts(
      String(build.detail ?? build.auto_sign_error ?? build.message ?? ""),
      asset || null,
    );
    const spendCap = policyReason === "over_daily_cap" || policyReason === "over_per_tx_cap";
    if (spendCap && xdr) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        status: "needs_wallet_sign",
        forbid_session_sign: true,
        message:
          (policyReason === "over_daily_cap"
            ? "Daily auto-sign cap reached. "
            : "Per-transaction auto-sign cap reached. ") +
          detail +
          " Approve & sign in your wallet to submit this step — wallet signing is not limited by that cap.",
        mcp_trace: { ...baseTrace, auto_sign_error: policyReason },
      };
    }
    return {
      tool: step.tool,
      label: step.label,
      build,
      status: "rejected",
      message:
        `The Sign Service refused to sign this (policy: ${policyReason}). Nothing was signed. ` +
        (detail || "Lower the size, or check the account's spend caps."),
      mcp_trace: { ...baseTrace, auto_sign_error: policyReason },
    };
  }

  const autoSignRefused =
    !!xdr &&
    /wallet_not_bound|no_active_session|auto_sign|not_enabled|missing_user_assertion|invalid_user_assertion/i.test(
      errCode,
    );
  if (autoSignRefused) {
    return {
      tool: step.tool,
      label: step.label,
      build,
      unsigned_xdr: xdr,
      status: "needs_wallet_sign",
      message: readyToSignMessage(step.label),
      mcp_trace: { ...baseTrace, auto_sign_error: errCode },
    };
  }

  if (softFail) {
    const risk = isRiskRejection(build);
    const base = humanizeMcpWriteError(
      { ...build, error: build.error ?? build.reason ?? "error", message: errMsg || errCode },
      step.tool,
      {
        asset: (step.args?.symbol as string) ?? (step.args?.asset as string) ?? null,
        trader: (step.args?.trader as string) ?? ctx.trader ?? null,
      },
    );
    return {
      tool: step.tool,
      label: step.label,
      build,
      status:
        risk ||
        /insufficient|simulation failed|simulation rejected|not accepted as collateral|invalid/i.test(base)
          ? "rejected"
          : "error",
      message: risk ? `${base}${rejectionGuidance(step.tool)}` : base,
      mcp_trace: baseTrace,
    };
  }

  // enable_auto_sign special shapes
  if (step.tool === "vanna_enable_auto_sign") {
    const st = String(build.status || "");
    if (st === "needs_confirmation") {
      return {
        tool: step.tool,
        label: step.label,
        build,
        status: "needs_auto_sign",
        message:
          (build.message as string) ||
          "Choose auto-sign limits: default $1000/tx & $1000/day, or set your own.",
        mcp_trace: baseTrace,
      };
    }
    if (st === "enabled" || build.enabled === true) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        status: "done",
        message: (build.summary as string) || "Auto-sign is enabled.",
        mcp_trace: baseTrace,
      };
    }
  }

  if (!xdr) {
    // Fund-affecting writes must return XDR or a hash — bare "done" is a false success
    // (seen on farm_blend supply with empty farm UI afterwards).
    const fundTool = /lend|redeem|deposit|borrow|repay|blend|liquidity|deploy|withdraw|supply|swap/i.test(
      step.tool + " " + step.label,
    );
    if (fundTool && !/enable_auto_sign|disable_auto_sign/i.test(step.tool)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        status: "error",
        message:
          `${step.label}: MCP returned no unsigned transaction and no tx hash. ` +
          `Nothing was signed or submitted. For Blend supply, confirm free balance inside the ` +
          `margin account (C-address), not only the wallet.`,
        mcp_trace: baseTrace,
      };
    }
    return {
      tool: step.tool,
      label: step.label,
      build,
      status: "done",
      message: cleanExecutionCopy({
        label: step.label,
        status: "done",
        rawMessage: (build.summary as string) || (build.message as string) || null,
      }).body,
      mcp_trace: baseTrace,
    };
  }

  // MCP already tried auto-sign on the write tool itself
  const as = String(build.auto_sign || "").toLowerCase();
  const asErr = String(build.auto_sign_error || build.message || "");

  if (as === "unavailable" || as === "failed" || as === "error" || build.auto_sign_error) {
    // invalid_user_assertion / Invalid token audience = server M2M cannot prove end-user identity
    if (/invalid_user_assertion|invalid token audience|user assertion|re-authenticate/i.test(asErr + as)) {
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        status: "needs_wallet_sign",
        // Kept to one line. The M2M-vs-user-assertion reason is our infrastructure
        // detail, not something the user can act on — and when session signing is on
        // the UI submits this without a click, so a paragraph about pressing approve
        // actively contradicts what they are about to see.
        message: "Built and simulated by MCP — it just needs your signature.",
        mcp_trace: baseTrace,
      };
    }
    if (/no_active_session|disabled|not.?enabled|wallet_not_bound/i.test(asErr + as)) {
      // Two different causes reach this branch and only one is "you never turned it
      // on". `wallet_not_bound` means Vanna has no authority to sign for this wallet
      // at all, so "enable auto-sign" understates what is being asked for — the
      // enable flow will then ask for the additional-signer consent (see
      // WalletBindPrompt). Naming it here keeps the two rails telling one story.
      //
      // When MCP already built XDR, return needs_wallet_sign — not needs_auto_sign.
      // App auto-approve is client session signing of that XDR; forcing the Sign
      // Service enable gate on hop 2+ made multi-leg ask for "auto-approve" again
      // even when the toggle was already on.
      return {
        tool: step.tool,
        label: step.label,
        build,
        unsigned_xdr: xdr,
        status: "needs_wallet_sign",
        message: readyToSignMessage(step.label),
        mcp_trace: { ...baseTrace, auto_sign_error: asErr || as || null },
      };
    }
    // Other auto-sign failures: still have XDR → wallet sign
    return {
      tool: step.tool,
      label: step.label,
      build,
      unsigned_xdr: xdr,
      status: "needs_wallet_sign",
      message: readyToSignMessage(step.label),
      mcp_trace: { ...baseTrace, auto_sign_error: asErr || as || null },
    };
  }

  // Manual signing is the default. Never call vanna_sign_and_submit from the
  // brain — that submitted single-leg writes while in-app auto-approve was OFF.
  // Auto-approve ON is client session-signing of this XDR, not a server submit.
  return {
    tool: step.tool,
    label: step.label,
    build,
    unsigned_xdr: xdr,
    status: "needs_wallet_sign",
    message: readyToSignMessage(step.label),
    mcp_trace: { ...baseTrace, auto_sign: "disabled" },
  };
}

/**
 * Enable Sign Service auto-sign.
 *
 * MCP `use_default_caps=true` must NOT also send max_per_tx_usd — the MCP server
 * then omits stroops so Sign Service applies its env defaults
 * (`DEFAULT_CAP_PER_TX` / `DEFAULT_CAP_PER_DAY`, testnet stand-in ≈ $1000 each).
 * Custom path sends only USD fields; if only per-tx is set, MCP mirrors it to day.
 */
export async function enableAutoSign(
  mcp: MCPClient,
  opts: {
    wallet: string;
    userId: string;
    useDefaultCaps?: boolean;
    maxPerTxUsd?: number | string;
    maxPerDayUsd?: number | string;
  },
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {
    wallet_address: opts.wallet,
    user_id: opts.userId || opts.wallet,
  };
  if (opts.useDefaultCaps) {
    args.use_default_caps = true;
  } else {
    if (opts.maxPerTxUsd != null) args.max_per_tx_usd = opts.maxPerTxUsd;
    if (opts.maxPerDayUsd != null) args.max_per_day_usd = opts.maxPerDayUsd;
  }
  return mcp.call("vanna_enable_auto_sign", args, opts.userId);
}

/** Read default_cap_usd from MCP needs_confirmation / enabled payloads (no hardcode). */
export function defaultCapUsdFromMcp(data: Record<string, unknown> | null | undefined): number {
  const n = Number(data?.default_cap_usd);
  if (Number.isFinite(n) && n > 0) return n;
  // Fallback only when MCP did not return the field (older deploy).
  const envN = Number(process.env.DEFAULT_AUTO_SIGN_CAP_USD || process.env.COPILOT_DEFAULT_AUTO_SIGN_CAP_USD);
  if (Number.isFinite(envN) && envN > 0) return envN;
  return 1000;
}
