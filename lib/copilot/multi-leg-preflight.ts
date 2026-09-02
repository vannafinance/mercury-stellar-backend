/**
 * Cheap pre-checks before MultiLegAgent spends MCP write round-trips.
 * Soft failures → still allow execution (MCP is authority).
 * Hard blockers → stop before any write.
 *
 * Trustline / faucet readiness for deposit+lend legs is enforced inside
 * runWrite via preflightAssetReadiness (auto-setup XDR). This file still
 * catches missing account + lend balance so we fail before the first hop.
 */

import type { MCPClient } from "./mcp-client";
import { preflightLend, validateLendParams } from "./mcp-write";
import {
  preflightAssetReadiness,
  readinessDisplayAsset,
} from "./asset-readiness";
import type { ExpandedWrite } from "./multi-leg-agent";

export type PreflightIssue = {
  severity: "block" | "warn";
  op: string;
  label: string;
  message: string;
};

/**
 * Run static + light live checks on expanded legs.
 * Does not invent balances. Network failure on balance read → warn only.
 *
 * Note: `needs_setup` (trustline/faucet XDR) is NOT a preflight block — runWrite
 * returns that as needs_wallet_sign so HostError #13 never occurs. Only hard
 * impossibilities (no wallet, insufficient after setup probe) block here.
 */
export async function preflightExpandedLegs(
  mcp: MCPClient,
  legs: ExpandedWrite[],
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
  },
): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const needsAccount = legs.some(
    (l) => !["lend", "redeem", "create_account"].includes(l.op),
  );

  if (needsAccount && !ctx.smartAccount && !ctx.trader) {
    issues.push({
      severity: "block",
      op: "account",
      label: "Margin account",
      message: "Connect a wallet and open a margin (smart) account before deposit/borrow/farm legs.",
    });
    return issues;
  }

  if (needsAccount && !ctx.smartAccount && ctx.trader) {
    issues.push({
      severity: "warn",
      op: "account",
      label: "Margin account",
      message:
        "No smart account bound yet — deposit/borrow/farm need a C-address. The agent will try to resolve one; open an account if this fails.",
    });
  }

  for (const leg of legs) {
    if (leg.amount == null || !(leg.amount > 0)) {
      // Amount clarify is handled in the runner; skip here.
      continue;
    }

    if (leg.op === "lend" || leg.op === "supply") {
      const staticBlock = validateLendParams({
        asset: leg.asset,
        amount: leg.amount,
        trader: ctx.trader,
      });
      if (staticBlock) {
        issues.push({
          severity: "block",
          op: leg.op,
          label: leg.label,
          message: staticBlock,
        });
        continue;
      }
      // Readiness first: missing trustline must become setup (via runWrite), not
      // a hard "insufficient balance" block from preflightLend on a 0 balance.
      let deferBalanceCheck = false;
      if (ctx.trader) {
        try {
          const ready = await preflightAssetReadiness({
            op: leg.op,
            asset: leg.asset,
            amount: leg.amount,
            trader: ctx.trader,
          });
          if (ready.status === "needs_setup") {
            deferBalanceCheck = true;
            issues.push({
              severity: "warn",
              op: leg.op,
              label: leg.label,
              message:
                `${readinessDisplayAsset(leg.asset)} needs a one-time trustline/faucet setup before “${leg.label}”. ` +
                `Copilot will ask you to sign that setup first.`,
            });
          } else if (ready.status === "blocked") {
            issues.push({
              severity: "block",
              op: leg.op,
              label: leg.label,
              message: ready.message,
            });
            continue;
          }
        } catch {
          /* best-effort */
        }
      }
      if (ctx.trader && !deferBalanceCheck) {
        const pf = await preflightLend(
          mcp,
          { asset: leg.asset, amount: leg.amount, trader: ctx.trader },
          ctx.userId,
        );
        if (!pf.ok) {
          issues.push({
            severity: "block",
            op: leg.op,
            label: leg.label,
            message: pf.blocker,
          });
        }
      }
      continue;
    }

    // Deposit wallet readiness — block only when setup is impossible.
    // needs_setup is deferred to runWrite so the user can sign changeTrust/faucet.
    if (leg.op === "deposit_collateral" && ctx.trader) {
      try {
        const ready = await preflightAssetReadiness({
          op: leg.op,
          asset: leg.asset,
          amount: leg.amount,
          trader: ctx.trader,
        });
        if (ready.status === "blocked") {
          issues.push({
            severity: "block",
            op: leg.op,
            label: leg.label,
            message: ready.message,
          });
        } else if (ready.status === "needs_setup") {
          issues.push({
            severity: "warn",
            op: leg.op,
            label: leg.label,
            message:
              `${readinessDisplayAsset(leg.asset)} needs a one-time trustline/faucet setup before “${leg.label}”. ` +
              `Copilot will ask you to sign that setup first.`,
          });
        }
      } catch {
        /* best-effort */
      }
    }

    if (
      (leg.op === "deposit_collateral" || leg.op === "borrow" || leg.op === "supply_to_blend") &&
      !ctx.smartAccount &&
      !ctx.trader
    ) {
      issues.push({
        severity: "block",
        op: leg.op,
        label: leg.label,
        message: `“${leg.label}” needs a connected wallet and margin account.`,
      });
    }
  }

  // Dedupe identical messages
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.severity}:${i.op}:${i.message.slice(0, 80)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
