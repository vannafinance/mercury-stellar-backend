/**
 * In-process copilot brain.
 *
 * Architecture:
 *   Gemini (Vertex)  → understand intent / multi-step plan
 *   MCP server       → execute reads + builds + health/caps
 *   Sign Service     → auto-sign + submit (via vanna_sign_and_submit)
 *
 * No local HF/leverage policy gates. No Freighter "Approve & sign" path for
 * the happy path — if auto-sign is off, we ask the user to enable it.
 */

import { randomUUID } from "crypto";
import { copilotConfig, TEMPLATE_COUNT } from "./config";
import { explainRead, factsForUi } from "./explain";
import { getMcpClient, MCPAuthError, MCPCallError, MCPError } from "./mcp-client";
import {
  enableAutoSign,
  executeMcpWrite,
  mapOpToMcpStep,
  marginCollateralSymbol,
  displayUsdcLabel,
  preflightLend,
  earnPoolSymbol,
  splitLeverageAmounts,
  validateLendParams,
  needsUsdcVariant,
  usdcVariantClarifyMessage,
  USDC_VARIANT_OPTIONS,
} from "./mcp-write";
import { evaluateWriteRisk } from "./risk";
import { findUnsupportedAsset, routeMessage } from "./router";
import { buildToolArgs, needsSmartAccount } from "./tool-args";
import type {
  BrainHealth,
  ChatRequest,
  ChatResponse,
  CopilotAction,
  RoutedIntent,
  Simulation,
} from "./types";
import { vertexExplain, vertexSelectTool, VertexError } from "./vertex";

export function getBrainHealth(): BrainHealth {
  return {
    status: "ok",
    llm_provider: "vertex",
    mcp_mode: copilotConfig.mcpMode,
    templates: TEMPLATE_COUNT,
    in_process: true,
    execution_mode: "mcp+auto-sign",
  };
}

function newRequestId(): string {
  try {
    return randomUUID();
  } catch {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function looksLikeWallet(id: string): boolean {
  return /^G[A-Z0-9]{55}$/.test(id);
}

/** True when the router already resolved this to a Blend-venue read. */
function isBlendRead(routed: RoutedIntent): boolean {
  return (
    routed.kind === "read" &&
    (routed.tool === "vanna_list_blend_reserves" ||
      routed.tool === "vanna_get_blend_reserve_stats" ||
      routed.tool === "vanna_get_blend_position")
  );
}

export async function handleChat(req: ChatRequest): Promise<ChatResponse> {
  const request_id = newRequestId();
  const message = (req.message ?? "").trim();
  const userId = req.user_id || "guest";
  let smartAccount = req.smart_account ?? null;
  const trader = looksLikeWallet(userId) ? userId : null;
  const mcp = getMcpClient();

  // ── Auto-sign control actions (from UI buttons or NL) ───────────────────
  if (req.auto_sign?.action) {
    return handleAutoSignAction(req, request_id, trader, userId);
  }

  // ── Resume pending write after auto-sign enable ─────────────────────────
  if (req.pending_write?.op) {
    const action: CopilotAction = {
      op: req.pending_write.op,
      asset: req.pending_write.asset ?? null,
      amount: req.pending_write.amount ?? null,
      leverage: req.pending_write.leverage ?? null,
      requires_amount: req.pending_write.op !== "create_account",
      requires_account: !["create_account", "lend", "redeem"].includes(req.pending_write.op),
      smart_account: smartAccount,
      trader,
    };
    return runWrite(action, { userId, trader, smartAccount, request_id, message: message || action.op });
  }

  if (!message) {
    return { kind: "error", message: "Please type a question.", request_id };
  }

  // Quick NL auto-sign intents without Vertex
  const lower = message.toLowerCase();
  if (/\benable auto[- ]?sign\b|\bturn on auto[- ]?sign\b|\bauto[- ]?sign on\b/.test(lower)) {
    return handleAutoSignAction(
      { ...req, auto_sign: { action: "start" } },
      request_id,
      trader,
      userId,
    );
  }
  if (/\bdisable auto[- ]?sign\b|\bturn off auto[- ]?sign\b/.test(lower)) {
    return handleAutoSignAction(
      { ...req, auto_sign: { action: "disable" } },
      request_id,
      trader,
      userId,
    );
  }

  // ── Route intent (Vertex primary) ───────────────────────────────────────
  let routed: RoutedIntent;
  try {
    routed = await vertexSelectTool(message, { smartAccount, trader });
  } catch (e) {
    console.warn("[copilot] vertex route failed, keyword fallback:", e instanceof Error ? e.message : e);
    routed = routeMessage(message);
  }

  // Prefer deterministic keyword routes for Sanujit earn multi-pool / farm / lend
  // phrases — Vertex often collapses "list all earn pools", mis-routes highest-APY,
  // or maps "supply to Blend" onto deposit_collateral.
  {
    const unsupported = findUnsupportedAsset(message);
    if (
      unsupported &&
      /\b(lend|supply|earn|deposit|borrow|repay|farm)\b/i.test(message)
    ) {
      return {
        kind: "blocked",
        message:
          `“${unsupported}” is not supported on Vanna testnet. Use XLM, BLUSDC, AQUSDC, or SOUSDC ` +
          `(not bare USDC without a variant — pick BLUSDC / AQUSDC / SOUSDC when you mean a dollar token).`,
        intent: { template_id: "unsupported_asset", slots: { asset: unsupported } },
        request_id,
      };
    }
    const kw = routeMessage(message);
    const lowerMsg = message.toLowerCase();
    const blendWrite =
      /\bblend\b/.test(lowerMsg) &&
      /\b(supply|deposit|deploy|farm)\b/.test(lowerMsg) &&
      !/\b(stats|apy|position|btoken|how much)\b/.test(lowerMsg);
    const blendRead =
      /\bblend\b/.test(lowerMsg) &&
      !blendWrite &&
      /\b(stats|apy|reserve|pays|yield|supplied|position|btoken|how much)\b/.test(lowerMsg);

    /** Prefer explicit tickers in the message over nested "USDC" inside BLUSDC. */
    const assetFromMessage = (): string | null => {
      if (/\bblusdc\b|\bblend[_\s-]?usdc\b/i.test(message)) return "BLUSDC";
      if (/\baqusdc\b|\baquarius[_\s-]?usdc\b/i.test(message)) return "AQUSDC";
      if (/\bsousdc\b|\bsoroswap[_\s-]?usdc\b/i.test(message)) return "SOUSDC";
      if (/\bxlm\b/i.test(message)) return "XLM";
      return null;
    };

    if (kw.kind === "read" && kw.template_id === "query_all_earn_pools") {
      routed = kw;
    } else if (kw.kind === "write" && (kw.op === "add_liquidity" || kw.op === "remove_liquidity")) {
      // Aquarius LP must never become deposit_collateral (screenshot #32).
      routed = kw;
    } else if (kw.kind === "write" && (kw.op === "deploy_to_blend" || kw.op === "supply_to_blend")) {
      // Always honor keyword farm write; fix bare USDC when BLUSDC was named.
      const named = assetFromMessage();
      routed = {
        ...kw,
        asset:
          (named && named !== "USDC" ? named : null) ||
          (kw.asset && kw.asset !== "USDC" ? kw.asset : null) ||
          named ||
          kw.asset ||
          "XLM",
      };
    } else if (blendWrite) {
      // Force deploy_to_blend even if Vertex picked deposit_and_borrow / deposit_collateral.
      const fromKw = kw.kind === "write" ? kw : null;
      const assetFix =
        assetFromMessage() ||
        (fromKw?.asset && fromKw.asset !== "USDC" ? fromKw.asset : null) ||
        fromKw?.asset ||
        "XLM";
      routed = {
        kind: "write",
        op: "deploy_to_blend",
        template_id: "deploy_to_blend",
        asset: assetFix,
        amount: fromKw?.amount ?? null,
        multi_leg: true,
        requires_account: true,
        requires_amount: true,
        leverage: fromKw?.leverage ?? null,
      };
    } else if (
      // Vertex sometimes plans LP as deposit_collateral — override when Aquarius/LP named.
      /\b(aquarius|add liquidity|provide liquidity)\b/i.test(message) &&
      /\b(add|provide)\b/i.test(message) &&
      (routed.kind !== "write" || routed.op !== "add_liquidity")
    ) {
      if (kw.kind === "write" && kw.op === "add_liquidity") {
        routed = kw;
      } else {
        const dualMatch = message.match(
          /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b(?:\s+and\s+|\s*\+\s*)(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM)\b/i,
        );
        routed = {
          kind: "write",
          op: "add_liquidity",
          template_id: "add_liquidity",
          asset: dualMatch?.[4]?.toUpperCase() ?? "BLUSDC",
          amount: dualMatch ? Number(dualMatch[1]) : null,
          token_a: dualMatch?.[2]?.toUpperCase() ?? "XLM",
          token_b: dualMatch?.[4]?.toUpperCase() ?? "BLUSDC",
          amount_a: dualMatch ? Number(dualMatch[1]) : null,
          amount_b: dualMatch ? Number(dualMatch[3]) : null,
          multi_leg: true,
          requires_account: true,
          requires_amount: true,
        };
      }
    } else if (blendRead) {
      // Naming two reserves is a comparison — always list both (never single-symbol).
      const named = [
        /\bxlm\b/i.test(message) ? "XLM" : null,
        /\busdc\b/i.test(message) ? "USDC" : null,
      ].filter(Boolean) as string[];
      const compare =
        named.length > 1 ||
        /\b(vs|versus| or |compare|pays more|better than)\b/i.test(message);
      const sym = !compare && named.length === 1 ? named[0]! : null;
      const vertexOk = isBlendRead(routed) && !compare;
      if (!vertexOk) {
        if (/\b(supplied|position|btoken|how much)\b/i.test(message)) {
          routed = {
            kind: "read",
            tool: "vanna_get_blend_position",
            args: sym ? { symbol: sym } : {},
            requires_account: true,
            template_id: "query_blend_position",
          };
        } else {
          routed = {
            kind: "read",
            tool: sym ? "vanna_get_blend_reserve_stats" : "vanna_list_blend_reserves",
            args: sym ? { symbol: sym } : {},
            template_id: "query_blend",
          };
        }
      }
    } else if (
      kw.kind === "write" &&
      kw.op === "lend" &&
      (routed.kind !== "write" ||
        routed.op !== "lend" ||
        kw.template_id === "lend_highest" ||
        (kw.amount != null && (routed.amount == null || kw.amount < 0)))
    ) {
      routed = kw;
    }
  }

  // Normalize plan → execute first write/read or multi-step
  if (routed.kind === "plan") {
    return runPlan(routed, { userId, trader, smartAccount, request_id, message });
  }

  if (routed.kind === "clarify") {
    return {
      kind: "clarification",
      message: routed.message,
      intent: { template_id: routed.template_id ?? null },
      request_id,
    };
  }
  if (routed.kind === "restricted") {
    return {
      kind: "blocked",
      message: routed.reason,
      intent: { template_id: routed.template_id },
      request_id,
    };
  }
  if (routed.kind === "auto_sign") {
    return handleAutoSignAction(
      {
        ...req,
        auto_sign: {
          action: routed.action,
          max_per_tx_usd: routed.max_per_tx_usd,
          max_per_day_usd: routed.max_per_day_usd,
        },
      },
      request_id,
      trader,
      userId,
    );
  }

  // Resolve smart account when needed
  if (
    ((routed.kind === "read" && needsSmartAccount(routed.tool)) ||
      (routed.kind === "write" && routed.requires_account)) &&
    !smartAccount &&
    trader
  ) {
    smartAccount = await resolveSmartAccount(mcp, trader, userId);
  }

  if (routed.kind === "read") {
    return runRead(routed, { userId, trader, smartAccount, request_id, message });
  }

  if (routed.kind === "write") {
    const action: CopilotAction = {
      op: routed.op,
      asset: routed.asset ?? null,
      amount: routed.amount ?? null,
      leverage: routed.leverage ?? null,
      requires_amount: !!routed.requires_amount,
      requires_account: !!routed.requires_account,
      multi_leg: !!routed.multi_leg,
      smart_account: smartAccount,
      trader,
      token_a: routed.token_a ?? null,
      token_b: routed.token_b ?? null,
      amount_a: routed.amount_a ?? null,
      amount_b: routed.amount_b ?? null,
      fraction: routed.fraction ?? null,
    };
    return runWrite(action, { userId, trader, smartAccount, request_id, message });
  }

  return { kind: "error", message: "Unhandled intent.", request_id };
}

// ── Auto-sign ─────────────────────────────────────────────────────────────

async function handleAutoSignAction(
  req: ChatRequest,
  request_id: string,
  trader: string | null,
  userId: string,
): Promise<ChatResponse> {
  if (!trader) {
    return {
      kind: "clarification",
      message: "Connect your Stellar wallet first, then enable auto-sign.",
      request_id,
    };
  }
  const mcp = getMcpClient();
  const action = req.auto_sign?.action || "start";

  try {
    if (action === "disable") {
      const r = await mcp.call("vanna_disable_auto_sign", { wallet_address: trader }, userId);
      return {
        kind: "answer",
        message: (r.summary as string) || (r.message as string) || "Auto-sign disabled.",
        data: factsForUi(r),
        request_id,
      };
    }

    if (action === "start") {
      // Bare call → MCP returns needs_confirmation with two options
      const r = await enableAutoSign(mcp, { wallet: trader, userId: userId || trader });
      const st = String(r.status || "");
      if (st === "needs_confirmation" || !r.enabled) {
        return {
          kind: "needs_auto_sign",
          message:
            (r.message as string) ||
            "Enable auto-sign so the copilot can execute DeFi actions via the Vanna Sign Service (no per-tx wallet popup).",
          auto_sign: {
            status: "needs_confirmation",
            message: "Choose spend limits for auto-sign:",
            options: [
              {
                id: "use_defaults",
                label: "Use defaults",
                description: "$1000 per transaction · $1000 per day",
              },
              {
                id: "custom",
                label: "Set my own limits",
                description: "Choose per-tx and daily USD caps",
              },
            ],
            pending_write: req.pending_write
              ? {
                  op: req.pending_write.op,
                  asset: req.pending_write.asset,
                  amount: req.pending_write.amount,
                  leverage: req.pending_write.leverage,
                }
              : null,
            raw: r,
          },
          data: factsForUi(r),
          request_id,
        };
      }
      return {
        kind: "answer",
        message: (r.summary as string) || "Auto-sign enabled.",
        data: factsForUi(r),
        request_id,
      };
    }

    if (action === "use_defaults") {
      const r = await enableAutoSign(mcp, {
        wallet: trader,
        userId: userId || trader,
        useDefaultCaps: true,
      });
      const msg = (r.summary as string) || (r.message as string) || "Auto-sign enabled with default caps ($1000/$1000).";
      // Resume pending write if any
      if (req.pending_write?.op && (r.status === "enabled" || r.enabled === true || !r.error)) {
        const resumed = await runWrite(
          {
            op: req.pending_write.op,
            asset: req.pending_write.asset ?? null,
            amount: req.pending_write.amount ?? null,
            leverage: req.pending_write.leverage ?? null,
            smart_account: req.smart_account ?? null,
            trader,
          },
          {
            userId,
            trader,
            smartAccount: req.smart_account ?? null,
            request_id,
            message: "resume after auto-sign",
          },
        );
        if (resumed.kind === "executed") {
          return {
            ...resumed,
            message: `${msg}\n\n${resumed.message}`,
          };
        }
      }
      return {
        kind: r.error ? "error" : "answer",
        message: msg,
        data: factsForUi(r),
        request_id,
      };
    }

    if (action === "custom") {
      const tx = req.auto_sign?.max_per_tx_usd;
      if (tx == null || tx === "") {
        return {
          kind: "clarification",
          message: "What per-transaction USD limit do you want? (and optional daily limit)",
          request_id,
        };
      }
      const r = await enableAutoSign(mcp, {
        wallet: trader,
        userId: userId || trader,
        maxPerTxUsd: tx,
        maxPerDayUsd: req.auto_sign?.max_per_day_usd ?? tx,
      });
      return {
        kind: r.error ? "error" : "answer",
        message: (r.summary as string) || (r.message as string) || "Auto-sign enabled with your custom caps.",
        data: factsForUi(r),
        request_id,
      };
    }
  } catch (e) {
    return {
      kind: "error",
      message: `Auto-sign failed: ${e instanceof Error ? e.message : String(e)}`,
      request_id,
    };
  }

  return { kind: "error", message: "Unknown auto-sign action.", request_id };
}

// ── Reads ─────────────────────────────────────────────────────────────────

async function runRead(
  routed: Extract<RoutedIntent, { kind: "read" }>,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
): Promise<ChatResponse> {
  // Farmable Aquarius pools are Vanna's own pairs, not the full AMM API dump.
  // Counts come from VANNA_AQUARIUS_FARM_PAIRS so the prose can't drift from the
  // list the way a hardcoded "exactly 3" did once XLM/AQUA was removed.
  if (routed.tool === "vanna_list_aquarius_pools") {
    const mcp = getMcpClient();
    try {
      const raw = await mcp.call("vanna_list_aquarius_pools", {}, ctx.userId);
      const filtered = filterAquariusFarmPools(raw);
      const known = VANNA_AQUARIUS_FARM_PAIRS.length;
      const found = filtered.pools.length;
      const proseWidth = Math.max(1, ...filtered.pools.map((p) => String(p.pair).length));
      const prose =
        `Vanna has ${known} farmable Aquarius pool${known === 1 ? "" : "s"}:\n` +
        filtered.pools
          .map(
            (p) =>
              `• ${String(p.pair).padEnd(proseWidth)}  APY ${pct(p.total_apy_pct)}` +
              (p.liquidity_usd != null ? `  ·  liquidity ${usd(p.liquidity_usd)}` : "") +
              (p.pool_address ? `  ·  ${String(p.pool_address).slice(0, 8)}…` : ""),
          )
          .join("\n") +
        (found < known
          ? `\n\n(Only ${found} of the ${known} returned live API stats; the rest may be offline on testnet.)`
          : "");
      return {
        kind: "answer",
        message: prose,
        data: factsForUi({
          count: filtered.pools.length,
          pools: filtered.pools,
          note: "Vanna farm surface: XLM/USDC and XLM/USDT only (no XLM/AQUA pool exists).",
        }),
        intent: { template_id: "query_aquarius_pools", slots: { count: filtered.pools.length } },
        mcp: { tool: "vanna_list_aquarius_pools", has_unsigned_xdr: false },
        request_id: ctx.request_id,
      };
    } catch (e) {
      return mcpErrorResponse(e, ctx.request_id, routed.template_id);
    }
  }

  // Fan-out: all Vanna earn pools (Sanujit E3/E4) — MCP has no list-all tool.
  if (
    routed.tool === "vanna_get_pool_stats" &&
    (routed.args?.symbol === "__ALL_EARN__" || routed.template_id === "query_all_earn_pools")
  ) {
    const mcp = getMcpClient();
    const pools = [
      { query: "XLM", display: "XLM" },
      { query: "USDC", display: "BLUSDC" },
      { query: "AQUSDC", display: "AQUSDC" },
      { query: "SOUSDC", display: "SOUSDC" },
    ] as const;
    const rows: Array<Record<string, unknown>> = [];
    for (const p of pools) {
      try {
        const data = await mcp.call("vanna_get_pool_stats", { symbol: p.query }, ctx.userId);
        rows.push({
          symbol: p.display,
          supply_apy_pct: data.supply_apy_pct ?? data.supply_apr_pct,
          borrow_apr_pct: data.borrow_apr_pct,
          utilization_pct: data.utilization_pct,
          total_liquidity_human: data.total_liquidity_human ?? data.total_liquidity,
          total_assets_human: data.total_assets_human ?? data.total_assets,
          error: data.error,
        });
      } catch (e) {
        rows.push({ symbol: p.display, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const ranked = [...rows]
      .filter((r) => r.supply_apy_pct != null && !r.error)
      .sort((a, b) => Number(b.supply_apy_pct) - Number(a.supply_apy_pct));
    const winner = ranked[0];
    // Pad the symbol so the values line up as a column in the monospace-ish panel,
    // and round here rather than echoing MCP's 18-decimal strings. No markdown: the
    // UI renders this as plain text, so "**" would show as literal asterisks.
    const width = Math.max(...rows.map((r) => String(r.symbol).length));
    const lines = rows.map((r) => {
      const name = String(r.symbol).padEnd(width);
      if (r.error) return `• ${name}  unavailable (${r.error})`;
      return (
        `• ${name}  supply ${pct(r.supply_apy_pct)}  ·  borrow ${pct(r.borrow_apr_pct)}` +
        `  ·  used ${pct(r.utilization_pct)}  ·  liquidity ${amount(r.total_liquidity_human)}`
      );
    });
    const wantHighest = /highest|best|top/i.test(ctx.message);
    const prose = wantHighest
      ? `${winner?.symbol ?? "n/a"} pays the most right now at ${pct(winner?.supply_apy_pct)} supply APY.\n\n` +
        `All ${rows.length} Vanna earn pools:\n${lines.join("\n")}`
      : `Vanna has ${rows.length} earn pools:\n${lines.join("\n")}` +
        (winner ? `\n\n${winner.symbol} currently pays the most, at ${pct(winner.supply_apy_pct)}.` : "");
    return {
      kind: "answer",
      message: prose,
      data: factsForUi({ pools: rows, winner }),
      intent: { template_id: "query_all_earn_pools", slots: { pools: [...pools] } },
      mcp: { tool: "vanna_get_pool_stats", has_unsigned_xdr: false },
      request_id: ctx.request_id,
    };
  }

  const built = buildToolArgs(routed.tool, routed.args, {
    trader: ctx.trader,
    smartAccount: ctx.smartAccount,
  });
  if (built.blocker) {
    return {
      kind: "unavailable",
      message: built.blocker,
      intent: { template_id: routed.template_id, slots: routed.args },
      request_id: ctx.request_id,
    };
  }
  try {
    const mcp = getMcpClient();
    const data = await mcp.call(routed.tool, built.args, ctx.userId);
    let prose: string;
    const hinglish = /\b(kya|hai|ka|ki|ke|mujhe|kitna|kitni|batao|apy)\b/i.test(ctx.message);
    try {
      prose = await vertexExplain(
        hinglish
          ? `${ctx.message}\n\n(Reply in the same language mix as the user — clear Hinglish is fine.)`
          : ctx.message,
        routed.tool,
        data,
      );
    } catch {
      prose = explainRead(routed.tool, data, ctx.message);
    }
    prose = prose.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
    return {
      kind: "answer",
      message: prose,
      data: factsForUi(data),
      intent: { template_id: routed.template_id, slots: built.args },
      mcp: {
        tool: routed.tool,
        simulation_success: true,
        has_unsigned_xdr: false,
      },
      request_id: ctx.request_id,
    };
  } catch (e) {
    return mcpErrorResponse(e, ctx.request_id, routed.template_id);
  }
}

// ── Writes (MCP + auto-sign) ──────────────────────────────────────────────

/**
 * Informational before→after projection attached to a write preview so the UI
 * can show the impact on collateral / debt / LTV / health factor.
 *
 * Display only. The binding gates live in the MCP server and the Sign Service
 * auto-sign policy (see config.ts), so this must never change the outcome of a
 * write — a failure here just costs the UI its impact panel. Reads only, so it
 * runs alongside the write rather than in front of it.
 */
async function projectImpact(
  action: CopilotAction,
  smartAccount: string | null,
  trader: string | null,
): Promise<{ simulation: Simulation | null; reasons: string[] }> {
  try {
    const { risk, simulation } = await evaluateWriteRisk(getMcpClient(), {
      action,
      amount: action.amount ?? null,
      smartAccount,
      trader,
    });
    return { simulation, reasons: risk.reasons };
  } catch {
    return { simulation: null, reasons: [] };
  }
}

async function runWrite(
  action: CopilotAction,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
): Promise<ChatResponse> {
  if (copilotConfig.readsOnly) {
    return {
      kind: "blocked",
      message: "Writes are disabled (COPILOT_READS_ONLY).",
      request_id: ctx.request_id,
    };
  }

  // A nonsensical amount is nonsense whichever token was meant, so reject it before
  // the USDC-variant question below — otherwise "supply -5 USDC" asks the user to
  // pick a variant and only then complains, which reads as the copilot losing track.
  //
  // The raw text is checked too, not just the parsed slot: Gemini silently
  // normalises "deposit -10 XLM" to amount 10, so trusting the extracted value
  // alone let a negative through as a positive write. Safety never depends on the
  // model's output.
  if (/(?:^|\s)-\s?\d+(?:\.\d+)?(?=\s|$|[A-Za-z])/.test(ctx.message)) {
    return {
      kind: "blocked",
      message:
        "That amount is negative, which isn't a valid size for any action. " +
        `Give a positive figure — e.g. “${action.op.replace(/_/g, " ")} 10 ${action.asset ?? "XLM"}”.`,
      intent: { template_id: action.op, slots: { asset: action.asset, raw: ctx.message.slice(0, 80) } },
      request_id: ctx.request_id,
    };
  }
  if (action.amount != null && Number.isFinite(action.amount) && action.amount <= 0) {
    return {
      kind: "blocked",
      message: `Amount must be positive — “${action.amount}” is not valid. e.g. “${action.op.replace(/_/g, " ")} 10 ${action.asset ?? "XLM"}”.`,
      intent: { template_id: action.op, slots: { asset: action.asset, amount: action.amount } },
      request_id: ctx.request_id,
    };
  }

  // Leverage cap, stated up front. MCP and the Sign Service remain the authority on
  // risk, but asking for 20× and being answered with "how much do you want to supply?"
  // hides the fact that the figure was never acceptable (Sanujit FW14). Cheap pre-flight:
  // name the ceiling before spending a round-trip that will be refused anyway.
  if (action.leverage != null && Number.isFinite(action.leverage) && action.leverage > copilotConfig.maxLeverage) {
    return {
      kind: "blocked",
      message:
        `${action.leverage}× leverage is above the maximum this protocol allows. ` +
        `The cap is ${copilotConfig.maxLeverage}× — retry at ${copilotConfig.maxLeverage}× or lower, ` +
        `e.g. “farm Blend at ${Math.min(3, copilotConfig.maxLeverage)}× with 100 BLUSDC”.`,
      intent: { template_id: action.op, slots: { leverage: action.leverage, max: copilotConfig.maxLeverage } },
      request_id: ctx.request_id,
    };
  }

  let smartAccount = ctx.smartAccount;
  if (action.requires_account && !smartAccount && ctx.trader) {
    smartAccount = await resolveSmartAccount(getMcpClient(), ctx.trader, ctx.userId);
  }

  // Bare "USDC" is ambiguous (three SACs). Always ask — except highest-yield
  // path ranks concrete pools first and rewrites asset to BLUSDC/AQUSDC/SOUSDC.
  // LP pair "XLM/USDC" legitimately uses MCP symbol USDC (Aquarius pool) —
  // do not force BLUSDC/AQUSDC/SOUSDC chips on add/remove liquidity.
  const usdcOps = new Set([
    "lend",
    "supply",
    "redeem",
    "deposit_collateral",
    "withdraw_collateral",
    "borrow",
    "repay",
    "deposit_and_borrow",
    "deploy_to_blend",
    "supply_to_blend",
  ]);
  // ── deposit_and_borrow → sequential deposit THEN borrow ─────────────────
  // MCP's combined tool runs is_borrow_allowed against CURRENT collateral only
  // (deposit leg is not credited in the pre-flight). So "deposit 20 & borrow 2×"
  // must be two signed steps: deposit first, borrow after it confirms.
  if (action.op === "deposit_and_borrow") {
    const dep = action.amount;
    if (dep == null || !(dep > 0)) {
      return {
        kind: "clarification",
        message: "How much do you want to deposit for the leveraged position?",
        request_id: ctx.request_id,
      };
    }
    const { deposit, borrow } = splitLeverageAmounts(dep, action.leverage, null);
    // Keep the user's pick (BLUSDC/AQUSDC/…) for display + chip logic; mapOp
    // converts to MCP symbols (USDC/AQUSDC/SOUSDC) at the wire.
    const userAsset = action.asset || "USDC";
    const uiAsset = displayUsdcLabel(marginCollateralSymbol(userAsset), userAsset);
    const step1: CopilotAction = {
      op: "deposit_collateral",
      asset: userAsset,
      amount: deposit,
      requires_amount: true,
      requires_account: true,
      multi_leg: false,
      smart_account: smartAccount,
      trader: ctx.trader,
    };
    const step1Res = await runWrite(step1, {
      ...ctx,
      smartAccount,
      message: `step 1/2 deposit ${deposit} ${uiAsset}`,
    });
    const nextNote =
      `\n\nPlan (2 steps — not one atomic tx):\n` +
      `  Step 1/2 — Deposit ${amount(deposit)} ${uiAsset} as collateral  ← now\n` +
      `  Step 2/2 — Borrow ${amount(borrow)} ${uiAsset} (~${action.leverage ?? 2}×) after step 1 confirms\n` +
      `The copilot runs step 2 automatically once step 1 is on-chain.`;
    if (step1Res.kind === "needs_wallet_sign" || step1Res.kind === "needs_auto_sign" || step1Res.kind === "executed") {
      return {
        ...step1Res,
        message: (step1Res.message || "") + nextNote,
        intent: {
          template_id: "deposit_and_borrow_split",
          slots: {
            step: 1,
            deposit,
            borrow,
            asset: userAsset,
            leverage: action.leverage ?? 2,
          },
        },
        next_step: {
          op: "borrow",
          asset: userAsset,
          amount: borrow,
          leverage: action.leverage ?? 2,
          label: `Borrow ${borrow} ${uiAsset} (step 2/2)`,
          step: 2,
          total_steps: 2,
        },
      };
    }
    return step1Res;
  }

  // Sanujit EW5: "Supply 10 USDC to the highest-yielding pool" — read APYs first,
  // name the chosen earn pool, then build lend for that pool.
  // Tolerates typos like "highest- yielding" (hyphen + space).
  let highestPickNote = "";
  let highestPickFacts: Record<string, unknown> | null = null;
  if (
    (action.op === "lend" || action.op === "supply") &&
    /highest[\s-]*yielding|best[\s-]*yielding|highest[\s-]*apy|best[\s-]*apy|highest-?\s*yielding/i.test(
      ctx.message,
    )
  ) {
    try {
      const pick = await pickHighestEarnPool(getMcpClient(), ctx.userId);
      if (pick) {
        action = { ...action, asset: pick.symbol };
        highestPickNote =
          `Compared Vanna earn pools — chose ${pick.symbol} ` +
          `(supply APY ~${pick.supply_apy_pct}%).\n` +
          `Ranking: ${pick.ranking}.\n\n`;
        highestPickFacts = {
          chosen_pool: pick.symbol,
          chosen_supply_apy_pct: pick.supply_apy_pct,
          pool_ranking: pick.ranking,
          selection: "highest_earn_supply_apy",
        };
      }
    } catch {
      /* fall through with user-stated asset */
    }
  }

  // After highest-yield pick, asset is already BLUSDC/AQUSDC/SOUSDC/XLM.
  // For any other write still holding bare "USDC", force a chip selection.
  if (usdcOps.has(action.op) && needsUsdcVariant(action.asset) && !highestPickFacts) {
    return {
      kind: "clarification",
      message: usdcVariantClarifyMessage(action.op.replace(/_/g, " ")),
      clarify_options: USDC_VARIANT_OPTIONS.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
      })),
      pending_write: {
        op: action.op,
        asset: null,
        amount: action.amount ?? null,
        leverage: action.leverage ?? null,
      },
      intent: {
        template_id: "clarify_usdc_variant",
        slots: { op: action.op, amount: action.amount, asset: "USDC" },
      },
      data: {
        usdc_variants: USDC_VARIANT_OPTIONS.map((o) => o.id),
        note: "Pick BLUSDC, AQUSDC, or SOUSDC — they are not interchangeable.",
      },
      request_id: ctx.request_id,
    };
  }

  // Earn supply: clarify amount with live APY, block bad amounts / unsupported assets,
  // and pre-check wallet balance so we never dump raw Contract #3 sim logs (Sanujit EW3/EW6).
  if (action.op === "lend" || action.op === "supply") {
    const staticBlock = validateLendParams({
      asset: action.asset,
      amount: action.amount,
      trader: ctx.trader,
    });
    if (staticBlock) {
      return {
        kind: "blocked",
        message: staticBlock,
        intent: { template_id: "lend", slots: { asset: action.asset, amount: action.amount } },
        request_id: ctx.request_id,
      };
    }
    if (action.amount == null || !(action.amount > 0)) {
      const sym = earnPoolSymbol(action.asset);
      let apyNote = "";
      try {
        const stats = await getMcpClient().call(
          "vanna_get_pool_stats",
          { symbol: sym === "BLUSDC" ? "USDC" : sym },
          ctx.userId,
        );
        const apy = stats.supply_apy_pct ?? stats.supply_apr_pct;
        if (apy != null) apyNote = ` Current ${sym} earn supply APY is ~${apy}%.`;
      } catch {
        /* optional context */
      }
      return {
        kind: "clarification",
        message:
          `How much ${sym} do you want to supply to the Vanna earn pool?` +
          apyNote +
          ` e.g. “lend 10 ${sym}” or “supply 25 ${sym}”.`,
        intent: { template_id: "lend", slots: { asset: sym, amount: null } },
        mcp: { tool: "vanna_get_pool_stats", has_unsigned_xdr: false },
        request_id: ctx.request_id,
      };
    }
    if (ctx.trader) {
      const pf = await preflightLend(
        getMcpClient(),
        { asset: action.asset, amount: action.amount, trader: ctx.trader },
        ctx.userId,
      );
      if (!pf.ok) {
        return {
          kind: "blocked",
          message: pf.blocker,
          intent: {
            template_id: "lend",
            slots: { asset: action.asset, amount: action.amount },
          },
          mcp: { tool: "vanna_get_wallet_balance", has_unsigned_xdr: false },
          request_id: ctx.request_id,
        };
      }
    }
  }

  // Blend farm supply — resolve Registry blend pool C-address for MCP deploy tool.
  let blendPoolAddress: string | null = null;
  if (action.op === "deploy_to_blend" || action.op === "supply_to_blend") {
    if (action.amount == null || !(action.amount > 0)) {
      return {
        kind: "clarification",
        message: `How much ${action.asset || "XLM"} do you want to supply to Blend? e.g. “supply 10 XLM to Blend”.`,
        intent: { template_id: "deploy_to_blend", slots: { asset: action.asset, amount: null } },
        request_id: ctx.request_id,
      };
    }
    if (!smartAccount) {
      return {
        kind: "unavailable",
        message:
          "Supplying to Blend needs a margin (smart) account first — create one, then retry.",
        request_id: ctx.request_id,
      };
    }
    try {
      const addrs = await getMcpClient().call("vanna_list_protocol_addresses", {}, ctx.userId);
      const optional = (addrs.optional as Record<string, unknown>) || {};
      blendPoolAddress =
        (optional.blend_pool as string) ||
        (addrs.blend_pool as string) ||
        null;
    } catch {
      blendPoolAddress = null;
    }
    if (!blendPoolAddress) {
      return {
        kind: "error",
        message: "Could not resolve the Blend pool address from the Registry.",
        request_id: ctx.request_id,
      };
    }
  }

  const mapped = mapOpToMcpStep(
    action.op,
    {
      asset: action.asset,
      amount: action.amount,
      leverage: action.leverage,
      blend_pool_address: blendPoolAddress,
      token_a: action.token_a,
      token_b: action.token_b,
      amount_a: action.amount_a,
      amount_b: action.amount_b,
      fraction: action.fraction,
    },
    { trader: ctx.trader, smartAccount },
  );

  if (mapped.blocker || !mapped.step) {
    return {
      kind: "clarification",
      message: mapped.blocker || "Could not map that write to an MCP tool.",
      intent: { template_id: action.op, slots: { asset: action.asset, amount: action.amount } },
      request_id: ctx.request_id,
    };
  }

  // IMPORTANT: do NOT run projectImpact in parallel with executeMcpWrite.
  // Both use the shared MCP Streamable-HTTP session; concurrent tools/call
  // responses get interleaved and we were attaching get_price payloads to
  // deposit/borrow (false "no XDR" errors). Write first, then optional sim.
  const result = await executeMcpWrite(getMcpClient(), mapped.step, {
    trader: ctx.trader,
    smartAccount,
    userId: ctx.userId,
  });

  const { simulation, reasons: projected } = await projectImpact(
    { ...action, smart_account: smartAccount },
    smartAccount,
    ctx.trader,
  );
  /** Projection lines read first; the MCP path's own reason stays as the tail. */
  const reasonsWith = (base: string[]) => (projected.length ? [...projected, ...base] : base);

  const mcpMeta = {
    tool: result.mcp_trace.tool,
    simulation_success: result.mcp_trace.simulation_success,
    auto_sign: result.mcp_trace.auto_sign,
    auto_sign_error: result.mcp_trace.auto_sign_error,
    has_unsigned_xdr: result.mcp_trace.has_unsigned_xdr,
  };

  if (result.status === "signed_and_submitted" || result.status === "done") {
    const tx =
      (result.submitted?.tx_hash as string) ||
      (result.build.tx_hash as string) ||
      null;
    // Prefer plain text (no **markdown**) for the chat panel.
    const cleanMsg = String(result.message || "").replace(/\*\*([^*]+)\*\*/g, "$1");
    return {
      kind: "executed",
      message: cleanMsg,
      data: factsForUi({ ...result.build, ...(result.submitted || {}) }),
      intent: { template_id: action.op, slots: { asset: action.asset, amount: action.amount } },
      mcp: mcpMeta,
      execution: {
        status: result.status,
        tx_hash: tx,
        steps: [{ tool: result.tool, label: result.label, status: result.status, message: result.message }],
      },
      preview: {
        template_id: action.op,
        human_summary: result.message,
        slots: { asset: action.asset, amount: action.amount },
        risk: { decision: "allow", reasons: reasonsWith(["executed via MCP"]) },
        requires_signature: false,
        action: { ...action, smart_account: smartAccount },
        simulation,
        mcp: { tool: result.tool, status: result.status, tx_hash: tx, needs_auto_sign: false },
      },
      request_id: ctx.request_id,
    };
  }

  if (result.status === "needs_wallet_sign") {
    const pickSummary = highestPickNote
      ? highestPickNote.replace(/\n+/g, " ").replace(/\s+/g, " ").trim()
      : "";
    // Put the comparison first in human_summary so the staged-action title
    // shows the winner (UI uses human_summary as the H6 headline).
    const stagedTitle = pickSummary
      ? `${pickSummary} → ${mapped.step.label}`
      : mapped.step.label;
    const reasons = reasonsWith(
      pickSummary
        ? [
            `Pool selection: ${pickSummary}`,
            `Action: ${mapped.step.label}`,
            "wallet sign required (MCP built XDR)",
          ]
        : ["wallet sign required (MCP built XDR)"],
    );
    return {
      kind: "needs_wallet_sign",
      message: (highestPickNote || "") + result.message,
      data: factsForUi({
        ...result.build,
        ...(highestPickFacts || {}),
        action_label: mapped.step.label,
      }),
      unsigned_xdr: result.unsigned_xdr ?? null,
      mcp: mcpMeta,
      intent: {
        template_id: highestPickFacts ? "lend_highest" : action.op,
        slots: { asset: action.asset, amount: action.amount, ...(highestPickFacts || {}) },
      },
      preview: {
        template_id: highestPickFacts ? "lend_highest" : action.op,
        human_summary: stagedTitle,
        slots: {
          asset: action.asset,
          amount: action.amount,
          ...(highestPickFacts || {}),
        },
        risk: {
          decision: "needs_confirmation",
          reasons,
          projected_health_factor: simulation?.hf_after ?? null,
        },
        requires_signature: true,
        action: { ...action, smart_account: smartAccount },
        simulation,
        mcp: { tool: result.tool, status: "needs_wallet_sign", needs_auto_sign: false },
      },
      request_id: ctx.request_id,
    };
  }

  if (result.status === "needs_auto_sign") {
    return {
      kind: "needs_auto_sign",
      message: result.message,
      mcp: mcpMeta,
      auto_sign: {
        status: "needs_enable",
        message: "Enable auto-sign for this wallet (Sign Service policy caps).",
        options: [
          {
            id: "use_defaults",
            label: "Enable auto-sign (defaults)",
            description: "$1000 per tx · $1000 per day",
          },
          {
            id: "custom",
            label: "Enable with custom limits",
            description: "Set your own USD caps",
          },
        ],
        pending_write: {
          ...action,
          smart_account: smartAccount,
          trader: ctx.trader,
        },
        raw: result.build,
      },
      intent: { template_id: action.op, slots: { asset: action.asset, amount: action.amount } },
      preview: {
        template_id: action.op,
        human_summary: mapped.step.label,
        slots: { asset: action.asset, amount: action.amount },
        risk: {
          decision: "needs_confirmation",
          reasons: reasonsWith(["auto-sign required"]),
          projected_health_factor: simulation?.hf_after ?? null,
        },
        requires_signature: false,
        action: { ...action, smart_account: smartAccount },
        simulation,
        mcp: { tool: result.tool, status: "needs_auto_sign", needs_auto_sign: true },
      },
      request_id: ctx.request_id,
    };
  }

  if (result.status === "rejected") {
    return {
      kind: "blocked",
      message: result.message,
      data: factsForUi({ ...result.build, ...(result.submitted || {}) }),
      mcp: mcpMeta,
      intent: { template_id: action.op },
      preview: {
        template_id: action.op,
        human_summary: mapped.step.label,
        slots: { asset: action.asset, amount: action.amount },
        risk: { decision: "block", reasons: reasonsWith([result.message]) },
        requires_signature: false,
        action: { ...action, smart_account: smartAccount },
        simulation,
      },
      request_id: ctx.request_id,
    };
  }

  return {
    kind: "error",
    message: result.message,
    data: factsForUi(result.build),
    mcp: mcpMeta,
    intent: { template_id: action.op },
    request_id: ctx.request_id,
  };
}

// ── Multi-step plans (complex strategy prompts) ───────────────────────────

async function runPlan(
  plan: Extract<RoutedIntent, { kind: "plan" }>,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
): Promise<ChatResponse> {
  const stepsOut: Array<{ tool: string; label: string; status: string; message: string }> = [];
  const facts: Record<string, unknown> = {};
  let smartAccount = ctx.smartAccount;
  const mcp = getMcpClient();

  for (const step of plan.steps.slice(0, 8)) {
    if (step.kind === "read" && step.tool) {
      if (needsSmartAccount(step.tool) && !smartAccount && ctx.trader) {
        smartAccount = await resolveSmartAccount(mcp, ctx.trader, ctx.userId);
      }
      const built = buildToolArgs(step.tool, step.args || {}, {
        trader: ctx.trader,
        smartAccount,
      });
      if (built.blocker) {
        stepsOut.push({ tool: step.tool, label: step.tool, status: "skipped", message: built.blocker });
        continue;
      }
      try {
        const data = await mcp.call(step.tool, built.args, ctx.userId);
        facts[step.tool] = data;
        stepsOut.push({ tool: step.tool, label: step.tool, status: "ok", message: "read ok" });
      } catch (e) {
        stepsOut.push({
          tool: step.tool,
          label: step.tool,
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    if (step.kind === "write" && (step.op || step.tool)) {
      const op = step.op || mapToolToOp(step.tool!);
      const action: CopilotAction = {
        op,
        asset: step.asset ?? (step.args?.symbol as string) ?? null,
        amount: step.amount ?? (step.args?.amount != null ? Number(step.args.amount) : null),
        smart_account: smartAccount,
        trader: ctx.trader,
      };
      const writeRes = await runWrite(action, { ...ctx, smartAccount });
      if (writeRes.kind === "needs_auto_sign") {
        return {
          ...writeRes,
          message:
            `${plan.summary || "Strategy plan"} — paused: auto-sign required before executing “${op}”.\n\n` +
            writeRes.message,
          execution: {
            status: "needs_auto_sign",
            steps: [
              ...stepsOut,
              { tool: op, label: op, status: "needs_auto_sign", message: writeRes.message },
            ],
          },
        };
      }
      if (writeRes.kind === "executed") {
        stepsOut.push({
          tool: op,
          label: op,
          status: "signed_and_submitted",
          message: writeRes.message,
        });
        if (writeRes.data) Object.assign(facts, writeRes.data);
        continue;
      }
      if (writeRes.kind === "error" || writeRes.kind === "blocked" || writeRes.kind === "clarification") {
        return {
          ...writeRes,
          message: `Plan stopped at “${op}”: ${writeRes.message}`,
          execution: {
            status: "stopped",
            steps: [...stepsOut, { tool: op, label: op, status: writeRes.kind, message: writeRes.message }],
          },
        };
      }
    }
  }

  let prose = plan.summary || "Completed plan steps.";
  try {
    prose = await vertexExplain(ctx.message, "plan", { steps: stepsOut, facts });
  } catch {
    prose = `${plan.summary || "Plan"}\n` + stepsOut.map((s) => `• ${s.label}: ${s.status} — ${s.message}`).join("\n");
  }

  const anySubmitted = stepsOut.some((s) => s.status === "signed_and_submitted");
  return {
    kind: anySubmitted ? "executed" : "answer",
    message: prose,
    data: factsForUi(facts),
    intent: { template_id: plan.template_id },
    execution: { status: "completed", steps: stepsOut },
    request_id: ctx.request_id,
  };
}

function mapToolToOp(tool: string): string {
  const m: Record<string, string> = {
    vanna_lend: "lend",
    vanna_redeem: "redeem",
    vanna_deposit_collateral: "deposit_collateral",
    vanna_withdraw_collateral: "withdraw_collateral",
    vanna_borrow: "borrow",
    vanna_repay: "repay",
    vanna_deposit_and_borrow: "deposit_and_borrow",
    vanna_deploy_to_blend: "deploy_to_blend",
    vanna_open_account: "create_account",
    vanna_close_account: "close_account",
    vanna_settle_account: "settle_account",
  };
  return m[tool] || tool.replace(/^vanna_/, "");
}

/**
 * Display helpers for prose this server writes itself (as opposed to prose Gemini
 * writes — that path is rounded in `vertexExplain`). MCP returns contract precision,
 * e.g. "14.977890082244174400", which is unreadable in a sentence.
 */
function pct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "n/a";
}
function amount(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function usd(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Vanna's farmable Aquarius pairs. Must mirror `AQUARIUS_POOLS` in
 * lib/aquarius-utils.ts, which is the source of truth — it carries the actual
 * pool contract addresses the app transacts against.
 *
 * XLM/AQUA is deliberately absent: the protocol has no XLM/AQUA pool (confirmed
 * by the contracts owner, and `AQUARIUS_POOLS` holds only XLM/USDC and XLM/USDT).
 * It was previously listed here from the test-prompt doc, and because the filter
 * below matches against Aquarius's *whole* public API dump, an unrelated AQUA pool
 * satisfied the pair and got presented as farmable — with blank APY and liquidity,
 * since Vanna has no position or address for it.
 */
const VANNA_AQUARIUS_FARM_PAIRS: Array<{ pair: string; a: string; b: string }> = [
  { pair: "XLM/USDC", a: "XLM", b: "USDC" },
  { pair: "XLM/USDT", a: "XLM", b: "USDT" },
];

function normalizeTokenLabel(t: string): string {
  const u = t.toUpperCase().replace(/^MOCK\s+/, "").trim();
  if (u === "NATIVE" || u === "XLM") return "XLM";
  if (u.includes("AQUA") && !u.includes("USDC")) return "AQUA";
  if (u.includes("USDT") || u === "MOCK USDT") return "USDT";
  if (u.includes("USDC") || u === "TUSDC") return "USDC";
  return u.split(/[:\s]/)[0] || u;
}

function tokensMatchPair(tokens: string[], a: string, b: string): boolean {
  const set = new Set(tokens.map(normalizeTokenLabel));
  return set.has(a) && set.has(b);
}

/**
 * Filter MCP Aquarius API dump down to the 3 Vanna-farmable pairs (PDF F9).
 * When multiple API pools share a pair, keep the highest total APY.
 */
function filterAquariusFarmPools(raw: Record<string, unknown>): {
  pools: Array<Record<string, unknown>>;
} {
  const list = Array.isArray(raw.pools) ? (raw.pools as Record<string, unknown>[]) : [];
  const out: Array<Record<string, unknown>> = [];
  for (const want of VANNA_AQUARIUS_FARM_PAIRS) {
    const candidates = list.filter((p) => {
      const tokens = Array.isArray(p.tokens)
        ? (p.tokens as unknown[]).map((t) => String(t))
        : Array.isArray(p.tokens_raw)
          ? (p.tokens_raw as unknown[]).map((t) => String(t).split(":")[0])
          : [];
      return tokensMatchPair(tokens, want.a, want.b);
    });
    candidates.sort(
      (x, y) =>
        Number(y.total_apy_pct ?? y.apy_pct ?? 0) - Number(x.total_apy_pct ?? x.apy_pct ?? 0),
    );
    const best = candidates[0];
    if (best) {
      out.push({
        pair: want.pair,
        token_a: want.a,
        token_b: want.b,
        total_apy_pct: best.total_apy_pct ?? best.apy_pct ?? null,
        apy_pct: best.apy_pct ?? null,
        liquidity_usd: best.liquidity_usd ?? null,
        pool_address: best.pool_address ?? null,
        fee: best.fee ?? null,
        pool_type: best.pool_type ?? null,
      });
    } else {
      out.push({
        pair: want.pair,
        token_a: want.a,
        token_b: want.b,
        total_apy_pct: null,
        note: "No live API match for this pair on testnet right now.",
      });
    }
  }
  return { pools: out };
}

/** Rank Vanna earn pools by supply APY and return the winner (Sanujit EW5). */
async function pickHighestEarnPool(
  mcp: ReturnType<typeof getMcpClient>,
  userId: string,
): Promise<{ symbol: string; supply_apy_pct: string | number; ranking: string } | null> {
  // Query each concrete pool; map MCP "USDC" alias → BLUSDC for user clarity.
  const pools = [
    { query: "XLM", display: "XLM" },
    { query: "USDC", display: "BLUSDC" },
    { query: "AQUSDC", display: "AQUSDC" },
    { query: "SOUSDC", display: "SOUSDC" },
  ] as const;
  const rows: Array<{ symbol: string; apy: number; apyRaw: string | number }> = [];
  for (const p of pools) {
    try {
      const data = await mcp.call("vanna_get_pool_stats", { symbol: p.query }, userId);
      if (data.error) continue;
      const apyRaw = (data.supply_apy_pct ?? data.supply_apr_pct) as string | number;
      const apy = Number(apyRaw);
      if (Number.isFinite(apy)) rows.push({ symbol: p.display, apy, apyRaw });
    } catch {
      /* skip */
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.apy - a.apy);
  return {
    symbol: rows[0].symbol,
    supply_apy_pct: rows[0].apyRaw,
    ranking: rows.map((r) => `${r.symbol} ${r.apyRaw}%`).join(" · "),
  };
}

async function resolveSmartAccount(
  mcp: ReturnType<typeof getMcpClient>,
  trader: string,
  userId: string,
): Promise<string | null> {
  try {
    const resolved = await mcp.call("vanna_resolve_account", { trader }, userId);
    const sa =
      (resolved.smart_account as string) ||
      (resolved.account as string) ||
      (resolved.margin_account as string) ||
      null;
    if (sa && /^C[A-Z0-9]{55}$/.test(sa)) return sa;
  } catch {
    /* ignore */
  }
  return null;
}

function mcpErrorResponse(e: unknown, request_id: string, template_id?: string): ChatResponse {
  if (e instanceof MCPAuthError) {
    return {
      kind: "error",
      message: "MCP auth failed (WorkOS M2M). Check WORKOS_M2M_* in .env.local.",
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  if (e instanceof MCPCallError || e instanceof MCPError) {
    return {
      kind: "error",
      message: `MCP error: ${e.message}`,
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  if (e instanceof VertexError) {
    return {
      kind: "error",
      message: `Vertex error: ${e.message}`,
      intent: { template_id: template_id ?? null },
      request_id,
    };
  }
  return {
    kind: "error",
    message: e instanceof Error ? e.message : "Copilot failed",
    intent: { template_id: template_id ?? null },
    request_id,
  };
}
