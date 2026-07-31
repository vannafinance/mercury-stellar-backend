/**
 * Deterministic intent router (keyword + regex).
 * Primary path when no external LLM is configured; always available as fallback.
 *
 * Strips G/C Stellar addresses before parsing amounts so digits inside addresses
 * never become fake quantities.
 */

import type { RoutedIntent } from "./types";

/** Longest-first so BLUSDC wins over nested USDC. */
const ASSETS = ["BLUSDC", "AQUSDC", "SOUSDC", "USDC", "XLM", "AQUA", "EURC"] as const;

/** Known junk / unsupported tickers we should reject, not map to USDC. */
const UNSUPPORTED_ASSETS = [
  "DOGE",
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "ADA",
  "DOT",
  "SHIB",
  "PEPE",
  "MATIC",
  "AVAX",
] as const;

const ADDR_RE = /\b[GC][A-Z0-9]{55,56}\b/g;
const AMOUNT_ASSET_RE = /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC)\b/i;
const BARE_AMOUNT_RE = /(\d+(?:\.\d+)?)/;
const LEVERAGE_RE = /(\d+(?:\.\d+)?)\s*x\b/i;

function stripAddresses(message: string): string {
  return message.replace(ADDR_RE, " ");
}

/**
 * Resolve a supported asset with word boundaries.
 * Never treat the "USDC" inside "BLUSDC" as bare USDC.
 */
export function findAsset(text: string): string | null {
  const upper = text.toUpperCase();
  for (const a of ASSETS) {
    const re = new RegExp(`(?:^|[^A-Z0-9])${a}(?:[^A-Z0-9]|$)`);
    if (re.test(upper)) return a;
  }
  return null;
}

/** First unsupported ticker mentioned, if any. */
export function findUnsupportedAsset(text: string): string | null {
  const upper = text.toUpperCase();
  for (const a of UNSUPPORTED_ASSETS) {
    const re = new RegExp(`(?:^|[^A-Z0-9])${a}(?:[^A-Z0-9]|$)`);
    if (re.test(upper)) return a;
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

/**
 * Parse “5 XLM and 1 BLUSDC” / “5 XLM + 1 USDC” dual-leg amounts for LP.
 */
function parseDualAmounts(text: string): {
  amount_a: number;
  token_a: string;
  amount_b: number;
  token_b: string;
} | null {
  const cleaned = stripAddresses(text);
  const re =
    /(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC|USDT)\b(?:\s+and\s+|\s*\+\s*|\s*&\s*)(\d+(?:\.\d+)?)\s*(BLUSDC|AQUSDC|SOUSDC|USDC|XLM|AQUA|EURC|USDT)\b/i;
  const m = cleaned.match(re);
  if (!m) return null;
  const amount_a = Number(m[1]);
  const amount_b = Number(m[3]);
  if (!Number.isFinite(amount_a) || !(amount_a > 0) || !Number.isFinite(amount_b) || !(amount_b > 0)) {
    return null;
  }
  return {
    amount_a,
    token_a: m[2]!.toUpperCase(),
    amount_b,
    token_b: m[4]!.toUpperCase(),
  };
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

  // Farm Blend with leverage MUST win over margin deposit_and_borrow.
  // Old guard `(leverage && blend)` routed "Farm Blend at 3x with 10 BLUSDC"
  // into deposit_and_borrow, which then asked for USDC chips or stuck after deposit.
  const isBlendFarmWrite =
    any(text, "farm blend", "blend at", "to blend", "into blend", "on blend", "blend reserve", "blend pool") ||
    (any(text, "blend") && any(text, "farm", "deploy", "supply", "deposit") && !any(text, "position", "stats", "apy"));
  if (
    isBlendFarmWrite &&
    any(text, "supply", "deposit", "deploy", "farm", "leverage", "lever") &&
    !any(text, "supply apy", "borrow apy", "position", "btoken", "pays more", "which reserve")
  ) {
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

  // Aquarius / Soroswap LP — add liquidity (must beat bare deposit / lend).
  const dual = parseDualAmounts(raw);
  if (
    any(text, "add liquidity", "provide liquidity", "add lp") ||
    (any(text, "add") && any(text, "aquarius", "soroswap", "to aquarius", "lp")) ||
    (any(text, "add") && dual && any(text, "xlm") && any(text, "usdc", "blusdc", "aqusdc", "sousdc"))
  ) {
    const token_a = dual?.token_a ?? "XLM";
    const token_b = dual?.token_b ?? (asset && asset !== "XLM" ? asset : "BLUSDC");
    return {
      kind: "write",
      op: "add_liquidity",
      template_id: "add_liquidity",
      asset: token_b,
      amount: dual?.amount_a ?? amount,
      token_a,
      token_b,
      amount_a: dual?.amount_a ?? amount,
      amount_b: dual?.amount_b ?? null,
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
    };
  }

  // Remove LP (half or explicit amount).
  if (
    any(text, "remove liquidity", "remove my liquidity", "withdraw liquidity", "withdraw lp") ||
    (any(text, "remove half") && any(text, "liquidity", "lp", "xlm/usdc", "pool"))
  ) {
    const half = any(text, "half", "50%", "50 %");
    // Pair default XLM / USDC family from message.
    const token_b =
      (/\baqusdc\b/i.test(raw) && "AQUSDC") ||
      (/\bsousdc\b/i.test(raw) && "SOUSDC") ||
      (/\bblusdc\b/i.test(raw) && "BLUSDC") ||
      (/\busdc\b/i.test(raw) && "USDC") ||
      "USDC";
    return {
      kind: "write",
      op: "remove_liquidity",
      template_id: "remove_liquidity",
      asset: token_b,
      amount: half ? null : amount,
      token_a: "XLM",
      token_b,
      fraction: half ? 0.5 : null,
      requires_account: true,
      requires_amount: !half,
    };
  }

  // Margin multi-leg only — never steal Blend farm or Aquarius LP.
  if (
    ((has(text, "deposit") && any(text, "borrow")) ||
      any(text, "deposit and borrow", "deposit + borrow", "lever up", "leveraged position") ||
      (leverage != null &&
        leverage > 1 &&
        any(text, "leverage", "lever") &&
        !any(text, "blend", "farm", "aquarius", "lp"))) &&
    !any(text, "blend", "farm blend", "aquarius")
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

  // Farm — supply / deploy / "farm Blend at Nx …".
  // Write needs a real verb; rate questions stay reads.
  // "farm Blend at 3x with 10 BLUSDC" has no "to blend" but is still a write.
  const blendVenueNamed = any(
    text,
    "to blend",
    "into blend",
    "on blend",
    "blend reserve",
    "blend pool",
    "farm blend",
    "blend at",
  );
  const blendRateRead = any(
    text,
    "supply apy",
    "supply apr",
    "borrow apy",
    "borrow apr",
    "stats",
    "utilization",
    "pays more",
    "pays better",
    "which reserve",
    "which blend",
    "compare",
    "position",
    "btoken",
    "b-token",
    "how much do i",
    "how much have i",
    "better than",
  );
  const blendWriteVerb = any(
    text,
    "supply",
    "deposit",
    "deploy",
    "farm",
    "add liquidity",
    "move my",
    "leverage",
    "lever",
  );
  if ((blendVenueNamed || (any(text, "blend") && leverage != null && leverage > 1)) && blendWriteVerb && !blendRateRead) {
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

  // Unsupported tickers on write intents — reject before defaulting asset to USDC.
  if (
    findUnsupportedAsset(raw) &&
    (any(text, "lend", "supply", "earn", "deposit", "borrow", "repay") || any(text, "to earn"))
  ) {
    const bad = findUnsupportedAsset(raw)!;
    return {
      kind: "clarify",
      message:
        `“${bad}” is not a Vanna asset on this testnet. Supported: XLM, BLUSDC, AQUSDC, SOUSDC. ` +
        `Example: “lend 10 XLM” or “supply 25 BLUSDC”.`,
      template_id: "unsupported_asset",
    };
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
    /highest[\s-]*yielding|best[\s-]*yielding|highest[\s-]*apy|best[\s-]*apy/i.test(text) &&
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
    // "XLM vs USDC" / "XLM or USDC" is a comparison — list both, never pick one symbol.
    const namedBlend = [
      /\bxlm\b/i.test(raw) ? "XLM" : null,
      /\busdc\b/i.test(raw) ? "USDC" : null,
    ].filter(Boolean) as string[];
    const compare = namedBlend.length > 1 || any(text, "vs", " versus ", " or ", "compare", "pays more", "better");
    const sym = !compare && namedBlend.length === 1 ? namedBlend[0]! : asset && !compare ? asset : null;
    return {
      kind: "read",
      tool: sym ? "vanna_get_blend_reserve_stats" : "vanna_list_blend_reserves",
      args: sym ? { symbol: sym === "BLUSDC" ? "USDC" : sym } : {},
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
