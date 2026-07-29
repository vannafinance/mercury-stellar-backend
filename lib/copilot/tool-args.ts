/**
 * Build correct MCP tool arguments from a routed intent + account context.
 * Schemas come from the live vanna-mcp-server (verified tools/list).
 */

export interface AccountCtx {
  trader?: string | null; // G...
  smartAccount?: string | null; // C...
}

function looksG(a?: string | null): a is string {
  return !!a && /^G[A-Z0-9]{55}$/.test(a);
}
function looksC(a?: string | null): a is string {
  return !!a && /^C[A-Z0-9]{55}$/.test(a);
}

function sym(v: unknown, fallback = "USDC"): string {
  if (v == null || v === "") return fallback;
  return String(v).toUpperCase();
}

function amountStr(v: unknown, fallback?: string): string | undefined {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return String(n);
}

/**
 * Returns cleaned args ready for mcp.call, or a blocker explaining what's missing.
 */
export function buildToolArgs(
  tool: string,
  rawArgs: Record<string, unknown>,
  ctx: AccountCtx,
): { args: Record<string, unknown>; blocker?: string } {
  const trader = looksG(ctx.trader) ? ctx.trader : looksG(rawArgs.trader as string) ? String(rawArgs.trader) : null;
  const smart =
    looksC(ctx.smartAccount)
      ? ctx.smartAccount
      : looksC(rawArgs.smart_account as string)
        ? String(rawArgs.smart_account)
        : null;

  switch (tool) {
    case "vanna_get_price":
      return { args: { symbol: sym(rawArgs.symbol ?? rawArgs.asset, "XLM") } };

    case "vanna_get_prices_batch":
    case "vanna_get_prices": {
      let symbols = rawArgs.symbols;
      if (!Array.isArray(symbols) || !symbols.length) {
        const one = rawArgs.symbol ?? rawArgs.asset;
        symbols = one ? [sym(one)] : ["XLM", "USDC"];
      }
      return {
        args: {
          symbols: (symbols as unknown[]).map((s) => sym(s)),
        },
      };
    }

    case "vanna_get_pool_stats":
    case "vanna_get_vtoken_exchange_rate":
    case "vanna_get_blend_reserve_stats":
      return { args: { symbol: sym(rawArgs.symbol ?? rawArgs.asset, "USDC") } };

    case "vanna_list_protocol_addresses":
    case "vanna_get_collateral_config":
    case "vanna_list_blend_reserves":
    case "vanna_list_aquarius_pools":
    case "vanna_list_my_wallet_bindings":
      return { args: {} };

    case "vanna_get_aquarius_pool_stats": {
      const args: Record<string, unknown> = {};
      if (rawArgs.token_a) args.token_a = sym(rawArgs.token_a);
      if (rawArgs.token_b) args.token_b = sym(rawArgs.token_b);
      return { args };
    }

    case "vanna_resolve_account":
    case "vanna_get_inactive_accounts": {
      if (!trader) return { args: {}, blocker: "Connect your wallet (G-address) for this account lookup." };
      return { args: { trader } };
    }

    case "vanna_list_smart_accounts": {
      if (!trader) return { args: {}, blocker: "Connect your wallet to list smart accounts." };
      return { args: { wallet_address: trader } };
    }

    case "vanna_get_wallet_balance": {
      if (!trader) return { args: {}, blocker: "Connect your wallet to read balances." };
      return { args: { g_address: trader } };
    }

    case "vanna_get_account_health":
    case "vanna_get_collateral":
    case "vanna_get_debt":
    case "vanna_get_farm_overview": {
      if (!smart) {
        return {
          args: {},
          blocker:
            "That needs your Vanna smart account (C-address). Create one or connect the wallet that owns it.",
        };
      }
      return { args: { smart_account: smart } };
    }

    case "vanna_get_blend_position":
    case "vanna_get_farm_lp_position":
    case "vanna_get_lp_balance": {
      if (!smart) {
        return {
          args: {},
          blocker: "That needs your Vanna smart account (C-address).",
        };
      }
      const args: Record<string, unknown> = { smart_account: smart };
      if (rawArgs.symbol) args.symbol = sym(rawArgs.symbol);
      if (rawArgs.token_a) args.token_a = sym(rawArgs.token_a);
      if (rawArgs.token_b) args.token_b = sym(rawArgs.token_b);
      if (rawArgs.venue) args.venue = String(rawArgs.venue);
      return { args };
    }

    case "vanna_get_vtoken_balance": {
      // schema: holder (G or C) + symbol
      const holder = smart || trader;
      if (!holder) {
        return { args: {}, blocker: "Connect your wallet to read vToken balance." };
      }
      return { args: { holder, symbol: sym(rawArgs.symbol ?? rawArgs.asset, "USDC") } };
    }

    case "vanna_can_borrow":
    case "vanna_can_withdraw": {
      if (!smart) {
        return { args: {}, blocker: "That needs your Vanna smart account (C-address)." };
      }
      const amount = amountStr(rawArgs.amount, "1"); // schema requires amount
      return {
        args: {
          smart_account: smart,
          symbol: sym(rawArgs.symbol ?? rawArgs.asset, "USDC"),
          amount,
        },
      };
    }

    case "vanna_get_max_borrow": {
      if (!smart) {
        return { args: {}, blocker: "That needs your Vanna smart account (C-address)." };
      }
      return {
        args: {
          smart_account: smart,
          symbol: sym(rawArgs.symbol ?? rawArgs.asset, "USDC"),
        },
      };
    }

    case "vanna_get_token_balance": {
      const holder = (rawArgs.holder as string) || smart || trader;
      const token = rawArgs.token_contract as string;
      if (!holder || !token) {
        return {
          args: {},
          blocker: "Need holder address and token_contract for token balance.",
        };
      }
      return { args: { holder, token_contract: token } };
    }

    default: {
      // Pass through, but inject account fields when present and likely needed.
      const args = { ...rawArgs };
      if (smart && args.smart_account == null) args.smart_account = smart;
      if (trader && args.trader == null) args.trader = trader;
      // normalize common renames
      if (args.asset && !args.symbol) args.symbol = sym(args.asset);
      return { args };
    }
  }
}

/** Tools that can auto-resolve smart account from trader via vanna_resolve_account */
export function needsSmartAccount(tool: string): boolean {
  return [
    "vanna_get_account_health",
    "vanna_get_collateral",
    "vanna_get_debt",
    "vanna_can_borrow",
    "vanna_can_withdraw",
    "vanna_get_max_borrow",
    "vanna_get_farm_overview",
    "vanna_get_blend_position",
    "vanna_get_farm_lp_position",
    "vanna_get_lp_balance",
  ].includes(tool);
}
