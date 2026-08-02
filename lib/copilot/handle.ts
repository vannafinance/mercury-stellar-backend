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
  formatLeveragePlanLine,
  validateLendParams,
  needsUsdcVariant,
  usdcVariantClarifyMessage,
  USDC_VARIANT_OPTIONS,
  defaultCapUsdFromMcp,
} from "./mcp-write";
import { evaluateWriteRisk } from "./risk";
import { isAssistantChat } from "./concept";
import { runPageAgent } from "./page-agent";
import {
  actionFromExpanded,
  affectsHealth,
  expandPlanWrites,
  extractTxHash,
  humanizeLegError,
  multiLegHeadline,
  multiLegUiData,
  remainingNextStep,
  statusFromWriteResult,
  toExecutionStep,
  type MultiLegStep,
} from "./multi-leg-agent";
import { preflightExpandedLegs } from "./multi-leg-preflight";
import { looksLikeMultiGoal, preferMultiGoalPlan } from "./plan-sanitize";
import { findUnsupportedAsset, parseMinHealthFactor, routeMessage } from "./router";
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

  // ── Resume multi-leg strategy (retry failed / continue remaining legs) ──
  if (req.resume_multi_leg?.legs?.length) {
    const legs = req.resume_multi_leg.legs.filter(
      (l) => l.op && l.amount != null && Number(l.amount) > 0,
    );
    if (legs.length) {
      const plan: Extract<RoutedIntent, { kind: "plan" }> = {
        kind: "plan",
        template_id: "multi_leg_resume",
        summary:
          req.resume_multi_leg.summary ||
          `Resume strategy (${legs.length} remaining step${legs.length === 1 ? "" : "s"})`,
        steps: legs.map((l) => ({
          kind: "write" as const,
          op: l.op,
          asset: l.asset ?? null,
          amount: l.amount != null ? Number(l.amount) : null,
          args: l.leverage != null ? { leverage: l.leverage } : undefined,
          leverage: l.leverage ?? null,
        })),
      };
      return runPlan(plan, {
        userId,
        trader,
        smartAccount,
        request_id,
        message: message || plan.summary || "resume multi-leg",
      });
    }
  }

  // Natural-language resume when prior context isn't attached
  if (
    /\b(continue|resume|retry|finish)\b/i.test(message) &&
    /\b(strateg|multi[- ]?leg|remaining|failed|farm|blend|steps?)\b/i.test(message)
  ) {
    // Without structured resume_legs the client should send resume_multi_leg.
    // Fall through so keyword/Vertex can still build a full plan if the user re-states it.
  }

  // ── Resume pending write after auto-sign enable / agent chain hop ───────
  if (req.pending_write?.op) {
    const action: CopilotAction = {
      op: req.pending_write.op,
      asset: req.pending_write.asset ?? null,
      amount: req.pending_write.amount ?? null,
      leverage: req.pending_write.leverage ?? null,
      requires_amount:
        req.pending_write.op !== "create_account" &&
        !(req.pending_write.op === "remove_liquidity" && req.pending_write.fraction != null),
      requires_account: !["create_account", "lend", "redeem"].includes(req.pending_write.op),
      smart_account: smartAccount,
      trader,
      token_a: req.pending_write.token_a ?? null,
      token_b: req.pending_write.token_b ?? null,
      amount_a: req.pending_write.amount_a ?? null,
      amount_b: req.pending_write.amount_b ?? null,
      fraction: req.pending_write.fraction ?? null,
      min_hf: parseMinHealthFactor(message) ?? null,
    };
    const writeRes = await runWrite(action, {
      userId,
      trader,
      smartAccount,
      request_id,
      message: message || action.op,
    });
    // Multi-hop chain: after this leg, attach the follow_up as next_step
    // (e.g. borrow done → auto supply_to_blend for levered Blend farm).
    const follow = req.pending_write.follow_up;
    if (
      follow?.op &&
      (writeRes.kind === "executed" ||
        writeRes.kind === "needs_wallet_sign" ||
        writeRes.kind === "needs_auto_sign") &&
      !writeRes.next_step
    ) {
      const hopNote =
        `\n\nNext (auto): ${follow.label || `${follow.op} ${follow.amount ?? ""} ${follow.asset ?? ""}`.trim()}` +
        ` (step ${follow.step ?? "?"}/${follow.total_steps ?? "?"})`;
      return {
        ...writeRes,
        message: (writeRes.message || "") + hopNote,
        next_step: {
          op: follow.op,
          asset: follow.asset ?? null,
          amount: follow.amount ?? null,
          leverage: follow.leverage ?? null,
          label: follow.label,
          step: follow.step,
          total_steps: follow.total_steps,
        },
      };
    }
    return writeRes;
  }

  if (!message) {
    return { kind: "error", message: "Please type a question.", request_id };
  }

  // Quick NL auto-sign / auto-approve intents (same UX as MCP Sign Service).
  const lower = message.toLowerCase();
  if (
    /\bdisable auto[- ]?sign\b|\bturn off auto[- ]?sign\b|\bauto[- ]?approve off\b|\bdisable auto[- ]?approve\b/.test(
      lower,
    )
  ) {
    return handleAutoSignAction(
      { ...req, auto_sign: { action: "disable" } },
      request_id,
      trader,
      userId,
    );
  }
  // “set auto-sign caps to 500 per tx and 2000 per day” / “auto approve limit 1000”
  const capMatch =
    message.match(
      /(?:auto[- ]?(?:sign|approve)|spend)\s*(?:cap|limit|limits)?[^\d$]*\$?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*tx|per\s*tx|per\s*transaction|tx)?(?:[^\d$]*\$?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*day|per\s*day|daily)?)?/i,
    ) ||
    message.match(
      /(?:max|limit)\s*(?:per\s*)?(?:tx|transaction)[^\d$]*\$?\s*(\d+(?:\.\d+)?)(?:[^\d$]+(?:day|daily)[^\d$]*\$?\s*(\d+(?:\.\d+)?))?/i,
    );
  if (
    capMatch &&
    /\b(auto[- ]?(?:sign|approve)|cap|limit|spend)\b/i.test(message) &&
    !/\bdisable\b/i.test(lower)
  ) {
    const tx = capMatch[1];
    const day = capMatch[2] || tx;
    return handleAutoSignAction(
      {
        ...req,
        auto_sign: {
          action: "custom",
          max_per_tx_usd: tx,
          max_per_day_usd: day,
        },
      },
      request_id,
      trader,
      userId,
    );
  }
  if (
    /\benable auto[- ]?sign\b|\bturn on auto[- ]?sign\b|\bauto[- ]?sign on\b|\benable auto[- ]?approve\b|\bturn on auto[- ]?approve\b|\bauto[- ]?approve on\b|\bset (?:my )?auto[- ]?(?:sign|approve)(?:\s+cap|\s+limit)?\b/.test(
      lower,
    ) ||
    (/\buse (?:the )?default(?:s)?(?:\s+caps?)?\b/i.test(lower) &&
      /\bauto[- ]?(?:sign|approve)\b/i.test(lower))
  ) {
    // “use defaults for auto-sign”
    if (/\bdefault/i.test(lower) && /\b(cap|auto|sign|approve)\b/i.test(lower)) {
      return handleAutoSignAction(
        { ...req, auto_sign: { action: "use_defaults" } },
        request_id,
        trader,
        userId,
      );
    }
    return handleAutoSignAction(
      { ...req, auto_sign: { action: "start" } },
      request_id,
      trader,
      userId,
    );
  }

  // ── Page-aware AI agent (Gemini plan: semantic pageContext + client tools) ─
  // Ahead of MCP write routing so "what is Blend?" never becomes a write.
  // Live "my …" / actions still fall through to MCP.
  if (isAssistantChat(message)) {
    // Prefer structured semantic_page_context; fall back to legacy page_snapshot.
    let semantic = req.semantic_page_context ?? null;
    if (!semantic && req.page_snapshot) {
      const snap = req.page_snapshot;
      semantic = {
        url: snap.url,
        path: snap.path,
        title: snap.title,
        description: "",
        sections: (snap.headings || []).map((t) => ({ level: 2, text: t, id: null })),
        mainText: snap.visible_text || snap.region_text || "",
        selectedText: snap.selection ?? null,
        interactiveHints: [],
        capturedAt: snap.captured_at,
      };
    }
    return runPageAgent(
      message,
      semantic,
      request_id,
      Array.isArray(req.history) ? req.history : undefined,
    );
  }

  // ── Route intent (hybrid: fast keywords + smart Vertex for complex goals) ─
  // Simple single-action prompts (swap/lend/deposit…) skip Vertex for speed.
  // Multi-goal / long / strategy language always uses Gemini so understanding is
  // free-form — not a fixed prompt list. Keyword router still corrects venue
  // mistakes after Vertex (Blend vs Earn, USDC variants, etc.).
  const kwFast = routeMessage(message);
  const needsSemanticIntent = (() => {
    const t = message.trim();
    if (t.length > 90) return true;
    const actionVerbs =
      t.match(
        /\b(swap|lend|borrow|deposit|repay|farm|invest|supply|withdraw|redeem|add|remove|allocate|park|grow|deploy)\b/gi,
      ) || [];
    const uniqueVerbs = new Set(actionVerbs.map((v) => v.toLowerCase()));
    if (uniqueVerbs.size >= 2) return true;
    // Yield + farm in one breath even if only one “verb” matched cleanly
    if (/\b(park|lend|earn|yield)\b/i.test(t) && /\b(farm|blend|deploy)\b/i.test(t)) return true;
    if (
      /\b(invest|strategy|rebalance|optimize|max(?:imum)?\s*profit|wherever|whatever|make sure|ensure|keeping|while|then also|and also|multi[- ]?step)\b/i.test(
        t,
      ) &&
      !/^\s*(swap|lend|borrow|deposit|repay|supply|farm blend)\b/i.test(t)
    ) {
      return true;
    }
    // Two independent clauses joined by and/then with risk language
    if (/\b(and|then)\b/i.test(t) && /\b(health|liquidat|profit|yield|farm|earn|hf)\b/i.test(t)) {
      return true;
    }
    return false;
  })();

  const keywordConfident =
    !needsSemanticIntent &&
    (kwFast.kind === "write" ||
      kwFast.kind === "restricted" ||
      kwFast.kind === "auto_sign" ||
      (kwFast.kind === "read" &&
        !!kwFast.template_id &&
        [
          "query_all_earn_pools",
          "query_blend",
          "query_account_health",
          "query_prices_batch",
          "query_price",
          "query_pool_stats",
          "query_wallet_balance",
          "query_farm_overview",
          "query_blend_position",
          "query_collateral_config",
          "query_addresses",
          "query_resolve",
        ].includes(kwFast.template_id)));

  let routed: RoutedIntent;
  if (keywordConfident) {
    routed = kwFast;
  } else {
    try {
      routed = await vertexSelectTool(message, {
        smartAccount,
        trader,
        pageContext: req.page_context ?? null,
      });
    } catch (e) {
      console.warn("[copilot] vertex route failed, keyword fallback:", e instanceof Error ? e.message : e);
      routed = kwFast;
    }
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
    const kw = keywordConfident ? kwFast : routeMessage(message);
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
    } else if (kw.kind === "write" && (kw.op === "add_liquidity" || kw.op === "remove_liquidity" || kw.op === "swap")) {
      // LP / swap must never become deposit_collateral.
      routed = kw;
    } else if (kw.kind === "write" && kw.template_id === "invest_max_yield") {
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

    // Phase 2: multi-goal plans — never let Vertex collapse park+farm into one write.
    // Keyword plan has safer amounts (N ASSET only; HF floor never becomes size).
    if (looksLikeMultiGoal(message) || kw.kind === "plan") {
      const before = routed.kind;
      routed = preferMultiGoalPlan(routed, kw, message);
      if (before !== routed.kind || (routed.kind === "plan" && before === "plan")) {
        if (routed.kind === "plan" && before !== "plan") {
          console.warn(
            `[copilot] multi-goal: preferred keyword plan over vertex ${before} (${routed.steps?.length ?? 0} steps)`,
          );
        }
      }
    }
  }

  // Normalize plan → MultiLegAgent (expand → execute → HF stop → report)
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
    const minHf = routed.min_hf ?? parseMinHealthFactor(message);
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
      min_hf: minHf,
      prefer_max_yield: routed.prefer_max_yield ?? null,
      venue: routed.venue ?? null,
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
      // Bare call → MCP returns needs_confirmation with two options + default_cap_usd
      const r = await enableAutoSign(mcp, { wallet: trader, userId: userId || trader });
      const st = String(r.status || "");
      const defCap = defaultCapUsdFromMcp(r);
      if (st === "needs_confirmation" || !r.enabled) {
        return {
          kind: "needs_auto_sign",
          message:
            (r.question as string) ||
            (r.message as string) ||
            (r.summary as string) ||
            `Enable auto-approve / auto-sign. MCP default is $${defCap}/tx and $${defCap}/day ` +
              `(testnet stand-in; Sign Service may clamp). Pick defaults or custom USD caps.`,
          auto_sign: {
            status: "needs_confirmation",
            message: `Choose spend limits (MCP default_cap_usd=$${defCap}):`,
            options: [
              {
                id: "use_defaults",
                label: "Use defaults",
                description: `$${defCap} per transaction · $${defCap} per day (from MCP)`,
              },
              {
                id: "custom",
                label: "Set my own limits",
                description: "Choose per-tx and daily USD caps (day can differ from tx)",
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
      // Only use_default_caps — do not also send max_per_tx_usd (MCP then applies SS defaults).
      const r = await enableAutoSign(mcp, {
        wallet: trader,
        userId: userId || trader,
        useDefaultCaps: true,
      });
      const defCap = defaultCapUsdFromMcp(r);
      const msg =
        (r.summary as string) ||
        (r.message as string) ||
        `Auto-sign / auto-approve enabled with MCP default caps (≈ $${defCap}/tx · $${defCap}/day).` +
          (r.error
            ? ` (MCP note: ${String(r.error)} — wallet session signing may still work for in-app approve.)`
            : "");
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
        // Probe MCP for default_cap_usd so UI numbers are not invented.
        let defCap = 1000;
        try {
          const probe = await enableAutoSign(mcp, { wallet: trader, userId: userId || trader });
          defCap = defaultCapUsdFromMcp(probe);
        } catch {
          /* keep fallback */
        }
        return {
          kind: "needs_auto_sign",
          message:
            "Set your auto-approve / auto-sign spend caps (same as MCP Sign Service).\n" +
            `MCP default_cap_usd is $${defCap} per tx and per day (you may set a higher day cap).\n` +
            "Pick defaults, enter custom USD limits, or say e.g. “set auto-sign cap to 500 per tx and 2000 per day”.",
          auto_sign: {
            status: "needs_confirmation",
            message: "Choose spend limits:",
            options: [
              {
                id: "use_defaults",
                label: "Use defaults",
                description: `$${defCap} per transaction · $${defCap} per day (MCP)`,
              },
              {
                id: "custom",
                label: "Set my own limits",
                description: "Per-tx required; daily optional (defaults to per-tx if omitted)",
              },
            ],
            pending_write: null,
            raw: null,
          },
          request_id,
        };
      }
      // If user only sets per-tx, omit day so MCP mirrors (sign_tools: day = tx).
      const dayRaw = req.auto_sign?.max_per_day_usd;
      const r = await enableAutoSign(mcp, {
        wallet: trader,
        userId: userId || trader,
        maxPerTxUsd: tx,
        ...(dayRaw != null && dayRaw !== "" ? { maxPerDayUsd: dayRaw } : {}),
      });
      const dayShown = dayRaw != null && dayRaw !== "" ? dayRaw : tx;
      return {
        kind: r.error ? "error" : "answer",
        message:
          (r.summary as string) ||
          (r.message as string) ||
          `Auto-sign / auto-approve enabled with your caps: $${tx} per tx · $${dayShown} per day.`,
        data: factsForUi({
          ...r,
          max_per_tx_usd: tx,
          max_per_day_usd: dayShown,
          default_cap_usd: defaultCapUsdFromMcp(r),
        }),
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

    // Liquidation / HF guardrails on health reads (standing safety agent).
    if (routed.tool === "vanna_get_account_health") {
      const hf = Number(
        (data as Record<string, unknown>).health_factor ??
          (data as Record<string, unknown>).hf ??
          (data as Record<string, unknown>).avg_health_factor,
      );
      const userFloor = parseMinHealthFactor(ctx.message);
      const floor = userFloor ?? 1.3;
      if (Number.isFinite(hf)) {
        if (hf < 1.0) {
          prose +=
            `\n\nURGENT: health factor ${hf.toFixed(2)} is below 1.00 — this account is liquidatable. ` +
            `Repay debt or deposit collateral now (e.g. “repay 5 AQUSDC” or “deposit 20 XLM as collateral”). ` +
            `I will not auto-move funds without your go-ahead on this turn; say “repay what I need to get safe” to act.`;
        } else if (hf < floor) {
          prose +=
            `\n\nCaution: HF ${hf.toFixed(2)} is below your safety floor (${floor}). ` +
            `Avoid new borrows; consider repay or more collateral to stay clear of liquidation.`;
        } else if (userFloor != null) {
          prose += `\n\nYour floor HF ≥ ${userFloor} is currently satisfied (HF ${hf.toFixed(2)}).`;
        }
      }
    }

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
    // Health on large/active accounts often hits Soroban Budget ExceededLimit.
    // Fall back to collateral + debt reads so the user still gets real numbers.
    if (
      routed.tool === "vanna_get_account_health" &&
      e instanceof Error &&
      /Budget|ExceededLimit|resource/i.test(e.message)
    ) {
      try {
        const mcp = getMcpClient();
        const sa = ctx.smartAccount;
        const [col, debt] = await Promise.all([
          mcp.call("vanna_get_collateral", sa ? { smart_account: sa } : {}, ctx.userId).catch(() => null),
          mcp.call("vanna_get_debt", sa ? { smart_account: sa } : {}, ctx.userId).catch(() => null),
        ]);
        const colUsd = col ? Number((col as any).total_value_usd ?? 0) : null;
        const debtUsd = debt ? Number((debt as any).total_debt_usd ?? 0) : null;
        const hf =
          colUsd != null && debtUsd != null && debtUsd > 0.01
            ? colUsd / debtUsd
            : colUsd != null && colUsd > 0
              ? 999
              : null;
        const parts = [
          "Full health endpoint hit a Soroban CPU budget limit on this account — using collateral + debt instead:",
        ];
        if (colUsd != null) parts.push(`collateral ~$${colUsd.toFixed(2)}`);
        if (debtUsd != null) parts.push(`debt ~$${debtUsd.toFixed(2)}`);
        if (hf != null) {
          parts.push(
            hf >= 999
              ? "health factor ∞ (no meaningful debt)"
              : `approx health factor ${hf.toFixed(2)} (collateral ÷ debt)`,
          );
        }
        return {
          kind: "answer",
          message: parts.join(" · "),
          data: factsForUi({
            collateral: col,
            debt,
            approx_health_factor: hf,
            note: "fallback_from_budget_exceeded",
          }),
          intent: { template_id: "query_account_health", slots: { mode: "collateral_debt_fallback" } },
          mcp: { tool: "vanna_get_collateral+vanna_get_debt", has_unsigned_xdr: false },
          request_id: ctx.request_id,
        };
      } catch {
        /* fall through */
      }
    }
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
  // LP / swap keep explicit token legs — do not force USDC variant chips on them
  // when asset is already AQUSDC/BLUSDC/SOUSDC. Bare USDC on lend/deposit still chips.
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
    // Protocol collateral allowlist: XLM, AQUSDC, SOUSDC, USDC (BLUSDC → MCP USDC).
    let userAsset = action.asset || "XLM";
    if (/^blusdc$/i.test(userAsset)) {
      // Map Blend USDC label → margin USDC collateral (MCP symbol USDC)
      userAsset = "BLUSDC";
    }
    const uiAsset = displayUsdcLabel(marginCollateralSymbol(userAsset), userAsset);
    const levLine = formatLeveragePlanLine(deposit, borrow, action.leverage, uiAsset);
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
      `  ${levLine}\n` +
      `  Step 1/2 — Deposit ${amount(deposit)} ${uiAsset} as collateral  ← now\n` +
      `  Step 2/2 — Borrow ${amount(borrow)} ${uiAsset} after step 1 confirms\n` +
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
          label: `Borrow ${borrow} ${uiAsset}`,
          step: 2,
          total_steps: 2,
        },
      };
    }
    return step1Res;
  }

  // ── Levered Blend farm → NEVER use atomic deposit_borrow_and_deploy ─────
  // Atomic hits Soroban Budget/ExceededLimit on populated testnet pools.
  // Same fallback as one-click-strategy / leverage-assets-tab: split into
  // deposit → borrow → plain supply_to_blend (3 signed legs, agent-chained).
  if (
    (action.op === "deploy_to_blend" || action.op === "supply_to_blend") &&
    action.leverage != null &&
    action.leverage > 1
  ) {
    const dep = action.amount;
    if (dep == null || !(dep > 0)) {
      return {
        kind: "clarification",
        message:
          `How much to farm on Blend at ${action.leverage}×? ` +
          `e.g. “farm Blend at ${action.leverage}x with 20 BLUSDC”.`,
        intent: {
          template_id: "deploy_to_blend",
          slots: { asset: action.asset, amount: null, leverage: action.leverage },
        },
        request_id: ctx.request_id,
      };
    }
    // Full L−1 borrow for advertised Nx; protocol can_borrow still gates.
    const { deposit, borrow } = splitLeverageAmounts(dep, action.leverage, null);
    const userAsset = action.asset || "BLUSDC";
    const uiAsset = displayUsdcLabel(marginCollateralSymbol(userAsset), userAsset);
    // After deposit+borrow, free balance ≈ borrowed amount (collateral is locked).
    // Supply the free/borrowed leg to Blend (matches what SA can spend).
    const supplyAmt = borrow > 0 ? borrow : deposit;
    const levLine = formatLeveragePlanLine(deposit, borrow, action.leverage, uiAsset);
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
      message: `step 1/3 farm Blend deposit ${deposit} ${uiAsset}`,
    });
    const planNote =
      `\n\nBlend farm plan (3 steps — avoids Soroban Budget limit on atomic deploy):\n` +
      `  ${levLine}\n` +
      `  Step 1/3 — Deposit ${amount(deposit)} ${uiAsset} as collateral  ← now\n` +
      `  Step 2/3 — Borrow ${amount(borrow)} ${uiAsset} (free balance in margin account)\n` +
      `  Step 3/3 — Supply ${amount(supplyAmt)} ${uiAsset} free balance to Blend\n` +
      `Auto-approve runs each next step after the previous confirms on-chain.`;
    if (
      step1Res.kind === "needs_wallet_sign" ||
      step1Res.kind === "needs_auto_sign" ||
      step1Res.kind === "executed"
    ) {
      return {
        ...step1Res,
        message: (step1Res.message || "") + planNote,
        intent: {
          template_id: "deploy_to_blend_split",
          slots: {
            step: 1,
            deposit,
            borrow,
            supply: supplyAmt,
            asset: userAsset,
            leverage: action.leverage,
          },
        },
        next_step: {
          op: "borrow",
          asset: userAsset,
          amount: borrow,
          leverage: action.leverage,
          label: `Borrow ${borrow} ${uiAsset}`,
          step: 2,
          total_steps: 3,
          follow_up: {
            op: "supply_to_blend",
            asset: userAsset,
            amount: supplyAmt,
            leverage: null,
            label: `Supply ${supplyAmt} ${uiAsset} to Blend`,
            step: 3,
            total_steps: 3,
          },
        },
      };
    }
    return step1Res;
  }

  // Max-yield / “invest where I earn most” / Sanujit EW5 highest-yielding pool.
  // Ranks Vanna Earn (+ optional Blend when user said farm) then rewrites asset/op.
  let highestPickNote = "";
  let highestPickFacts: Record<string, unknown> | null = null;
  const wantsMaxYield =
    action.prefer_max_yield === true ||
    /highest[\s-]*yielding|best[\s-]*yielding|highest[\s-]*apy|best[\s-]*apy|highest-?\s*yielding|max(?:imum)?\s*yield|best\s*return|invest.*(?:most|max|best)|earn me/i.test(
      ctx.message,
    );
  if ((action.op === "lend" || action.op === "supply" || action.op === "deploy_to_blend") && wantsMaxYield) {
    try {
      const namedFarm = /\bfarm|blend\b/i.test(ctx.message);
      const riskAverse =
        action.min_hf != null ||
        /\b(no liquidat|avoid liquidat|never liquidat|maximum profit with no|safe|keep.*health)/i.test(
          ctx.message,
        );
      // Wallet "invest N XLM" is earn-lend by default. Blend supply needs free C-balance
      // and often hits Soroban Budget on plain execute — don't auto-route there when the
      // user also asked for no liquidation / HF floor unless they only said farm.
      const includeFarm = namedFarm && !riskAverse && (action.leverage == null || action.leverage <= 1);
      const pick = await pickBestYieldVenue(getMcpClient(), ctx.userId, {
        includeFarm,
        preferredAsset: action.asset,
        preferEarn: riskAverse || !namedFarm,
      });
      if (pick) {
        if (pick.venue === "blend" && !riskAverse) {
          action = {
            ...action,
            op: "deploy_to_blend",
            asset: pick.symbol,
            leverage: action.leverage != null && action.leverage > 1 ? action.leverage : null,
            requires_account: true,
          };
        } else {
          // Risk-averse or Earn winner: lend from wallet (no leverage, no Blend budget).
          action = {
            ...action,
            op: "lend",
            asset: pick.symbol === "BLUSDC" && action.asset === "XLM" ? "XLM" : pick.symbol,
            requires_account: false,
            leverage: null,
          };
          // Prefer matching the user's asset when ranking was earn XLM.
          if (action.asset && /\bxlm\b/i.test(ctx.message) && pick.symbol !== "XLM") {
            // Keep highest earn even if not XLM — note in summary.
          }
        }
        highestPickNote =
          `I compared live yields` +
          (riskAverse
            ? ` (preferring Vanna Earn because you asked for HF safety / no liquidation)`
            : "") +
          ` and chose ${pick.venue === "blend" && !riskAverse ? "Blend farm" : "Vanna Earn"} ` +
          `${action.asset} at ~${pick.supply_apy_pct}% supply APY.\n` +
          `Ranking: ${pick.ranking}.\n` +
          (namedFarm && riskAverse
            ? `Note: Blend often shows higher APY but needs free C-balance and can hit Soroban budget; Earn is the reliable “max profit without liquidation” path for wallet funds.\n`
            : "") +
          `\n`;
        highestPickFacts = {
          chosen_pool: action.asset,
          chosen_venue: pick.venue === "blend" && !riskAverse ? "blend" : "earn",
          chosen_supply_apy_pct: pick.supply_apy_pct,
          pool_ranking: pick.ranking,
          selection: "max_yield_agent",
          risk_averse: riskAverse,
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

  // DEX swap — prefer one MCP call: server auto-quotes from oracle when
  // expected_out/min_out omitted (after MCP redeploy). Optionally pre-quote
  // with a single prices batch for older MCP deploys that still require floors.
  let swapExpectedOut: string | null = null;
  let swapMinOut: string | null = null;
  let swapSlippagePct = "0.5";
  if (action.op === "swap") {
    if (action.amount == null || !(action.amount > 0)) {
      return {
        kind: "clarification",
        message:
          "How much do you want to swap? e.g. “swap 20 XLM to USDC via aquarius” or “swap 5 USDC to XLM on soroswap”.",
        intent: { template_id: "swap", slots: { amount: null } },
        request_id: ctx.request_id,
      };
    }
    if (!smartAccount) {
      return {
        kind: "unavailable",
        message: "Swap needs a margin (smart) account with free balance of the input token.",
        request_id: ctx.request_id,
      };
    }
    const venue = (action.venue || "aquarius").toLowerCase().includes("soro")
      ? "soroswap"
      : "aquarius";
    action = { ...action, venue };
    // Best-effort pre-quote (one batch call). If it fails, mapOp still sends the
    // swap and MCP may auto-quote after redeploy.
    const tokenIn = (action.token_a || action.asset || "XLM").toUpperCase();
    const tokenOut = (action.token_b || "USDC").toUpperCase();
    const oracleIn = tokenIn === "XLM" || tokenIn === "AQUA" ? tokenIn : "USDC";
    const oracleOut = tokenOut === "XLM" || tokenOut === "AQUA" ? tokenOut : "USDC";
    try {
      const batch = await getMcpClient().call(
        "vanna_get_prices_batch",
        { symbols: [oracleIn, oracleOut] },
        ctx.userId,
      );
      const prices = (batch.prices || batch) as Record<string, { price_usd?: string | number }>;
      const pin = Number(prices[oracleIn]?.price_usd ?? prices[oracleIn.toLowerCase()]?.price_usd);
      const pout = Number(prices[oracleOut]?.price_usd ?? prices[oracleOut.toLowerCase()]?.price_usd);
      if (Number.isFinite(pin) && Number.isFinite(pout) && pout > 0) {
        const expected = (action.amount * pin) / pout;
        const slip = 0.5;
        swapExpectedOut = expected.toFixed(7);
        swapMinOut = (expected * (1 - slip / 100)).toFixed(7);
        swapSlippagePct = String(slip);
      }
    } catch {
      /* MCP auto-quote or retry path */
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
      venue: action.venue,
      expected_out: swapExpectedOut,
      min_out: swapMinOut,
      slippage_pct: swapSlippagePct,
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
    const xdr = result.unsigned_xdr ?? null;
    const xdrNote =
      xdr && xdr.length > 20
        ? `\n\nWallet sign required — full unsigned_xdr is attached (${xdr.length} chars). Use Approve & sign / Freighter; do not invent a hash.`
        : "\n\nWallet sign required but MCP returned no unsigned_xdr — rebuild the transaction.";
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
      message: (highestPickNote || "") + result.message + xdrNote,
      data: factsForUi({
        ...result.build,
        ...(highestPickFacts || {}),
        action_label: mapped.step.label,
        has_unsigned_xdr: Boolean(xdr && xdr.length > 20),
        unsigned_xdr_chars: xdr?.length ?? 0,
      }),
      unsigned_xdr: xdr,
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
            description: "MCP default caps (see default_cap_usd)",
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

// ── Multi-step plans (MultiLegAgent: expand → execute → observe → report) ─

/**
 * Sample approx HF after a margin-affecting leg.
 * Prefer health tool; on Budget/ExceededLimit use collateral÷debt fallback.
 */
async function sampleApproxHf(
  userId: string,
  smartAccount: string | null,
  trader: string | null,
): Promise<number | null> {
  if (!smartAccount && !trader) return null;
  const mcp = getMcpClient();
  const args: Record<string, unknown> = {};
  if (smartAccount) args.smart_account = smartAccount;
  if (trader) args.trader = trader;
  try {
    const r = (await mcp.call("vanna_get_account_health", args, userId)) as Record<string, unknown>;
    const direct = Number(r.health_factor ?? r.hf ?? r.avg_health_factor);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const col = Number(r.collateral_usd ?? r.total_collateral_usd ?? 0);
    const debt = Number(r.debt_usd ?? r.total_debt_usd ?? 0);
    if (debt > 0.01 && col > 0) return col / debt;
    if (col > 0 && debt <= 0.01) return 999;
    return null;
  } catch (e) {
    if (!(e instanceof Error) || !/Budget|ExceededLimit|resource/i.test(e.message)) return null;
    try {
      const saArgs = smartAccount ? { smart_account: smartAccount } : {};
      const [col, debt] = await Promise.all([
        mcp.call("vanna_get_collateral", saArgs, userId).catch(() => null),
        mcp.call("vanna_get_debt", saArgs, userId).catch(() => null),
      ]);
      const colUsd = col ? Number((col as any).total_value_usd ?? 0) : null;
      const debtUsd = debt ? Number((debt as any).total_debt_usd ?? 0) : null;
      if (colUsd != null && debtUsd != null && debtUsd > 0.01) return colUsd / debtUsd;
      if (colUsd != null && colUsd > 0 && (debtUsd == null || debtUsd <= 0.01)) return 999;
    } catch {
      /* ignore */
    }
    return null;
  }
}

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
  const mcp = getMcpClient();
  let smartAccount = ctx.smartAccount;
  const minHf = parseMinHealthFactor(ctx.message);
  const facts: Record<string, unknown> = {
    plan_summary: plan.summary,
    min_hf: minHf,
    multi_leg_agent: true,
  };
  const multiSteps: MultiLegStep[] = [];
  let stepIndex = 0;
  let finalHf: number | null = null;
  let lastPartial: ChatResponse | null = null;

  // ── Phase A: optional plan reads (not expanded) ─────────────────────────
  for (const step of plan.steps.slice(0, 8)) {
    if (step.kind !== "read" || !step.tool) continue;
    stepIndex += 1;
    if (needsSmartAccount(step.tool) && !smartAccount && ctx.trader) {
      smartAccount = await resolveSmartAccount(mcp, ctx.trader, ctx.userId);
    }
    const built = buildToolArgs(step.tool, step.args || {}, {
      trader: ctx.trader,
      smartAccount,
    });
    if (built.blocker) {
      multiSteps.push({
        index: stepIndex,
        op: step.tool,
        label: step.tool,
        status: "skipped",
        message: built.blocker,
      });
      continue;
    }
    try {
      const data = await mcp.call(step.tool, built.args, ctx.userId);
      facts[step.tool] = data;
      multiSteps.push({
        index: stepIndex,
        op: step.tool,
        label: step.tool,
        status: "ok",
        message: "read ok",
      });
    } catch (e) {
      multiSteps.push({
        index: stepIndex,
        op: step.tool,
        label: step.tool,
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── Phase B: expand nested multi-leg writes into atomic legs ────────────
  // e.g. deploy_to_blend@2x → deposit_collateral, borrow, supply_to_blend
  // Server executes legs in order (no client hop for the happy auto-sign path).
  const expanded = expandPlanWrites(plan.steps);
  facts.expanded_legs = expanded.map((w) => ({
    op: w.op,
    asset: w.asset,
    amount: w.amount,
    leverage: w.leverage,
    label: w.label,
  }));
  facts.smart_account = smartAccount;

  // ── Phase B0: preflight (wallet balance, account presence) ──────────────
  // Hard block → no writes. Soft warn → continue (recorded in facts).
  if (expanded.length > 0) {
    try {
      const issues = await preflightExpandedLegs(mcp, expanded, {
        userId: ctx.userId,
        trader: ctx.trader,
        smartAccount,
      });
      facts.preflight = issues;
      const blocks = issues.filter((i) => i.severity === "block");
      if (blocks.length) {
        for (const b of blocks) {
          stepIndex += 1;
          multiSteps.push({
            index: stepIndex,
            op: b.op,
            label: b.label,
            status: "blocked",
            message: b.message,
          });
        }
        for (const rest of expanded) {
          stepIndex += 1;
          multiSteps.push({
            index: stepIndex,
            op: rest.op,
            label: rest.label,
            asset: rest.asset,
            amount: rest.amount,
            leverage: rest.leverage,
            status: "skipped",
            message: "Skipped — preflight blocked earlier step",
          });
        }
        return {
          kind: "blocked",
          message: multiLegHeadline(multiSteps),
          data: multiLegUiData({
            steps: multiSteps,
            summary: plan.summary || "Multi-step strategy",
            minHf,
            finalHf,
            smartAccount,
            extra: { preflight_blocked: true },
          }),
          intent: { template_id: plan.template_id, slots: { preflight: true } },
          execution: { status: "preflight_blocked", steps: multiSteps.map(toExecutionStep) },
          request_id: ctx.request_id,
        };
      }
    } catch {
      /* preflight is best-effort — never block the whole agent on preflight crash */
    }
  }

  const totalWriteLegs = expanded.length;
  let writeCursor = 0;

  for (const w of expanded) {
    writeCursor += 1;
    stepIndex += 1;

    // Need amount for write ops (except open/close account)
    const amountOptional = ["create_account", "open_account", "close_account", "settle_account"].includes(
      w.op,
    );
    if (!amountOptional && (w.amount == null || !(w.amount > 0))) {
      const msg =
        w.op === "lend" || w.op === "supply"
          ? `How much do you want to ${w.op === "lend" ? "lend / park" : "supply"}? e.g. “park 20 XLM for yield”.`
          : `Amount missing for “${w.label}”. Include a size like “10 BLUSDC” or “20 XLM”.`;
      multiSteps.push({
        index: stepIndex,
        op: w.op,
        label: w.label,
        asset: w.asset,
        amount: w.amount,
        leverage: w.leverage,
        status: "clarification",
        message: msg,
      });
      // Mark remaining as skipped
      for (let j = writeCursor; j < totalWriteLegs; j++) {
        const rest = expanded[j];
        stepIndex += 1;
        multiSteps.push({
          index: stepIndex,
          op: rest.op,
          label: rest.label,
          asset: rest.asset,
          amount: rest.amount,
          status: "skipped",
          message: "Skipped — earlier leg needs amount",
        });
      }
      return {
        kind: "clarification",
        message: multiLegHeadline(multiSteps),
        data: multiLegUiData({
          steps: multiSteps,
          summary: plan.summary || "Multi-step strategy",
          minHf,
          finalHf,
          smartAccount,
        }),
        intent: { template_id: plan.template_id, slots: { stopped_at: w.op } },
        execution: { status: "stopped", steps: multiSteps.map(toExecutionStep) },
        request_id: ctx.request_id,
      };
    }

    if (!["lend", "redeem", "create_account"].includes(w.op) && !smartAccount && ctx.trader) {
      smartAccount = await resolveSmartAccount(mcp, ctx.trader, ctx.userId);
      facts.smart_account = smartAccount;
    }

    // Atomic legs only — expandPlanWrites already split levered farm / deposit+borrow.
    // multi_leg:false prevents runWrite from re-splitting and returning next_step early.
    const action = actionFromExpanded(w, {
      smartAccount,
      trader: ctx.trader,
      minHf,
    });
    action.multi_leg = false;
    action.requires_amount = !amountOptional;
    action.leverage = w.leverage ?? null;

    const writeRes = await runWrite(action, {
      ...ctx,
      smartAccount,
      // Avoid raw multi-goal text re-triggering negative-amount / max-yield heuristics
      message: `multi-leg step ${writeCursor}/${totalWriteLegs}: ${w.label}`,
    });
    lastPartial = writeRes;

    if (writeRes.data && typeof writeRes.data === "object") {
      Object.assign(facts, { [`leg_${writeCursor}_${w.op}`]: writeRes.data });
    }

    const status = statusFromWriteResult(writeRes);
    const txHash = extractTxHash(writeRes);
    let hfAfter: number | null = null;

    if (status === "ok" && affectsHealth(w.op) && smartAccount) {
      hfAfter = await sampleApproxHf(ctx.userId, smartAccount, ctx.trader);
      if (hfAfter != null) finalHf = hfAfter;
    }

    multiSteps.push({
      index: stepIndex,
      op: w.op,
      label: w.label,
      asset: w.asset,
      amount: w.amount,
      leverage: w.leverage,
      status,
      message: humanizeLegError((writeRes.message || "").slice(0, 400)),
      tx_hash: txHash,
      hf_after: hfAfter,
    });

    const planSummary = plan.summary || "Multi-step strategy";
    const packUi = (extra?: Record<string, unknown>) =>
      multiLegUiData({
        steps: multiSteps,
        summary: planSummary,
        minHf,
        finalHf,
        smartAccount,
        extra,
      });

    // ── Stop: needs signature ─────────────────────────────────────────────
    if (status === "needs_sign") {
      const remaining = expanded.slice(writeCursor);
      for (const rest of remaining) {
        stepIndex += 1;
        multiSteps.push({
          index: stepIndex,
          op: rest.op,
          label: rest.label,
          asset: rest.asset,
          amount: rest.amount,
          status: "pending",
          message: "Waiting for signature on the previous step",
        });
      }
      return {
        ...writeRes,
        // Keep needs_* kind so client can auto-sign / wallet-sign
        message: multiLegHeadline(multiSteps),
        data: packUi({ remaining_legs: remaining }),
        intent: {
          template_id: plan.template_id,
          slots: { stopped_at: w.op, step: writeCursor, total: totalWriteLegs },
        },
        next_step:
          writeRes.next_step || remainingNextStep(remaining, writeCursor + 1, totalWriteLegs),
        execution: {
          status: writeRes.kind,
          tx_hash: txHash,
          steps: multiSteps.map(toExecutionStep),
        },
        request_id: ctx.request_id,
      };
    }

    // ── Stop: error / blocked / clarification ─────────────────────────────
    if (status === "error" || status === "blocked" || status === "clarification") {
      const remaining = expanded.slice(writeCursor);
      for (const rest of remaining) {
        stepIndex += 1;
        multiSteps.push({
          index: stepIndex,
          op: rest.op,
          label: rest.label,
          asset: rest.asset,
          amount: rest.amount,
          status: "skipped",
          message: "Skipped — earlier step did not complete",
        });
      }
      // Use answer/clarification (not raw error) so the UI shows a strategy card,
      // not a red wall of text. Details live in multi_leg_steps.
      const kindOut =
        status === "clarification"
          ? ("clarification" as const)
          : status === "blocked"
            ? ("blocked" as const)
            : ("answer" as const);
      return {
        kind: kindOut,
        message: multiLegHeadline(multiSteps),
        data: packUi({ stopped_reason: status }),
        intent: {
          template_id: plan.template_id,
          slots: { stopped_at: w.op, reason: status },
        },
        clarify_options: writeRes.clarify_options,
        pending_write: writeRes.pending_write,
        execution: {
          status: "stopped",
          tx_hash: txHash,
          steps: multiSteps.map(toExecutionStep),
        },
        request_id: ctx.request_id,
      };
    }

    // ── Stop: HF floor breached after a successful margin leg ─────────────
    if (
      status === "ok" &&
      minHf != null &&
      hfAfter != null &&
      hfAfter < minHf &&
      writeCursor < totalWriteLegs
    ) {
      const remaining = expanded.slice(writeCursor);
      multiSteps[multiSteps.length - 1] = {
        ...multiSteps[multiSteps.length - 1],
        status: "stopped_hf",
        message:
          `HF ≈ ${hfAfter.toFixed(2)} fell below floor ${minHf} after this leg. ` +
          `Further borrows/supplies stopped. Earlier txs above are real.`,
      };
      for (const rest of remaining) {
        stepIndex += 1;
        multiSteps.push({
          index: stepIndex,
          op: rest.op,
          label: rest.label,
          asset: rest.asset,
          amount: rest.amount,
          status: "skipped",
          message: `Skipped — HF floor ${minHf} breached`,
        });
      }
      return {
        kind: "executed",
        message: multiLegHeadline(multiSteps),
        data: multiLegUiData({
          steps: multiSteps,
          summary: plan.summary || "Multi-step strategy",
          minHf,
          finalHf: hfAfter,
          smartAccount,
          extra: { hf_stopped: true },
        }),
        intent: {
          template_id: plan.template_id,
          slots: { stopped_hf: true, hf_after: hfAfter, min_hf: minHf },
        },
        execution: {
          status: "stopped_hf",
          tx_hash: txHash,
          steps: multiSteps.map(toExecutionStep),
        },
        request_id: ctx.request_id,
      };
    }

  }

  // ── Phase C: final report ───────────────────────────────────────────────
  if (finalHf == null && smartAccount && multiSteps.some((s) => s.status === "ok" && affectsHealth(s.op))) {
    finalHf = await sampleApproxHf(ctx.userId, smartAccount, ctx.trader);
  }

  const anyOk = multiSteps.some((s) => s.status === "ok");
  const allOk = multiSteps.length > 0 && multiSteps.every((s) => s.status === "ok");
  const lastHash =
    [...multiSteps].reverse().find((s) => s.tx_hash)?.tx_hash ??
    (lastPartial ? extractTxHash(lastPartial) : null);

  return {
    kind: anyOk || allOk ? "executed" : "answer",
    message: multiLegHeadline(multiSteps),
    data: multiLegUiData({
      steps: multiSteps,
      summary: plan.summary || "Multi-step strategy",
      minHf,
      finalHf,
      smartAccount,
      extra: { all_legs_ok: allOk },
    }),
    intent: { template_id: plan.template_id, slots: { legs: multiSteps.length } },
    execution: {
      status: allOk ? "completed" : anyOk ? "partial" : "stopped",
      tx_hash: lastHash,
      steps: multiSteps.map(toExecutionStep),
    },
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
  const pick = await pickBestYieldVenue(mcp, userId, { includeFarm: false });
  if (!pick) return null;
  return { symbol: pick.symbol, supply_apy_pct: pick.supply_apy_pct, ranking: pick.ranking };
}

/**
 * Agent ranking: Earn pools always; Blend reserves when `includeFarm` (user said farm /
 * invest wherever). Winner drives auto-route lend vs supply_to_blend.
 * BLUSDC / AQUSDC / SOUSDC stay distinct — never merged.
 */
async function pickBestYieldVenue(
  mcp: ReturnType<typeof getMcpClient>,
  userId: string,
  opts: {
    includeFarm?: boolean;
    preferredAsset?: string | null;
    /** When true, only Earn rows win (still show Blend in ranking if loaded). */
    preferEarn?: boolean;
  } = {},
): Promise<{
  symbol: string;
  venue: "earn" | "blend";
  supply_apy_pct: string | number;
  ranking: string;
} | null> {
  const rows: Array<{
    symbol: string;
    venue: "earn" | "blend";
    apy: number;
    apyRaw: string | number;
  }> = [];

  const earnPools = [
    { query: "XLM", display: "XLM" },
    { query: "USDC", display: "BLUSDC" },
    { query: "AQUSDC", display: "AQUSDC" },
    { query: "SOUSDC", display: "SOUSDC" },
  ] as const;
  for (const p of earnPools) {
    try {
      const data = await mcp.call("vanna_get_pool_stats", { symbol: p.query }, userId);
      if (data.error) continue;
      const apyRaw = (data.supply_apy_pct ?? data.supply_apr_pct) as string | number;
      const apy = Number(apyRaw);
      if (Number.isFinite(apy)) rows.push({ symbol: p.display, venue: "earn", apy, apyRaw });
    } catch {
      /* skip */
    }
  }

  if (opts.includeFarm || opts.preferEarn) {
    // Always load Blend for ranking transparency when farm was mentioned.
    try {
      const blend = await mcp.call("vanna_list_blend_reserves", {}, userId);
      const reserves = Array.isArray(blend.reserves)
        ? (blend.reserves as Array<Record<string, unknown>>)
        : [];
      for (const r of reserves) {
        const symRaw = String(r.symbol || "").toUpperCase();
        const symbol = symRaw === "USDC" ? "BLUSDC" : symRaw || "XLM";
        const apyRaw = (r.supply_apy_pct ?? r.supply_apr_pct) as string | number;
        const apy = Number(apyRaw);
        if (Number.isFinite(apy)) {
          rows.push({ symbol, venue: "blend", apy, apyRaw });
        }
      }
    } catch {
      /* skip farm */
    }
  }

  if (!rows.length) return null;

  const prefer = (opts.preferredAsset || "").toUpperCase();
  const ranking = [...rows]
    .sort((a, b) => b.apy - a.apy)
    .slice(0, 8)
    .map((r) => `${r.venue}/${r.symbol} ${r.apyRaw}%`)
    .join(" · ");

  // Candidates for execution
  let candidates = opts.preferEarn ? rows.filter((r) => r.venue === "earn") : [...rows];
  if (!candidates.length) candidates = rows.filter((r) => r.venue === "earn");
  if (!candidates.length) candidates = [...rows];

  candidates.sort((a, b) => b.apy - a.apy);
  if (prefer && prefer !== "USDC") {
    const filtered = candidates.filter(
      (r) => r.symbol === prefer || (prefer === "XLM" && r.symbol === "XLM"),
    );
    if (filtered.length) candidates = filtered.sort((a, b) => b.apy - a.apy);
  }

  const best = candidates[0]!;
  return {
    symbol: best.symbol,
    venue: best.venue,
    supply_apy_pct: best.apyRaw,
    ranking,
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
