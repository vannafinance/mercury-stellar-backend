/**
 * Deterministic intent router (keyword + regex).
 * Primary path when no external LLM is configured; always available as fallback.
 *
 * Strips G/C Stellar addresses before parsing amounts so digits inside addresses
 * never become fake quantities.
 */

import type { RoutedIntent } from "./types";

const ASSETS = ["BLUSDC", "AQUSDC", "SOUSDC", "USDC", "XLM", "AQUA", "EURC"] as const;

const ADDR_RE = /\b[GC][A-Z0-9]{55,56}\b/g;
const AMOUNT_ASSET_RE = /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC)\b/i;
const BARE_AMOUNT_RE = /(\d+(?:\.\d+)?)/;
const LEVERAGE_RE = /(\d+(?:\.\d+)?)\s*x\b/i;

function stripAddresses(message: string): string {
  return message.replace(ADDR_RE, " ");
}

function findAsset(text: string): string | null {
  const upper = text.toUpperCase();
  for (const a of ASSETS) {
    if (upper.includes(a)) return a === "BLUSDC" || a === "AQUSDC" || a === "SOUSDC" ? a : a;
  }
  return null;
}

function findAmount(text: string): number | null {
  const cleaned = stripAddresses(text);
  // Explicit negative amounts (Sanujit EW8) — return the signed value so
  // validateLendParams can reject them instead of dropping the sign.
  const negWithAsset = cleaned.match(/(-\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC)\b/i);
  if (negWithAsset) {
    const n = Number(negWithAsset[1]);
    return Number.isFinite(n) ? n : null;
  }
  const withAsset = cleaned.match(AMOUNT_ASSET_RE);
  if (withAsset) {
    const n = Number(withAsset[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Avoid treating leverage "5x" as an amount.
  const noLev = cleaned.replace(LEVERAGE_RE, " ");
  const m = noLev.match(BARE_AMOUNT_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findLeverage(text: string): number | null {
  const m = text.match(LEVERAGE_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function has(text: string, ...words: string[]): boolean {
  return words.every((w) => text.includes(w));
}

function any(text: string, ...words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/**
 * Route a natural-language message to a read tool, write action, restricted op, or clarify.
 */
export function routeMessage(message: string): RoutedIntent {
  const raw = message.trim();
  if (!raw) {
    return { kind: "clarify", message: "Please type a question or action." };
  }
  const text = raw.toLowerCase();
  const asset = findAsset(raw);
  const amount = findAmount(raw);
  const leverage = findLeverage(raw);

  // ── restricted ──────────────────────────────────────────────────────────
  if (any(text, "liquidate", "liquidation of")) {
    return {
      kind: "restricted",
      template_id: "liquidate",
      reason: "Liquidation of other accounts is a restricted keeper/protocol action — the copilot won't run it.",
    };
  }

  // ── writes (checked before reads that share words like "borrow") ────────
  if (any(text, "create smart account", "create margin account", "open a margin account", "open margin account", "create my smart account", "open a smart account")) {
    return {
      kind: "write",
      op: "create_account",
      template_id: "create_account",
      requires_account: false,
      requires_amount: false,
    };
  }

  if (
    (has(text, "deposit") && any(text, "borrow")) ||
    any(text, "deposit and borrow", "deposit + borrow", "lever up", "leveraged position") ||
    (leverage != null && leverage > 1 && any(text, "blend", "leverage", "lever"))
  ) {
    return {
      kind: "write",
      op: "deposit_and_borrow",
      template_id: "deposit_and_borrow",
      asset: asset ?? "USDC",
      amount,
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
      leverage,
    };
  }

  if (any(text, "repay", "pay back", "payback", "clear my loan", "pay off")) {
    return {
      kind: "write",
      op: "repay",
      template_id: "repay",
      asset: asset ?? "USDC",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }

  if (any(text, "borrow") && !any(text, "can i borrow", "how much can i borrow", "borrow apr", "borrow rate")) {
    return {
      kind: "write",
      op: "borrow",
      template_id: "borrow",
      asset: asset ?? "USDC",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }

  if (
    (any(text, "deposit") && any(text, "collateral")) ||
    any(text, "add collateral", "post collateral", "as collateral")
  ) {
    return {
      kind: "write",
      op: "deposit_collateral",
      template_id: "deposit_collateral",
      asset: asset ?? "USDC",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }

  if (
    (any(text, "withdraw") && any(text, "collateral")) ||
    any(text, "take out collateral", "pull collateral")
  ) {
    return {
      kind: "write",
      op: "withdraw_collateral",
      template_id: "withdraw_collateral",
      asset: asset ?? "USDC",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }

  // Farm — supply / deploy to Blend (margin account → Blend reserve).
  // Must win over bare deposit_collateral and earn lend.
  if (
    any(text, "to blend", "into blend", "on blend", "blend reserve") &&
    (any(text, "supply", "deposit", "deploy", "farm") || has(text, "blend"))
  ) {
    const isReadOnly =
      any(text, "stats", "apy", "how much", "position", "btoken", "b-token") &&
      !any(text, "supply", "deposit", "deploy");
    if (!isReadOnly) {
      return {
        kind: "write",
        op: "deploy_to_blend",
        template_id: "deploy_to_blend",
        asset: asset ?? "XLM",
        amount,
        multi_leg: true,
        requires_account: true,
        requires_amount: true,
        leverage: leverage ?? null,
      };
    }
  }

  // Align with zip brain (direct.py): bare "deposit" → margin collateral.
  // Earn supply uses lend/supply/earn/pool phrasing (incl. "earn yield on my XLM").
  // Do NOT match "supply APY" / "supply APR" — those are pool-stat reads.
  // Do NOT steal Blend/Farm writes ("supply 10 XLM to Blend").
  const isSupplyApyRead = any(text, "supply apy", "supply apr", "borrow apy", "borrow apr");
  const isBlendOrFarmVenue = any(text, "blend", "farm", "aquarius", "soroswap", "bToken", "btoken", "lp ");
  // Word-boundary "lend" so "lending pool" (a READ) does not become a write.
  const hasLendVerb = /\blend\b/.test(text);
  const wantsHighestPool =
    any(text, "highest-yielding", "highest yielding", "best yielding", "highest apy", "best apy") &&
    any(text, "supply", "lend", "deposit");
  const isLendWrite =
    !isSupplyApyRead &&
    !isBlendOrFarmVenue &&
    (hasLendVerb ||
      any(text, "earn yield", "yield on my", "want to earn") ||
      wantsHighestPool ||
      (any(text, "supply") &&
        !any(text, "supplied", "have i supplied", "my supply", "total supplied")) ||
      (any(text, "deposit") &&
        any(text, "pool", "earn", "vault", "to the pool", "into the pool", "to earn")));
  if (isLendWrite) {
    return {
      kind: "write",
      op: "lend",
      template_id: wantsHighestPool ? "lend_highest" : "lend",
      asset: asset ?? "USDC",
      amount,
      requires_account: false,
      requires_amount: true,
    };
  }

  // Bare "deposit 5 XLM" (no "collateral" word) still means deposit_collateral in the
  // production brain router — same as zip direct.py `_ROUTES`.
  if (any(text, "deposit")) {
    return {
      kind: "write",
      op: "deposit_collateral",
      template_id: "deposit_collateral",
      asset: asset ?? "XLM",
      amount,
      requires_account: true,
      requires_amount: true,
    };
  }

  if (
    any(text, "redeem") ||
    (any(text, "withdraw") && any(text, "pool", "supply", "earn", "from the pool", "my supply"))
  ) {
    return {
      kind: "write",
      op: "redeem",
      template_id: "redeem",
      asset: asset ?? "USDC",
      amount,
      requires_account: false,
      requires_amount: true,
    };
  }

  // ── reads ───────────────────────────────────────────────────────────────
  if (any(text, "health factor", "am i safe", "close to liquidation", "at risk", "my health", "account health")) {
    return {
      kind: "read",
      tool: "vanna_get_account_health",
      args: {},
      requires_account: true,
      template_id: "query_account_health",
    };
  }

  if (any(text, "how much do i owe", "my debt", "how much have i borrowed", "what do i owe")) {
    return {
      kind: "read",
      tool: "vanna_get_debt",
      args: {},
      requires_account: true,
      template_id: "query_debt",
    };
  }

  if (
    any(text, "how much have i deposited", "my collateral", "collateral value", "what have i deposited")
  ) {
    return {
      kind: "read",
      tool: "vanna_get_collateral",
      args: {},
      requires_account: true,
      template_id: "query_collateral",
    };
  }

  if (any(text, "vtoken", "supply balance", "my supply balance")) {
    return {
      kind: "read",
      tool: "vanna_get_vtoken_balance",
      args: { symbol: asset ?? "USDC" },
      requires_account: true,
      template_id: "query_vtoken",
    };
  }

  if (any(text, "can i borrow", "how much can i borrow", "max borrow", "borrow allowed")) {
    return {
      kind: "read",
      tool: "vanna_can_borrow",
      args: {
        symbol: asset ?? "USDC",
        ...(amount != null ? { amount: String(amount) } : {}),
      },
      requires_account: true,
      template_id: "query_can_borrow",
    };
  }

  if (any(text, "can i withdraw", "can i pull out", "withdraw allowed")) {
    return {
      kind: "read",
      tool: "vanna_can_withdraw",
      args: {
        symbol: asset ?? "USDC",
        ...(amount != null ? { amount: String(amount) } : {}),
      },
      requires_account: true,
      template_id: "query_can_withdraw",
    };
  }

  if (any(text, "inactive account", "dead account", "closed account", "dormant")) {
    return {
      kind: "read",
      tool: "vanna_get_inactive_accounts",
      args: {},
      requires_account: true,
      template_id: "query_inactive",
    };
  }

  if (any(text, "resolve", "smart account", "margin account") && any(text, "look up", "resolve", "find my", "what is my")) {
    return {
      kind: "read",
      tool: "vanna_resolve_account",
      args: {},
      requires_account: false,
      template_id: "query_resolve",
    };
  }

  if (any(text, "contract address", "protocol address", "list addresses", "protocol addresses")) {
    return {
      kind: "read",
      tool: "vanna_list_protocol_addresses",
      args: {},
      template_id: "query_addresses",
    };
  }

  if (any(text, "collateral config", "allowed collateral", "what can i use as collateral")) {
    return {
      kind: "read",
      tool: "vanna_get_collateral_config",
      args: {},
      template_id: "query_collateral_config",
    };
  }

  if (any(text, "blend reserve", "blend apy", "blend pool") || (any(text, "blend") && any(text, "stats", "apr", "apy"))) {
    return {
      kind: "read",
      tool: asset ? "vanna_get_blend_reserve_stats" : "vanna_list_blend_reserves",
      args: asset ? { symbol: asset } : {},
      template_id: "query_blend",
    };
  }

  if (any(text, "exchange rate", "vtoken rate")) {
    return {
      kind: "read",
      tool: "vanna_get_vtoken_exchange_rate",
      args: { symbol: asset ?? "USDC" },
      template_id: "query_exchange_rate",
    };
  }

  // List / rank all Vanna earn pools (not Blend) — fan-out in runRead.
  if (
    any(text, "all earn pools", "list all vanna earn", "earn pools with", "list earn pools") ||
    (any(text, "earn pool") && any(text, "list", "all", "every")) ||
    (any(text, "highest supply apy", "best supply apy", "highest apy") &&
      !any(text, "blend", "farm", "aquarius"))
  ) {
    return {
      kind: "read",
      tool: "vanna_get_pool_stats",
      args: { symbol: "__ALL_EARN__" },
      template_id: "query_all_earn_pools",
    };
  }

  if (
    any(text, "pool stats", "pool apr", "pool apy", "utilization", "how is the", "pool doing", "borrow apr", "supply apy", "yield on") ||
    (any(text, "pool") && any(text, "stat", "apr", "apy", "liquidity", "tvl"))
  ) {
    return {
      kind: "read",
      tool: "vanna_get_pool_stats",
      args: { symbol: asset ?? "USDC" },
      template_id: "query_pool_stats",
    };
  }

  if (any(text, "prices of", "all prices", "show me prices", "prices for")) {
    const symbols = ASSETS.filter((a) => raw.toUpperCase().includes(a));
    return {
      kind: "read",
      tool: "vanna_get_prices_batch",
      args: { symbols: symbols.length ? symbols : ["XLM", "USDC", "AQUA"] },
      template_id: "query_prices_batch",
    };
  }

  if (any(text, "price", "trading at", "how much is", "rate", "oracle")) {
    return {
      kind: "read",
      tool: "vanna_get_price",
      args: { symbol: asset ?? "XLM" },
      template_id: "query_price",
    };
  }

  // bare asset mention + "stats" style
  if (asset && any(text, "stats", "status", "info")) {
    return {
      kind: "read",
      tool: "vanna_get_pool_stats",
      args: { symbol: asset },
      template_id: "query_pool_stats",
    };
  }

  return {
    kind: "clarify",
    message:
      "I can help with market data (prices, pool stats), your account (health, debt, collateral), " +
      "and actions (lend, deposit collateral, borrow, repay, withdraw). " +
      'Try e.g. "price of XLM", "USDC pool stats", "deposit 5 USDC as collateral", or "borrow 10 USDC".',
  };
}
