import { allAssets } from "../registry/assets";
import type { InvestigationScope, ReadCapability, ReadCost } from "./types";

/**
 * Model-selected arguments only. Identity (trader, smart account, holder, G-address)
 * is bound in `bind()`, never declared here — a model that invents `g_address` is
 * rejected as unexpected arguments.
 */
export type ArgSpec =
  | { type: "enum"; values: readonly string[] }
  | { type: "decimal" }
  | { type: "enum_list"; values: readonly string[]; maxItems: number };

export type ReadScope = "public" | "wallet" | "account";

export interface CatalogEntry {
  name: string;
  tool: string;
  scope: ReadScope;
  cost: ReadCost;
  description: string;
  modelArgs: Record<string, ArgSpec>;
  bind: (args: Record<string, unknown>, scope: InvestigationScope) => Record<string, unknown>;
}

const assets = allAssets();
const earnAssets = assets.filter((asset) => asset.earnSymbol).map((asset) => asset.id);
const priceAssets = assets.map((asset) => asset.id);
const marginAssets = assets.filter((asset) => asset.marginSymbol).map((asset) => asset.id);
const blendAssets = assets.filter((asset) => asset.blendReserve).map((asset) => asset.id);

function requireAsset(id: unknown) {
  const asset = assets.find((entry) => entry.id === id);
  if (!asset) throw new Error("Unsupported asset for this read");
  return asset;
}

function symbolFor(
  args: Record<string, unknown>,
  field: "earnSymbol" | "oracleSymbol" | "marginSymbol",
): string {
  const symbol = requireAsset(args.asset)[field];
  if (!symbol) throw new Error("Unsupported asset for this read");
  return symbol;
}

/** Positive decimal as a string. Gemini often emits amounts as numbers; coerce those. */
export function decimalAmount(value: unknown): string {
  let text: string;
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e18) {
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new Error("Invalid read argument");
  }
  if (text.length > 60 || /e/i.test(text) || !/^\d+(\.\d{1,18})?$/.test(text) || !(Number(text) > 0)) {
    throw new Error("Invalid read argument");
  }
  return text;
}

export function validateModelArgs(
  modelArgs: Record<string, ArgSpec>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = Object.keys(modelArgs);
  if (Object.keys(args).length !== allowed.length || Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new Error("Unexpected or missing read arguments");
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(modelArgs)) {
    const value = args[key];
    if (spec.type === "enum") {
      if (typeof value !== "string" || !spec.values.includes(value)) throw new Error("Invalid read argument");
      out[key] = value;
    } else if (spec.type === "decimal") {
      out[key] = decimalAmount(value);
    } else {
      if (!Array.isArray(value) || value.length < 1 || value.length > spec.maxItems ||
        value.some((item) => typeof item !== "string" || !spec.values.includes(item))) {
        throw new Error("Invalid read argument");
      }
      out[key] = value;
    }
  }
  return out;
}

function extraArguments(modelArgs: Record<string, ArgSpec>): ReadCapability["extraArguments"] {
  const extra: NonNullable<ReadCapability["extraArguments"]> = {};
  for (const [key, spec] of Object.entries(modelArgs)) {
    if (spec.type === "decimal") extra[key] = "decimal";
    if (spec.type === "enum_list") extra[key] = "asset_list";
  }
  return Object.keys(extra).length ? extra : undefined;
}

function enumArguments(modelArgs: Record<string, ArgSpec>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(modelArgs)
      .filter((entry): entry is [string, Extract<ArgSpec, { type: "enum" | "enum_list" }>] =>
        entry[1].type === "enum" || entry[1].type === "enum_list")
      .map(([key, spec]) => [key, [...spec.values]]),
  );
}

/**
 * Audited read catalogue. Names stay capability names (not raw MCP ids) so the model
 * cannot aim a surface dispatcher at a write action. MCPClient remaps legacy tool
 * names. Writes, connect, and sign-enable are intentionally absent.
 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    name: "wallet_balances", tool: "vanna_get_wallet_balance", scope: "wallet", cost: "moderate",
    description: "Read spendable wallet balances. These are distinct from margin and farm positions.",
    modelArgs: {}, bind: (_, scope) => ({ g_address: scope.trader }),
  },
  {
    name: "account_health", tool: "vanna_get_account_health", scope: "account", cost: "expensive",
    description: "Read current margin health. This is not a projection or a guarantee of future health.",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "account_debt", tool: "vanna_get_debt", scope: "account", cost: "expensive",
    description: "Read existing margin debt before considering any new borrowing.",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "account_collateral", tool: "vanna_get_collateral", scope: "account", cost: "expensive",
    description: "Read posted margin collateral; do not count it as spendable wallet balance.",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "earn_market", tool: "vanna_get_pool_stats", scope: "public", cost: "cheap",
    description: "Read Vanna Earn rates and liquidity for one canonical asset. Not Blend farm rates. Bare USDC is ambiguous.",
    modelArgs: { asset: { type: "enum", values: earnAssets } },
    bind: (args) => ({ symbol: symbolFor(args, "earnSymbol") }),
  },
  {
    name: "asset_price", tool: "vanna_get_price", scope: "public", cost: "cheap",
    description: "Read an oracle price for a canonical asset. Shared price feeds do not make token variants interchangeable.",
    modelArgs: { asset: { type: "enum", values: priceAssets } },
    bind: (args) => ({ symbol: symbolFor(args, "oracleSymbol") }),
  },
  {
    name: "blend_markets", tool: "vanna_list_blend_reserves", scope: "public", cost: "cheap",
    description: "Discover supported Blend farm reserves and returned market information. Do not use Earn rates as Blend rates.",
    modelArgs: {}, bind: () => ({}),
  },
  {
    name: "aquarius_markets", tool: "vanna_list_aquarius_pools", scope: "public", cost: "cheap",
    description: "Discover Aquarius pools in Vanna Farm. Discovery alone does not supply an executable quote or allocation.",
    modelArgs: {}, bind: () => ({ scope: "vanna_farm" }),
  },
  {
    name: "signing_status", tool: "vanna_auto_sign_status", scope: "wallet", cost: "moderate",
    description: "Read server delegated-signing status and caps. Does not enable signing, prove general write availability, or grant approval.",
    modelArgs: {}, bind: (_, scope) => ({ wallet_address: scope.trader }),
  },
  {
    name: "max_borrow", tool: "vanna_get_max_borrow", scope: "account", cost: "moderate",
    description: "Largest amount of one margin asset the account could borrow now. A READ — it does not borrow. Use can_borrow when the user named a specific amount. Bare USDC is ambiguous; pick a variant.",
    modelArgs: { asset: { type: "enum", values: marginAssets } },
    bind: (args, scope) => ({ smart_account: scope.smartAccount, symbol: symbolFor(args, "marginSymbol") }),
  },
  {
    name: "can_borrow", tool: "vanna_can_borrow", scope: "account", cost: "moderate",
    description: "Whether a specific borrow amount is allowed on the margin account. A READ — it checks, it does not borrow. Amount must be the user's stated figure, never invented.",
    modelArgs: {
      asset: { type: "enum", values: marginAssets },
      amount: { type: "decimal" },
    },
    bind: (args, scope) => ({
      smart_account: scope.smartAccount, symbol: symbolFor(args, "marginSymbol"), amount: args.amount,
    }),
  },
  {
    name: "can_withdraw", tool: "vanna_can_withdraw", scope: "account", cost: "moderate",
    description: "Whether a specific collateral withdrawal is allowed without breaching health. A READ — it checks, it does not withdraw. Amount must be the user's stated figure, never invented. Live MCP serves this as vanna_margin_trade action=can_withdraw; mcp-client remaps the catalogue name so the model cannot aim at a write dispatcher.",
    modelArgs: {
      asset: { type: "enum", values: marginAssets },
      amount: { type: "decimal" },
    },
    bind: (args, scope) => ({
      smart_account: scope.smartAccount, symbol: symbolFor(args, "marginSymbol"), amount: args.amount,
    }),
  },
  {
    name: "farm_overview", tool: "vanna_get_farm_overview", scope: "account", cost: "expensive",
    description: "Summary of the user's farm positions across venues. Use for a general farm-position question. Not Earn vToken supply; that is earn_position.",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "blend_position", tool: "vanna_get_blend_position", scope: "account", cost: "expensive",
    description: "The user's supplied/borrowed Blend farm position. Use when the question is about their Blend position, not Blend market rates (blend_markets / blend_reserve).",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "farm_lp_position", tool: "vanna_get_farm_lp_position", scope: "account", cost: "expensive",
    description: "The user's Aquarius/Soroswap LP farm position. Use when they ask about LP or a named pair they hold, not for pool discovery (aquarius_markets).",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "lp_balance", tool: "vanna_get_lp_balance", scope: "account", cost: "expensive",
    description: "The user's LP token balance on Aquarius/Soroswap. Distinct from wallet_balances and from Earn vTokens.",
    modelArgs: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "prices_batch", tool: "vanna_get_prices_batch", scope: "public", cost: "cheap",
    description: "Oracle prices for several canonical assets in one read. Prefer this over repeated asset_price calls when comparing. Shared feeds do not make USDC variants interchangeable.",
    modelArgs: { assets: { type: "enum_list", values: priceAssets, maxItems: 8 } },
    bind: (args) => ({
      symbols: [...new Set((args.assets as string[]).map((id) => requireAsset(id).oracleSymbol))],
    }),
  },
  {
    name: "collateral_config", tool: "vanna_get_collateral_config", scope: "public", cost: "cheap",
    description: "Which assets the protocol accepts as collateral, with LTV and liquidation thresholds. Not the user's posted collateral (account_collateral).",
    modelArgs: {}, bind: () => ({}),
  },
  {
    name: "protocol_addresses", tool: "vanna_list_protocol_addresses", scope: "public", cost: "cheap",
    description: "Deployed Vanna contract addresses on this network. Not a user position and not an invitation to call those contracts.",
    modelArgs: {}, bind: () => ({}),
  },
  {
    name: "vtoken_exchange_rate", tool: "vanna_get_vtoken_exchange_rate", scope: "public", cost: "cheap",
    description: "vToken-to-underlying exchange rate for one Earn pool. Not a Blend bToken rate.",
    modelArgs: { asset: { type: "enum", values: earnAssets } },
    bind: (args) => ({ symbol: symbolFor(args, "earnSymbol") }),
  },
  {
    name: "earn_position", tool: "vanna_get_vtoken_balance", scope: "wallet", cost: "moderate",
    description: "The user's Earn vToken balance for one pool. Held by the G-wallet, not the margin account. Not Blend supply.",
    modelArgs: { asset: { type: "enum", values: earnAssets } },
    bind: (args, scope) => ({ holder: scope.trader, symbol: symbolFor(args, "earnSymbol") }),
  },
  {
    name: "list_smart_accounts", tool: "vanna_list_smart_accounts", scope: "wallet", cost: "moderate",
    description: "Smart accounts owned by the connected G-wallet. Does not create an account. Identity is bound server-side.",
    modelArgs: {}, bind: (_, scope) => ({ wallet_address: scope.trader }),
  },
  {
    name: "blend_reserve", tool: "vanna_get_blend_reserve_stats", scope: "public", cost: "moderate",
    description: "Stats for one Blend reserve. Use blend_markets to discover reserves first. Earn pool_stats is a different venue.",
    modelArgs: { asset: { type: "enum", values: blendAssets } },
    bind: (args) => {
      const asset = requireAsset(args.asset);
      return { symbol: asset.marginSymbol ?? asset.id };
    },
  },
  {
    name: "inactive_accounts", tool: "vanna_get_inactive_accounts", scope: "wallet", cost: "moderate",
    description: "Inactive margin accounts for the connected wallet. Not a live health or debt read.",
    modelArgs: {}, bind: (_, scope) => ({ trader: scope.trader }),
  },
];

export function catalogEntry(name: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.name === name);
}

export function catalogToolNames(): string[] {
  return CATALOG.map((entry) => entry.tool);
}

export function catalogReadNames(): string[] {
  return CATALOG.map((entry) => entry.name);
}

function available(definition: CatalogEntry, scope: InvestigationScope): boolean {
  if (definition.scope === "wallet") return !!scope.trader;
  if (definition.scope === "account") return !!scope.trader && !!scope.smartAccount;
  return true;
}

export function readCapabilities(scope: InvestigationScope): ReadCapability[] {
  return CATALOG.filter((definition) => available(definition, scope)).map((definition) => {
    const extra = extraArguments(definition.modelArgs);
    return {
      name: definition.name,
      description: definition.description,
      arguments: enumArguments(definition.modelArgs),
      ...(extra ? { extraArguments: extra } : {}),
      cost: definition.cost,
    };
  });
}

/** Validate BEFORE binding identity or calling MCP; never silently drop unknown args. */
export function resolveRead(
  capability: string,
  args: Record<string, unknown>,
  scope: InvestigationScope,
): { tool: string; args: Record<string, unknown> } {
  const definition = catalogEntry(capability);
  if (!definition || !available(definition, scope)) throw new Error("Read capability unavailable");
  const validated = validateModelArgs(definition.modelArgs, args);
  return { tool: definition.tool, args: definition.bind(validated, scope) };
}
