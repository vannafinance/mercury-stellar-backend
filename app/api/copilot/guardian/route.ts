/**
 * Server-side liquidation guardian (cron / Cloud Scheduler target).
 *
 * POST JSON:
 *   {
 *     "user_id": "…",           // WorkOS / app user id (for MCP)
 *     "trader": "G…",           // wallet
 *     "smart_account": "C…",    // optional; resolved if missing
 *     "min_hf": 1.3,            // floor (default 1.3)
 *     "dry_run": true           // if true, only report — no repay
 *   }
 *
 * Auth: header `x-guardian-secret` must match env COPILOT_GUARDIAN_SECRET
 * (or CRON_SECRET). Without secret, returns 401.
 *
 * When HF < min_hf and debt exists, builds a repay via MCP (largest debt line
 * or ~15% of total debt). Auto-sign must already be enabled on the wallet for
 * silent submit; otherwise returns needs_wallet_sign / needs_auto_sign.
 *
 * This is the 24/7 path (tab can be closed). Client tab guardian remains as a
 * faster in-session backup when auto-approve is on.
 */

import { NextRequest, NextResponse } from "next/server";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { executeMcpWrite, mapOpToMcpStep } from "@/lib/copilot/mcp-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function n(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

function authOk(req: NextRequest): boolean {
  const secret = (process.env.COPILOT_GUARDIAN_SECRET || process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const hdr = req.headers.get("x-guardian-secret") || req.headers.get("authorization") || "";
  if (hdr === secret) return true;
  if (hdr.toLowerCase().startsWith("bearer ") && hdr.slice(7).trim() === secret) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json(
      { error: "unauthorized", message: "Missing or invalid x-guardian-secret / CRON_SECRET." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const trader = String(body.trader || "").trim();
  const userId = String(body.user_id || body.userId || trader || "").trim();
  let smartAccount = String(body.smart_account || body.smartAccount || "").trim() || null;
  const minHf = n(body.min_hf ?? body.minHf) ?? 1.3;
  const dryRun = body.dry_run === true || body.dryRun === true;

  if (!trader || !/^G[A-Z0-9]{55}$/.test(trader)) {
    return NextResponse.json(
      { error: "invalid_input", message: "trader must be a G-address." },
      { status: 400 },
    );
  }

  const mcp = getMcpClient();

  try {
    if (!smartAccount || !/^C[A-Z0-9]{55}$/.test(smartAccount)) {
      const resolved = await mcp.call("vanna_resolve_account", { trader }, userId);
      smartAccount =
        (resolved.smart_account as string) ||
        (resolved.account as string) ||
        (resolved.margin_account as string) ||
        null;
    }
    if (!smartAccount) {
      return NextResponse.json({
        ok: true,
        action: "none",
        reason: "no_smart_account",
        trader,
      });
    }

    const health = await mcp.call(
      "vanna_get_account_health",
      { smart_account: smartAccount, trader },
      userId,
    );
    const collateral =
      n(health.collateral_usd) ??
      n(health.total_collateral_usd) ??
      n(health.gross_collateral_usd) ??
      0;
    const debt = n(health.debt_usd) ?? n(health.total_debt_usd) ?? 0;
    const lt = n(health.liquidation_threshold) ?? 0.9;
    let hf = n(health.health_factor) ?? n(health.hf) ?? n(health.avg_health_factor);
    if (hf == null && debt > 0 && collateral > 0) hf = (collateral * lt) / debt;

    if (debt < 0.5) {
      return NextResponse.json({
        ok: true,
        action: "none",
        reason: "no_material_debt",
        hf,
        debt,
        min_hf: minHf,
        smart_account: smartAccount,
      });
    }
    if (hf == null || hf >= minHf) {
      return NextResponse.json({
        ok: true,
        action: "none",
        reason: "above_floor",
        hf,
        debt,
        min_hf: minHf,
        smart_account: smartAccount,
      });
    }

    // Pick repay size: ~20% of debt value as human USDC-family amount (best-effort).
    // Prefer AQUSDC/USDC debt symbols when present in health payload.
    let asset = "USDC";
    const debtRows = Array.isArray(health.debt)
      ? (health.debt as Array<Record<string, unknown>>)
      : Array.isArray(health.debts)
        ? (health.debts as Array<Record<string, unknown>>)
        : [];
    let bestAmt = 0;
    for (const row of debtRows) {
      const sym = String(row.symbol || row.asset || "").toUpperCase();
      const amt = n(row.amount_human) ?? n(row.amount) ?? n(row.balance) ?? 0;
      if (sym && amt > bestAmt) {
        bestAmt = amt;
        asset = sym === "BLUSDC" ? "USDC" : sym;
      }
    }
    if (bestAmt <= 0) {
      // Fall back: repay ~15% of debt USD as AQUSDC units (≈1:1 on testnet stand-in).
      bestAmt = Math.max(1, debt * 0.15);
      asset = "AQUSDC";
    }
    const repayAmt = Math.max(1, Math.min(bestAmt, bestAmt * 0.2));

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        action: "would_repay",
        dry_run: true,
        hf,
        min_hf: minHf,
        debt,
        repay: { asset, amount: repayAmt },
        smart_account: smartAccount,
        message: `HF ${hf.toFixed(3)} < ${minHf} — would repay ~${repayAmt} ${asset}.`,
      });
    }

    const mapped = mapOpToMcpStep(
      "repay",
      { asset, amount: repayAmt },
      { trader, smartAccount },
    );
    if (mapped.blocker || !mapped.step) {
      return NextResponse.json({
        ok: false,
        action: "repay_blocked",
        hf,
        message: mapped.blocker || "Could not map repay.",
      });
    }

    const result = await executeMcpWrite(mcp, mapped.step, {
      trader,
      smartAccount,
      userId,
    });

    return NextResponse.json({
      ok: result.status === "signed_and_submitted" || result.status === "done" || result.status === "built",
      action: "repay",
      hf,
      min_hf: minHf,
      debt,
      repay: { asset, amount: repayAmt },
      status: result.status,
      message: result.message,
      has_unsigned_xdr: result.mcp_trace?.has_unsigned_xdr,
      tx_hash: (result.submitted as { tx_hash?: string } | null)?.tx_hash || result.build?.tx_hash || null,
      smart_account: smartAccount,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "guardian_failed",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

/** Health ping for schedulers */
export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    service: "copilot-guardian",
    hint: "POST trader + min_hf + x-guardian-secret to run a check.",
  });
}
