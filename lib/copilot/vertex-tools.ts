/**
 * Native function-calling declarations for the Vertex router.
 *
 * Why this file exists
 * --------------------
 * The router used to paste a tool catalogue into the system prompt as prose and ask
 * Gemini to answer with JSON. Every venue/kind defect we hit traced back to that: the
 * model was pattern-matching over free text, so it could name a pool that does not
 * exist (XLM/AQUA), answer an Earn question from a Blend reserve, or turn "which Blend
 * reserve pays more" into a deploy_to_blend write.
 *
 * Here the tools are schemas instead, with four defences, strongest first:
 *
 *   1. UNREPRESENTABLE — enums pin every asset / pool / pair to a value that actually
 *      exists, so an invalid one cannot be emitted at all. Only this layer is a hard
 *      guarantee, so as much as possible lives here.
 *   2. SEPARATED — Earn, Blend and Aquarius are distinct functions, never one function
 *      with a `venue` argument (that only moves the guess into a parameter). Each
 *      description says when NOT to call it, which the model reads exactly when that
 *      tool is under consideration.
 *   3. GUARDED — guardIntent() re-checks the model's choice against the raw message in
 *      plain code, because a schema cannot stop a *valid* wrong choice.
 *   4. ESCAPABLE — ask_clarification is a first-class tool, so "not sure" is a legal
 *      move. Models guess when guessing is the only thing they can represent.
 *
 * Schema and mapping live in one table (ROUTER_TOOLS) so they cannot drift apart.
 */

import type { RoutedIntent } from "./types";

// ── vocabularies: single source of truth for enums AND guards ──────────────

/** Vanna Earn lending pools. USDC is the deliberate "ambiguous" sentinel. */
export const EARN_POOLS = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"] as const;
/** Blend reserves that exist on the registered testnet pool. */
export const BLEND_RESERVES = ["XLM", "USDC"] as const;
/** Aquarius/Soroswap pairs Vanna can farm. There is no XLM/AQUA pool. */
export const AQUARIUS_PAIRS = ["XLM/USDC", "XLM/USDT"] as const;
/** Assets a write may name. "USDC" means "user did not pick a variant". */
export const WRITE_ASSETS = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC", "USDC", "AQUA", "EURC"] as const;
/** Sentinel that fans out to every Earn pool (comparisons / rankings). */
export const ALL_EARN = "__ALL_EARN__";

const EARN_POOL_ENUM = [...EARN_POOLS, "USDC", ALL_EARN];
const PRICE_SYMBOLS = ["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC", "AQUA", "EURC"];

const USDC_NOTE =
  "There are three distinct USDC tokens (BLUSDC, AQUSDC, SOUSDC) and they are not " +
  "interchangeable. If the user says only \"USDC\" without a variant, pass \"USDC\" and the " +
  "server will ask which one. Never guess a variant.";

// ── declaration helpers ────────────────────────────────────────────────────

type JsonSchema = {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: JsonSchema;
}

interface ToolEntry {
  decl: FunctionDeclaration;
  toIntent: (args: Record<string, unknown>) => RoutedIntent;
}

function params(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required };
}

const str = (description: string, values?: readonly string[]): JsonSchema => ({
  type: "string",
  description,
  ...(values ? { enum: [...values] } : {}),
});

const num = (description: string): JsonSchema => ({ type: "number", description });

// ── arg coercion ───────────────────────────────────────────────────────────

function asStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v).toUpperCase();
}

/**
 * Coerce an amount, PRESERVING the sign.
 *
 * Negative amounts must reach validateLendParams so it can reject them with a real
 * message ("amount must be positive"). Clamping them to null here would instead make
 * the copilot ask "how much?", which reads as if the copilot mis-heard the user.
 */
function asAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Reads that need a C… smart account resolved before they can run. */
const ACCOUNT_SCOPED = new Set([
  "vanna_get_account_health",
  "vanna_get_collateral",
  "vanna_get_debt",
  "vanna_get_max_borrow",
  "vanna_can_borrow",
  "vanna_can_withdraw",
  "vanna_get_farm_overview",
  "vanna_get_blend_position",
  "vanna_get_lp_balance",
]);

function read(tool: string, args: Record<string, unknown> = {}): RoutedIntent {
  return {
    kind: "read",
    tool,
    args,
    requires_account: ACCOUNT_SCOPED.has(tool),
    template_id: tool,
  };
}

const NO_ACCOUNT_WRITES = new Set([
  "create_account",
  "lend",
  "redeem",
  "enable_auto_sign",
  "disable_auto_sign",
]);
const NO_AMOUNT_WRITES = new Set([
  "create_account",
  "settle_account",
  "close_account",
  "enable_auto_sign",
  "disable_auto_sign",
]);
const MULTI_LEG_WRITES = new Set(["deposit_and_borrow", "deploy_to_blend", "supply_to_blend"]);

function write(
  op: string,
  args: Record<string, unknown>,
  extra: Partial<Extract<RoutedIntent, { kind: "write" }>> = {},
): RoutedIntent {
  return {
    kind: "write",
    op,
    asset: asStr(args.asset),
    amount: asAmount(args.amount),
    multi_leg: MULTI_LEG_WRITES.has(op),
    requires_account: !NO_ACCOUNT_WRITES.has(op),
    requires_amount: !NO_AMOUNT_WRITES.has(op),
    template_id: op,
    ...extra,
  };
}

// ── the tool table ─────────────────────────────────────────────────────────
//
// Descriptions do the routing work. Each one states what it answers and, where a
// sibling tool could plausibly be confused for it, what it must NOT be used for.

export const ROUTER_TOOLS: ToolEntry[] = [
  // ---- market reads: prices ----
  {
    decl: {
      name: "get_price",
      description:
        "Oracle price of ONE asset in USD. Use for \"price of X\", \"what is X trading at\".",
      parameters: params({ symbol: str("Asset symbol.", PRICE_SYMBOLS) }, ["symbol"]),
    },
    toIntent: (a) => read("vanna_get_price", { symbol: asStr(a.symbol) ?? "XLM" }),
  },
  {
    decl: {
      name: "get_prices",
      description:
        "Oracle prices for SEVERAL assets at once. Use when the user asks for multiple " +
        "prices or \"all prices\". For a single asset use get_price instead.",
      parameters: params(
        { symbols: { type: "array", description: "Two or more asset symbols.", items: str("Asset symbol.", PRICE_SYMBOLS) } },
        ["symbols"],
      ),
    },
    toIntent: (a) => {
      const list = Array.isArray(a.symbols) ? a.symbols.map(asStr).filter(Boolean) : [];
      return read("vanna_get_prices_batch", {
        symbols: list.length ? list : ["XLM", "USDC", "AQUA"],
      });
    },
  },

  // ---- market reads: VANNA EARN (the default meaning of "pool") ----
  {
    decl: {
      name: "get_earn_pool_stats",
      description:
        "Stats for a Vanna EARN lending pool: supply APY, borrow APR, utilization, total " +
        "supplied/borrowed, and liquidity available to borrow. " +
        "THIS IS THE DEFAULT MEANING OF \"POOL\". The words \"pool\", \"lending pool\", " +
        "\"earn pool\", \"the USDC pool\", \"the XLM pool\" with NO venue named ALWAYS mean a " +
        "Vanna Earn pool and belong here. " +
        "Do NOT use a Blend or Aquarius tool for those. " +
        `Pass pool="${ALL_EARN}" to compare or rank every Earn pool (\"compare the XLM and USDC ` +
        "pools\", \"which pool has the highest APY\"). AQUSDC and SOUSDC are real Earn pools " +
        "even though Blend lists only XLM and USDC.",
      parameters: params(
        { pool: str(`Earn pool, or "${ALL_EARN}" for all of them.`, EARN_POOL_ENUM) },
        ["pool"],
      ),
    },
    toIntent: (a) => read("vanna_get_pool_stats", { symbol: asStr(a.pool) ?? "USDC" }),
  },

  // ---- market reads: BLEND (only when the user says Blend) ----
  {
    decl: {
      name: "list_blend_reserves",
      description:
        "Every reserve on the Blend pool with its rates. Use ONLY when the user says " +
        "\"Blend\" or \"bToken\". " +
        "REQUIRED for any comparison between Blend reserves (\"which Blend reserve pays " +
        "more, XLM or USDC?\") because it returns all sides at once — get_blend_reserve_stats " +
        "handles one symbol and cannot answer \"which pays more\". " +
        "A question about Blend is still a READ: never answer it with deploy_to_blend.",
    },
    toIntent: () => read("vanna_list_blend_reserves"),
  },
  {
    decl: {
      name: "get_blend_reserve_stats",
      description:
        "Rates for ONE named Blend reserve. Use ONLY when the user says \"Blend\" AND names a " +
        "single asset. For any comparison use list_blend_reserves instead.",
      parameters: params({ symbol: str("Blend reserve asset.", BLEND_RESERVES) }, ["symbol"]),
    },
    toIntent: (a) => read("vanna_get_blend_reserve_stats", { symbol: asStr(a.symbol) ?? "XLM" }),
  },

  // ---- market reads: AQUARIUS / SOROSWAP LP ----
  {
    decl: {
      name: "list_aquarius_pools",
      description:
        "Aquarius/Soroswap LP pools Vanna can farm. Use ONLY when the user says \"Aquarius\", " +
        "\"Soroswap\", \"LP\" or names a trading pair. Vanna farms XLM/USDC and XLM/USDT only; " +
        "if the user names any other pair, say it is not farmable rather than substituting one.",
    },
    toIntent: () => read("vanna_list_aquarius_pools"),
  },
  {
    decl: {
      name: "get_aquarius_pool_stats",
      description:
        "Stats for ONE Aquarius/Soroswap LP pair. Use ONLY when the user names a pair. " +
        "Do NOT use for Vanna Earn pools.",
      parameters: params({ pair: str("Farmable LP pair.", AQUARIUS_PAIRS) }, ["pair"]),
    },
    toIntent: (a) => read("vanna_get_aquarius_pool_stats", { pool: asStr(a.pair) ?? "XLM/USDC" }),
  },

  // ---- account reads ----
  {
    decl: {
      name: "get_account_health",
      description:
        "The user's margin account health factor and liquidation risk. Use for \"am I safe\", " +
        "\"my health factor\", \"close to liquidation\".",
    },
    toIntent: () => read("vanna_get_account_health"),
  },
  {
    decl: {
      name: "get_collateral",
      description: "Collateral the user has deposited into their margin account, and its USD value.",
    },
    toIntent: () => read("vanna_get_collateral"),
  },
  {
    decl: {
      name: "get_debt",
      description: "What the user currently owes (borrowed balances). Use for \"how much do I owe\".",
    },
    toIntent: () => read("vanna_get_debt"),
  },
  {
    decl: {
      name: "get_max_borrow",
      description:
        "The largest amount of one asset the user could borrow right now. Use for \"how much " +
        "can I borrow\" with no amount named. This is a READ, never a borrow write.",
      parameters: params({ symbol: str("Asset to borrow.", WRITE_ASSETS) }, ["symbol"]),
    },
    toIntent: (a) => read("vanna_get_max_borrow", { symbol: asStr(a.symbol) ?? "USDC" }),
  },
  {
    decl: {
      name: "can_borrow",
      description:
        "Whether a SPECIFIC borrow amount is allowed. Use for \"can I borrow 50 USDC?\". " +
        "This is a READ — it checks, it does not borrow.",
      parameters: params(
        { symbol: str("Asset to borrow.", WRITE_ASSETS), amount: num("Amount to test.") },
        ["symbol", "amount"],
      ),
    },
    toIntent: (a) =>
      read("vanna_can_borrow", {
        symbol: asStr(a.symbol) ?? "USDC",
        ...(asAmount(a.amount) != null ? { amount: String(asAmount(a.amount)) } : {}),
      }),
  },
  {
    decl: {
      name: "can_withdraw",
      description:
        "Whether a specific collateral withdrawal is allowed without breaching health. " +
        "A READ — it checks, it does not withdraw.",
      parameters: params(
        { symbol: str("Collateral asset.", WRITE_ASSETS), amount: num("Amount to test.") },
        ["symbol", "amount"],
      ),
    },
    toIntent: (a) =>
      read("vanna_can_withdraw", {
        symbol: asStr(a.symbol) ?? "USDC",
        ...(asAmount(a.amount) != null ? { amount: String(asAmount(a.amount)) } : {}),
      }),
  },
  {
    decl: {
      name: "get_vtoken_balance",
      description:
        "The user's vToken (Earn supply receipt) balance for one asset — how much they have " +
        "supplied to a Vanna Earn pool.",
      parameters: params({ symbol: str("Earn pool asset.", EARN_POOLS) }, ["symbol"]),
    },
    toIntent: (a) => read("vanna_get_vtoken_balance", { symbol: asStr(a.symbol) ?? "USDC" }),
  },
  {
    decl: {
      name: "get_vtoken_exchange_rate",
      description: "The vToken-to-underlying exchange rate for one Earn pool.",
      parameters: params({ symbol: str("Earn pool asset.", EARN_POOLS) }, ["symbol"]),
    },
    toIntent: (a) => read("vanna_get_vtoken_exchange_rate", { symbol: asStr(a.symbol) ?? "USDC" }),
  },
  {
    decl: {
      name: "get_wallet_balance",
      description: "Token balances in the user's Stellar G… wallet (not the margin account).",
    },
    toIntent: () => read("vanna_get_wallet_balance"),
  },
  {
    decl: {
      name: "resolve_account",
      description:
        "Find the user's margin (smart) account address. Use for \"what is my margin account\".",
    },
    toIntent: () => read("vanna_resolve_account"),
  },

  // ---- farm position reads ----
  {
    decl: {
      name: "get_farm_overview",
      description:
        "Summary of the user's farming positions across venues. Use for a general \"my farm " +
        "positions\" / \"what am I farming\" question with no single venue named.",
    },
    toIntent: () => read("vanna_get_farm_overview"),
  },
  {
    decl: {
      name: "get_blend_position",
      description:
        "The user's own supplied/borrowed position on Blend. Use ONLY when the user says " +
        "\"Blend\". For rates rather than their own position use list_blend_reserves.",
    },
    toIntent: () => read("vanna_get_blend_position"),
  },
  {
    decl: {
      name: "get_lp_balance",
      description:
        "The user's Aquarius/Soroswap LP token balance. Use ONLY when the user says " +
        "\"Aquarius\", \"Soroswap\", \"LP\" or names a pair.",
    },
    toIntent: () => read("vanna_get_lp_balance"),
  },

  // ---- protocol reads ----
  {
    decl: {
      name: "list_protocol_addresses",
      description: "Deployed Vanna contract addresses on this network.",
    },
    toIntent: () => read("vanna_list_protocol_addresses"),
  },
  {
    decl: {
      name: "get_collateral_config",
      description:
        "Which assets are accepted as collateral, with their LTV and liquidation thresholds.",
    },
    toIntent: () => read("vanna_get_collateral_config"),
  },

  // ---- writes: EARN ----
  {
    decl: {
      name: "earn_lend",
      description:
        "Supply/lend an asset INTO a Vanna Earn pool to earn yield. Use for \"lend 10 USDC\", " +
        "\"supply 10 XLM to earn\", \"I want to earn yield on my XLM\". " +
        "Do NOT use for Blend (that is deploy_to_blend) and do NOT use for margin collateral " +
        "(that is deposit_collateral). " +
        "Set highest_yield=true when the user asks for the best/highest-yielding pool rather " +
        "than naming one. " +
        USDC_NOTE,
      parameters: params(
        {
          asset: str("Asset to supply.", WRITE_ASSETS),
          amount: num("Amount to supply. Omit if the user did not say."),
          highest_yield: {
            type: "boolean",
            description: "True if the user asked for the highest-yielding pool instead of naming one.",
          },
        },
        ["asset"],
      ),
    },
    toIntent: (a) =>
      write("lend", a, { template_id: a.highest_yield ? "lend_highest" : "lend" }),
  },
  {
    decl: {
      name: "earn_redeem",
      description:
        "Withdraw/redeem a supply out of a Vanna Earn pool. Use for \"redeem 5 USDC\", " +
        "\"withdraw my supply from the pool\". Not for margin collateral.",
      parameters: params(
        { asset: str("Asset to redeem.", WRITE_ASSETS), amount: num("Amount to redeem.") },
        ["asset"],
      ),
    },
    toIntent: (a) => write("redeem", a),
  },

  // ---- writes: MARGIN ----
  {
    decl: {
      name: "create_margin_account",
      description:
        "Create the user's margin smart account (C-address) via MCP open. " +
        "Use ONLY for \"create a margin account\", \"open a smart account\", \"open margin account\". " +
        "Do NOT use for \"create wallet\" / \"create Vanna wallet\" / G-wallet — that is client-side Privy, not MCP.",
    },
    toIntent: () => write("create_account", {}),
  },
  {
    decl: {
      name: "deposit_collateral",
      description:
        "Deposit an asset as MARGIN COLLATERAL. This is what a bare \"deposit 5 XLM\" means " +
        "when no venue and no earn/pool wording is present. " +
        "Do NOT use for \"supply to Blend\" (deploy_to_blend) or \"lend to the pool\" (earn_lend). " +
        USDC_NOTE,
      parameters: params(
        { asset: str("Collateral asset.", WRITE_ASSETS), amount: num("Amount to deposit.") },
        ["asset"],
      ),
    },
    toIntent: (a) => write("deposit_collateral", a),
  },
  {
    decl: {
      name: "withdraw_collateral",
      description: "Withdraw margin collateral out of the margin account.",
      parameters: params(
        { asset: str("Collateral asset.", WRITE_ASSETS), amount: num("Amount to withdraw.") },
        ["asset"],
      ),
    },
    toIntent: (a) => write("withdraw_collateral", a),
  },
  {
    decl: {
      name: "borrow",
      description:
        "Borrow an asset against existing margin collateral. Only for an IMPERATIVE instruction " +
        "(\"borrow 10 USDC\"). A question about borrowing is a read: use get_max_borrow or " +
        "can_borrow instead. " +
        USDC_NOTE,
      parameters: params(
        { asset: str("Asset to borrow.", WRITE_ASSETS), amount: num("Amount to borrow.") },
        ["asset"],
      ),
    },
    toIntent: (a) => write("borrow", a),
  },
  {
    decl: {
      name: "repay",
      description: "Repay borrowed debt. Use for \"repay 5 USDC\", \"pay back my loan\".",
      parameters: params(
        { asset: str("Asset to repay.", WRITE_ASSETS), amount: num("Amount to repay.") },
        ["asset"],
      ),
    },
    toIntent: (a) => write("repay", a),
  },
  {
    decl: {
      name: "deposit_and_borrow",
      description:
        "One leveraged margin action that deposits collateral and borrows against it. Use when " +
        "the user asks for both at once, or asks for leverage: \"deposit 20 USDC and borrow 2x\", " +
        "\"lever up 3x\". " +
        "Give leverage when the user expressed a multiple, or borrow_amount when they gave an " +
        "explicit second figure — not both. " +
        USDC_NOTE,
      parameters: params(
        {
          asset: str("Asset being deposited as collateral.", WRITE_ASSETS),
          amount: num("Amount deposited as collateral."),
          leverage: num("Target leverage multiple, e.g. 2 for 2x. Omit if the user gave a borrow amount."),
          borrow_amount: num("Explicit amount to borrow. Omit if the user gave a leverage multiple."),
          borrow_asset: str("Asset to borrow, if different from the deposit asset.", WRITE_ASSETS),
        },
        ["asset"],
      ),
    },
    toIntent: (a) =>
      write("deposit_and_borrow", a, {
        leverage: asAmount(a.leverage),
        deposit_amount: asAmount(a.amount),
        borrow_amount: asAmount(a.borrow_amount),
      }),
  },
  {
    decl: {
      name: "settle_account",
      description: "Settle the user's margin account. Takes no amount.",
    },
    toIntent: () => write("settle_account", {}),
  },
  {
    decl: {
      name: "close_account",
      description: "Close the user's margin account. Takes no amount.",
    },
    toIntent: () => write("close_account", {}),
  },

  // ---- writes: FARM ----
  {
    decl: {
      name: "deploy_to_blend",
      description:
        "Supply from the margin account into a Blend reserve to farm yield. Use for \"supply 10 " +
        "XLM to Blend\", \"deploy into Blend\", \"farm on Blend at 3x\". " +
        "Requires BOTH an explicit write verb AND the word Blend. " +
        "Naming Blend alone is NOT intent to write — a question about Blend rates is a read " +
        "(list_blend_reserves). Never use this for deposit_collateral.",
      parameters: params(
        {
          asset: str("Asset to supply to Blend.", BLEND_RESERVES),
          amount: num("Amount to supply."),
          leverage: num("Leverage multiple if the user asked to farm levered."),
        },
        ["asset"],
      ),
    },
    toIntent: (a) => write("deploy_to_blend", a, { leverage: asAmount(a.leverage) }),
  },

  // ---- control ----
  {
    decl: {
      name: "configure_auto_sign",
      description:
        "Turn Sign Service auto-signing on or off, or set its spend caps. Use for \"enable " +
        "auto-sign\", \"turn on auto approve\", \"stop auto signing\".",
      parameters: params(
        {
          action: str(
            "start = begin enabling; use_defaults = accept default caps; custom = user gave caps; disable = turn off.",
            ["start", "use_defaults", "custom", "disable"],
          ),
          max_per_tx_usd: num("Per-transaction USD cap, if the user gave one."),
          max_per_day_usd: num("Daily USD cap, if the user gave one."),
        },
        ["action"],
      ),
    },
    toIntent: (a) => {
      const action = String(a.action ?? "start");
      return {
        kind: "auto_sign",
        action: (["start", "use_defaults", "custom", "disable"].includes(action)
          ? action
          : "start") as "start" | "use_defaults" | "custom" | "disable",
        template_id: "auto_sign",
        ...(asAmount(a.max_per_tx_usd) != null ? { max_per_tx_usd: asAmount(a.max_per_tx_usd)! } : {}),
        ...(asAmount(a.max_per_day_usd) != null ? { max_per_day_usd: asAmount(a.max_per_day_usd)! } : {}),
      };
    },
  },
  {
    decl: {
      name: "make_plan",
      description:
        "A multi-step strategy that needs more than one call: park/lend for yield THEN farm Blend, " +
        "deposit then borrow, rebalances, multi-venue goals. Order steps as they must run. " +
        "Amounts ONLY from explicit N ASSET (e.g. 20 XLM) — never use health-factor floors as amounts. " +
        "Use a single-purpose tool instead whenever one call is enough. " +
        "Named strategies you must DECOMPOSE here rather than refuse or clarify: " +
        "a DELTA-NEUTRAL CARRY (also \"carry trade\", \"basis trade\", \"cash and carry\") on asset X " +
        "is deposit_collateral with the stable asset the user named, then borrow X, then lend or " +
        "deploy_to_blend the SAME amount of X — owing X while holding X cancels the price exposure, " +
        "and the return is the deploy yield minus the borrow cost. " +
        "A LEVERAGED FARM is deposit_collateral, borrow, then deploy_to_blend.",
      parameters: params(
        {
          summary: str("One line describing the strategy."),
          steps: {
            type: "array",
            description: "Ordered steps.",
            items: params(
              {
                kind: str("read or write.", ["read", "write"]),
                tool: str("For a read step: the read tool name from this same tool list."),
                op: str(
                  "For a write step: lend, deposit_collateral, borrow, repay, deploy_to_blend, supply_to_blend, etc.",
                ),
                asset: str("Asset, if the step needs one.", WRITE_ASSETS),
                amount: num(
                  "Size only if user said N ASSET (e.g. 20 XLM). Never a health-factor floor like 1.4.",
                ),
                leverage: num("Leverage multiple if user said Nx (e.g. 2 for 2x farm). Not an amount."),
              },
              ["kind"],
            ),
          },
        },
        ["summary", "steps"],
      ),
    },
    toIntent: (a) => {
      const raw = Array.isArray(a.steps) ? a.steps : [];
      return {
        kind: "plan",
        template_id: "strategy",
        summary: a.summary != null ? String(a.summary) : undefined,
        steps: raw.map((s) => {
          const step = (s ?? {}) as Record<string, unknown>;
          const isWrite = String(step.kind) === "write";
          const lev = asAmount(step.leverage);
          const args: Record<string, unknown> = {};
          if (lev != null && lev > 1) args.leverage = lev;
          return {
            kind: isWrite ? ("write" as const) : ("read" as const),
            ...(step.tool != null ? { tool: mapPlanTool(String(step.tool)) } : {}),
            ...(step.op != null ? { op: mapPlanOp(String(step.op)) } : {}),
            args,
            asset: asStr(step.asset),
            amount: asAmount(step.amount),
            leverage: lev,
          };
        }),
      };
    },
  },
  {
    decl: {
      name: "ask_clarification",
      description:
        "Ask the user one short question when the request genuinely cannot be routed — an " +
        "APY with no pool AND no venue named, an action with no asset, a request that could " +
        "mean two different venues. " +
        "PREFER THIS OVER GUESSING. Do not use it merely because an amount is missing: emit " +
        "the write without the amount and the server will ask.",
      parameters: params(
        {
          question: str("The single question to ask, in plain language."),
          options: {
            type: "array",
            description: "Two to four concrete choices, if the question is a choice.",
            items: str("A choice label."),
          },
        },
        ["question"],
      ),
    },
    toIntent: (a) => ({
      kind: "clarify",
      message: String(a.question ?? "Could you rephrase that?"),
      template_id: null,
    }),
  },
  {
    decl: {
      name: "refuse_restricted",
      description:
        "The user asked for a keeper/protocol-only action such as liquidating someone else's " +
        "account. Explain briefly that the copilot will not run it.",
      parameters: params({ reason: str("Why this is restricted.") }, ["reason"]),
    },
    toIntent: (a) => ({
      kind: "restricted",
      reason: String(
        a.reason ??
          "Liquidating other accounts is a restricted keeper action — the copilot won't run it.",
      ),
      template_id: "liquidate",
    }),
  },
];

export const ROUTER_TOOL_DECLS: FunctionDeclaration[] = ROUTER_TOOLS.map((t) => t.decl);

const BY_NAME = new Map(ROUTER_TOOLS.map((t) => [t.decl.name, t]));

/** Plan steps name router tools; translate to the MCP/op vocabulary handle.ts expects. */
function mapPlanTool(name: string): string {
  const entry = BY_NAME.get(name);
  if (!entry) return name.startsWith("vanna_") ? name : `vanna_${name}`;
  const intent = entry.toIntent({});
  return intent.kind === "read" ? intent.tool : name;
}

function mapPlanOp(name: string): string {
  const entry = BY_NAME.get(name);
  if (!entry) return name;
  const intent = entry.toIntent({});
  return intent.kind === "write" ? intent.op : name;
}

/**
 * Turn a Gemini functionCall into a RoutedIntent.
 * Returns null when the model named a function we do not expose, so the caller can
 * decide whether to fall back rather than silently mis-route.
 */
export function intentFromFunctionCall(
  name: string,
  args: Record<string, unknown>,
): RoutedIntent | null {
  const entry = BY_NAME.get(name);
  if (!entry) return null;
  return entry.toIntent(args ?? {});
}

// ── layer 3: deterministic guards ──────────────────────────────────────────
//
// A schema cannot stop a *valid* wrong choice, so the model's pick is re-checked
// against the raw message here in plain code. These are the defect classes we
// actually observed, each expressed as a rule rather than as a prompt instruction.

const BLEND_NAMED = /\bblend\b|\bb-?tokens?\b/i;
/**
 * A trading pair must be built from real symbols. A generic `[A-Z]{3,6}/[A-Z]{3,6}` under
 * /i also matches ordinary prose like "supply/borrow", which would suppress the venue
 * guard on exactly the phrasings it exists to catch.
 */
const PAIR_SYMBOL = "XLM|USDT|BLUSDC|AQUSDC|SOUSDC|USDC|AQUA|EURC";
const LP_NAMED = new RegExp(
  `\\baquarius\\b|\\bsoroswap\\b|\\blp\\b|\\b(?:${PAIR_SYMBOL})\\s*\\/\\s*(?:${PAIR_SYMBOL})\\b`,
  "i",
);

/** Comparative / interrogative shapes that are never an instruction to transact. */
const COMPARATIVE =
  /\b(pays? (?:more|better|less)|which|compare|comparison|better than|worse than|vs\.?|versus|higher|lower|best|cheapest)\b/i;
const WRITE_VERB =
  /\b(deposit|deposits|lend|lends|supply|supplies|borrow|borrows|repay|repays|withdraw|withdraws|redeem|redeems|deploy|deploys|farm|farms|create|open|close|settle|move|enable|disable)\b/i;

/** Blend/LP reads and their Vanna Earn equivalents, for venue correction. */
const BLEND_READ_FALLBACK: Record<string, { tool: string; args?: Record<string, unknown> }> = {
  vanna_list_blend_reserves: { tool: "vanna_get_pool_stats", args: { symbol: ALL_EARN } },
  vanna_get_blend_reserve_stats: { tool: "vanna_get_pool_stats" },
  vanna_get_blend_position: { tool: "vanna_get_farm_overview", args: {} },
};
const LP_READ_FALLBACK: Record<string, { tool: string; args?: Record<string, unknown> }> = {
  vanna_list_aquarius_pools: { tool: "vanna_get_pool_stats", args: { symbol: ALL_EARN } },
  vanna_get_aquarius_pool_stats: { tool: "vanna_get_pool_stats", args: { symbol: ALL_EARN } },
  vanna_get_lp_balance: { tool: "vanna_get_farm_overview", args: {} },
};

export interface GuardResult {
  intent: RoutedIntent;
  /** Human-readable notes on what was corrected, for the copilot log. */
  corrections: string[];
}

/**
 * Re-check a routed intent against the user's raw words.
 *
 * Two rules, both from live defects:
 *   - VENUE: a Blend or Aquarius tool chosen when the user never named that venue is
 *     rewritten to the Vanna Earn equivalent. Bare "pool" always means Earn.
 *   - KIND: a write chosen for a comparative question with no write verb is demoted to
 *     a clarification. "Which Blend reserve pays more?" must never execute anything.
 */
export function guardIntent(intent: RoutedIntent, message: string): GuardResult {
  const corrections: string[] = [];
  const text = message ?? "";
  const blendNamed = BLEND_NAMED.test(text);
  const lpNamed = LP_NAMED.test(text);

  // KIND guard — a comparison is never an instruction.
  if (intent.kind === "write" && COMPARATIVE.test(text) && !WRITE_VERB.test(text)) {
    corrections.push(`kind: write(${intent.op}) demoted to clarify — comparative question, no write verb`);
    return {
      intent: {
        kind: "clarify",
        message:
          "That reads like a comparison rather than an instruction. Do you want me to look up " +
          "the rates, or actually run that action?",
        template_id: null,
      },
      corrections,
    };
  }

  // VENUE guard — a venue tool needs the venue named.
  if (intent.kind === "write" && intent.op === "deploy_to_blend" && !blendNamed) {
    corrections.push("venue: deploy_to_blend without \"Blend\" named → deposit_collateral");
    return {
      intent: { ...intent, op: "deposit_collateral", template_id: "deposit_collateral", multi_leg: false },
      corrections,
    };
  }

  if (intent.kind === "read") {
    if (!blendNamed && BLEND_READ_FALLBACK[intent.tool]) {
      const fb = BLEND_READ_FALLBACK[intent.tool]!;
      corrections.push(`venue: ${intent.tool} without "Blend" named → ${fb.tool}`);
      return {
        intent: { ...intent, tool: fb.tool, args: fb.args ?? intent.args, template_id: fb.tool },
        corrections,
      };
    }
    if (!lpNamed && LP_READ_FALLBACK[intent.tool]) {
      const fb = LP_READ_FALLBACK[intent.tool]!;
      corrections.push(`venue: ${intent.tool} without an LP venue named → ${fb.tool}`);
      return {
        intent: { ...intent, tool: fb.tool, args: fb.args ?? intent.args, template_id: fb.tool },
        corrections,
      };
    }
  }

  return { intent, corrections };
}

/**
 * System instruction for the function-calling path.
 *
 * Deliberately short. The routing rules now live on the individual tool descriptions,
 * where the model reads them exactly when that tool is a candidate, instead of in one
 * global block competing with everything else. Keep this text STABLE — it is the head
 * of the cached prefix, and any edit invalidates the cache for every user.
 */
export const FC_ROUTE_SYSTEM = `You are Vanna Copilot, the natural-language interface to the Vanna Finance MCP server on Stellar/Soroban.

Your only job is to choose the right tool and fill its arguments. You never execute anything and you never write prose here — MCP performs every read and write, and the Sign Service signs.

- Always call exactly one tool.
- Questions are reads. Only an imperative instruction is a write.
- Never invent an amount. If a write is clearly intended but no amount was given, call the write tool without the amount; the server will ask.
- Risk limits, health factors and spend caps are enforced downstream. Never refuse on risk grounds and never claim a transaction was blocked.
- Prefer ask_clarification over guessing when the request is genuinely ambiguous.
- Casual wording and Hinglish are fine.`;
