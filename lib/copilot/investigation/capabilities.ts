import { allAssets } from "../registry/assets";
import type { InvestigationScope, ReadCapability } from "./types";

type Definition = ReadCapability & {
  tool: string;
  scope: "public" | "wallet" | "account";
  bind: (args: Record<string, unknown>, scope: InvestigationScope) => Record<string, unknown>;
};

const assets = allAssets();
const earnAssets = assets.filter((asset) => asset.earnSymbol).map((asset) => asset.id);
const priceAssets = assets.map((asset) => asset.id);

function symbolFor(args: Record<string, unknown>, field: "earnSymbol" | "oracleSymbol"): string {
  const asset = assets.find((entry) => entry.id === args.asset);
  const symbol = asset?.[field];
  if (!symbol) throw new Error("Unsupported asset for this read");
  return symbol;
}

/**
 * Audited legacy reads, remapped by MCPClient to surface tools as needed.
 * Never accept an arbitrary MCP name/action: surface tools can include writes.
 */
const definitions: readonly Definition[] = [
  {
    name: "wallet_balances", tool: "vanna_get_wallet_balance", scope: "wallet",
    description: "Read spendable wallet balances. These are distinct from margin and farm positions.",
    arguments: {}, bind: (_, scope) => ({ g_address: scope.trader }),
  },
  {
    name: "account_health", tool: "vanna_get_account_health", scope: "account",
    description: "Read current margin health. This is not a projection or a guarantee of future health.",
    arguments: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "account_debt", tool: "vanna_get_debt", scope: "account",
    description: "Read existing margin debt before considering any new borrowing.",
    arguments: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "account_collateral", tool: "vanna_get_collateral", scope: "account",
    description: "Read posted margin collateral; do not count it as spendable wallet balance.",
    arguments: {}, bind: (_, scope) => ({ smart_account: scope.smartAccount }),
  },
  {
    name: "earn_market", tool: "vanna_get_pool_stats", scope: "public",
    description: "Read Vanna Earn rates and liquidity for one canonical asset. Not Blend farm rates. Bare USDC is ambiguous.",
    arguments: { asset: earnAssets }, bind: (args) => ({ symbol: symbolFor(args, "earnSymbol") }),
  },
  {
    name: "asset_price", tool: "vanna_get_price", scope: "public",
    description: "Read an oracle price for a canonical asset. Shared price feeds do not make token variants interchangeable.",
    arguments: { asset: priceAssets }, bind: (args) => ({ symbol: symbolFor(args, "oracleSymbol") }),
  },
  {
    name: "blend_markets", tool: "vanna_list_blend_reserves", scope: "public",
    description: "Discover supported Blend farm reserves and returned market information. Do not use Earn rates as Blend rates.",
    arguments: {}, bind: () => ({}),
  },
  {
    name: "aquarius_markets", tool: "vanna_list_aquarius_pools", scope: "public",
    description: "Discover Aquarius pools in Vanna Farm. Discovery alone does not supply an executable quote or allocation.",
    arguments: {}, bind: () => ({ scope: "vanna_farm" }),
  },
  {
    name: "signing_status", tool: "vanna_auto_sign_status", scope: "wallet",
    description: "Read server delegated-signing status and caps. Does not enable signing, prove general write availability, or grant approval.",
    arguments: {}, bind: (_, scope) => ({ wallet_address: scope.trader }),
  },
];

function available(definition: Definition, scope: InvestigationScope): boolean {
  if (definition.scope === "wallet") return !!scope.trader;
  if (definition.scope === "account") return !!scope.trader && !!scope.smartAccount;
  return true;
}

export function readCapabilities(scope: InvestigationScope): ReadCapability[] {
  return definitions.filter((definition) => available(definition, scope)).map((definition) => ({
    name: definition.name,
    description: definition.description,
    arguments: Object.fromEntries(Object.entries(definition.arguments).map(([key, values]) => [key, [...values]])),
  }));
}

/** Validate BEFORE binding identity or calling MCP; never silently drop unknown args. */
export function resolveRead(
  capability: string,
  args: Record<string, unknown>,
  scope: InvestigationScope,
): { tool: string; args: Record<string, unknown> } {
  const definition = definitions.find((entry) => entry.name === capability);
  if (!definition || !available(definition, scope)) throw new Error("Read capability unavailable");
  const allowed = Object.keys(definition.arguments);
  if (Object.keys(args).length !== allowed.length || Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new Error("Unexpected or missing read arguments");
  }
  for (const [key, values] of Object.entries(definition.arguments)) {
    const value = args[key];
    if (typeof value !== "string" || !values.includes(value)) throw new Error("Invalid read argument");
  }
  return { tool: definition.tool, args: definition.bind(args, scope) };
}
