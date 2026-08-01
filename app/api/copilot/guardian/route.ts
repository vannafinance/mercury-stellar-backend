/**
 * Server-side liquidation guardian (cron / Cloud Scheduler target).
 *
 * Single check — POST JSON:
 *   {
 *     "user_id": "…",
 *     "trader": "G…",
 *     "smart_account": "C…",   // optional
 *     "min_hf": 1.3,
 *     "dry_run": true
 *   }
 *
 * Batch (all opted-in targets) — POST { "batch": true, "dry_run": true }
 *   or GET ?batch=1&dry_run=1
 * Targets from env COPILOT_GUARDIAN_TARGETS JSON array:
 *   [{"trader":"G…","user_id":"…","min_hf":1.4,"smart_account":"C…"}]
 *
 * Auth: header `x-guardian-secret` = COPILOT_GUARDIAN_SECRET or CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { executeMcpWrite, mapOpToMcpStep } from "@/lib/copilot/mcp-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type GuardianTarget = {
  trader: string;
  user_id?: string;
  smart_account?: string | null;
  min_hf?: number;
};

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

function loadBatchTargets(): GuardianTarget[] {
  const raw = (process.env.COPILOT_GUARDIAN_TARGETS || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          trader: String(r.trader || "").trim(),
          user_id: r.user_id != null ? String(r.user_id) : r.userId != null ? String(r.userId) : undefined,
          smart_account:
            r.smart_account != null
              ? String(r.smart_account)
              : r.smartAccount != null
                ? String(r.smartAccount)
                : null,
          min_hf: n(r.min_hf ?? r.minHf) ?? undefined,
        };
      })
      .filter((t) => /^G[A-Z0-9]{55}$/.test(t.trader));
  } catch {
    return [];
  }
}

async function runOneCheck(opts: {
  trader: string;
  userId: string;
  smartAccount: string | null;
  minHf: number;
  dryRun: boolean;
}): Promise<Record<string, unknown>> {
  const { trader, userId, minHf, dryRun } = opts;
  let smartAccount = opts.smartAccount;
  const mcp = getMcpClient();

  if (!smartAccount || !/^C[A-Z0-9]{55}$/.test(smartAccount)) {
    const resolved = await mcp.call("vanna_resolve_account", { trader }, userId);
    smartAccount =
      (resolved.smart_account as string) ||
      (resolved.account as string) ||
      (resolved.margin_account as string) ||
      null;
  }
  if (!smartAccount) {
    return { ok: true, action: "none", reason: "no_smart_account", trader };
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
    return {
      ok: true,
      action: "none",
      reason: "no_material_debt",
      hf,
      debt,
      min_hf: minHf,
      smart_account: smartAccount,
      trader,
    };
  }
  if (hf == null || hf >= minHf) {
    return {
      ok: true,
      action: "none",
      reason: "above_floor",
      hf,
      debt,
      min_hf: minHf,
      smart_account: smartAccount,
      trader,
    };
  }

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
    bestAmt = Math.max(1, debt * 0.15);
    asset = "AQUSDC";
  }
  const repayAmt = Math.max(1, Math.min(bestAmt, bestAmt * 0.2));

  if (dryRun) {
    return {
      ok: true,
      action: "would_repay",
      dry_run: true,
      hf,
      min_hf: minHf,
      debt,
      repay: { asset, amount: repayAmt },
      smart_account: smartAccount,
      trader,
      message: `HF ${hf.toFixed(3)} < ${minHf} — would repay ~${repayAmt} ${asset}.`,
    };
  }

  const mapped = mapOpToMcpStep(
    "repay",
    { asset, amount: repayAmt },
    { trader, smartAccount },
  );
  if (mapped.blocker || !mapped.step) {
    return {
      ok: false,
      action: "repay_blocked",
      hf,
      trader,
      message: mapped.blocker || "Could not map repay.",
    };
  }

  const result = await executeMcpWrite(mcp, mapped.step, {
    trader,
    smartAccount,
    userId,
  });

  return {
    ok:
      result.status === "signed_and_submitted" ||
      result.status === "done" ||
      result.status === "built",
    action: "repay",
    hf,
    min_hf: minHf,
    debt,
    repay: { asset, amount: repayAmt },
    status: result.status,
    message: result.message,
    has_unsigned_xdr: result.mcp_trace?.has_unsigned_xdr,
    tx_hash:
      (result.submitted as { tx_hash?: string } | null)?.tx_hash ||
      (result.build?.tx_hash as string | undefined) ||
      null,
    smart_account: smartAccount,
    trader,
  };
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json(
      { error: "unauthorized", message: "Missing or invalid x-guardian-secret / CRON_SECRET." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const dryRun = body.dry_run === true || body.dryRun === true;
  const batch = body.batch === true;

  if (batch) {
    const targets = loadBatchTargets();
    if (!targets.length) {
      return NextResponse.json({
        ok: true,
        batch: true,
        count: 0,
        message:
          "No COPILOT_GUARDIAN_TARGETS configured. Set JSON array of {trader,user_id,min_hf}.",
        results: [],
      });
    }
    const results: Array<Record<string, unknown>> = [];
    for (const t of targets) {
      try {
        results.push(
          await runOneCheck({
            trader: t.trader,
            userId: t.user_id || t.trader,
            smartAccount: t.smart_account ?? null,
            minHf: t.min_hf ?? 1.3,
            dryRun,
          }),
        );
      } catch (e) {
        results.push({
          ok: false,
          trader: t.trader,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return NextResponse.json({ ok: true, batch: true, count: results.length, dry_run: dryRun, results });
  }

  const trader = String(body.trader || "").trim();
  const userId = String(body.user_id || body.userId || trader || "").trim();
  const smartAccount = String(body.smart_account || body.smartAccount || "").trim() || null;
  const minHf = n(body.min_hf ?? body.minHf) ?? 1.3;

  if (!trader || !/^G[A-Z0-9]{55}$/.test(trader)) {
    return NextResponse.json(
      { error: "invalid_input", message: "trader must be a G-address (or use batch:true)." },
      { status: 400 },
    );
  }

  try {
    const result = await runOneCheck({
      trader,
      userId,
      smartAccount,
      minHf,
      dryRun,
    });
    return NextResponse.json(result);
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

/** Health ping / batch via GET for simple schedulers */
export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const batch = req.nextUrl.searchParams.get("batch") === "1";
  const dryRun = req.nextUrl.searchParams.get("dry_run") !== "0";

  if (batch) {
    const targets = loadBatchTargets();
    const results: Array<Record<string, unknown>> = [];
    for (const t of targets) {
      try {
        results.push(
          await runOneCheck({
            trader: t.trader,
            userId: t.user_id || t.trader,
            smartAccount: t.smart_account ?? null,
            minHf: t.min_hf ?? 1.3,
            dryRun,
          }),
        );
      } catch (e) {
        results.push({
          ok: false,
          trader: t.trader,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return NextResponse.json({ ok: true, batch: true, count: results.length, dry_run: dryRun, results });
  }

  return NextResponse.json({
    ok: true,
    service: "copilot-guardian",
    targets_configured: loadBatchTargets().length,
    hint: "POST {trader,min_hf} or POST {batch:true} with x-guardian-secret. GET ?batch=1&dry_run=1 for cron.",
  });
}
