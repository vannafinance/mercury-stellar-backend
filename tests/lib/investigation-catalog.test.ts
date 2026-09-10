import { describe, expect, it } from "vitest";
import { CATALOG, readCapabilities, resolveRead } from "@/lib/copilot/investigation/catalog";
import { catalogToolNames } from "@/lib/copilot/investigation/capabilities";
import { readOnlyToolNames } from "@/lib/copilot/user-context";
import { toServerCall } from "@/lib/copilot/mcp-client";
import type { InvestigationScope } from "@/lib/copilot/investigation/types";

const account: InvestigationScope = {
  subject: "user_test", trader: "G_VERIFIED", smartAccount: "C_VERIFIED", network: "testnet",
};
const guest: InvestigationScope = {
  subject: "guest", trader: null, smartAccount: null, network: "testnet",
};

const WRITES = [
  "vanna_borrow", "vanna_lend", "vanna_swap", "vanna_enable_auto_sign", "vanna_open_account",
  "vanna_blend_supply", "vanna_add_liquidity", "vanna_deposit_collateral", "vanna_sign_and_submit",
];

const IDENTITY = ["g_address", "smart_account", "trader", "wallet_address", "holder", "subject"];

describe("investigation read catalogue", () => {
  it("keeps the original nine reads and adds the previously starved MCP reads", () => {
    const names = CATALOG.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining([
      "wallet_balances", "account_health", "account_debt", "account_collateral",
      "earn_market", "asset_price", "blend_markets", "aquarius_markets", "signing_status",
      "max_borrow", "can_borrow", "can_withdraw", "farm_overview", "blend_position",
      "farm_lp_position", "prices_batch", "collateral_config", "protocol_addresses",
      "vtoken_exchange_rate", "earn_position", "list_smart_accounts", "blend_reserve",
      "lp_balance", "inactive_accounts",
    ]));
    expect(new Set(names).size).toBe(names.length);
  });

  it("never declares a write, connect, or sign-enable tool", () => {
    const tools = catalogToolNames();
    for (const write of WRITES) expect(tools).not.toContain(write);
    for (const tool of tools) {
      if (tool === "vanna_auto_sign_status") continue;
      expect(readOnlyToolNames()).toContain(tool);
    }
  });

  it("never lets the model select identity arguments or bare USDC", () => {
    for (const entry of CATALOG) {
      for (const key of Object.keys(entry.modelArgs)) {
        expect(IDENTITY).not.toContain(key);
      }
      for (const spec of Object.values(entry.modelArgs)) {
        if (spec.type === "enum" || spec.type === "enum_list") {
          expect(spec.values).not.toContain("USDC");
        }
      }
    }
  });

  it("hides wallet and account reads from a public/guest scope", () => {
    const names = readCapabilities(guest).map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining([
      "asset_price", "earn_market", "prices_batch", "collateral_config", "protocol_addresses",
    ]));
    expect(names).not.toContain("wallet_balances");
    expect(names).not.toContain("can_borrow");
    expect(names).not.toContain("farm_overview");
  });

  it("binds identity and venue symbols outside the model", () => {
    expect(resolveRead("earn_market", { asset: "BLUSDC" }, account))
      .toEqual({ tool: "vanna_get_pool_stats", args: { symbol: "USDC" } });
    expect(resolveRead("max_borrow", { asset: "BLUSDC" }, account))
      .toEqual({ tool: "vanna_get_max_borrow", args: { smart_account: "C_VERIFIED", symbol: "USDC" } });
    expect(resolveRead("can_borrow", { asset: "XLM", amount: 20 }, account))
      .toEqual({ tool: "vanna_can_borrow", args: { smart_account: "C_VERIFIED", symbol: "XLM", amount: "20" } });
    expect(resolveRead("can_withdraw", { asset: "XLM", amount: "5.5" }, account))
      .toEqual({ tool: "vanna_can_withdraw", args: { smart_account: "C_VERIFIED", symbol: "XLM", amount: "5.5" } });
    expect(resolveRead("prices_batch", { assets: ["XLM", "BLUSDC", "AQUSDC"] }, guest))
      .toEqual({ tool: "vanna_get_prices_batch", args: { symbols: ["XLM", "USDC"] } });
    expect(resolveRead("earn_position", { asset: "BLUSDC" }, account))
      .toEqual({ tool: "vanna_get_vtoken_balance", args: { holder: "G_VERIFIED", symbol: "USDC" } });
    expect(resolveRead("list_smart_accounts", {}, account))
      .toEqual({ tool: "vanna_list_smart_accounts", args: { wallet_address: "G_VERIFIED" } });
    expect(resolveRead("blend_reserve", { asset: "BLUSDC" }, guest))
      .toEqual({ tool: "vanna_get_blend_reserve_stats", args: { symbol: "USDC" } });
  });

  it("rejects identity injection, invented amounts, and unknown capabilities before MCP", () => {
    expect(() => resolveRead("wallet_balances", { g_address: "G_OTHER" }, account)).toThrow();
    expect(() => resolveRead("can_borrow", { asset: "XLM", amount: "10", smart_account: "C_OTHER" }, account)).toThrow();
    expect(() => resolveRead("can_borrow", { asset: "XLM" }, account)).toThrow();
    expect(() => resolveRead("can_borrow", { asset: "XLM", amount: "0" }, account)).toThrow();
    expect(() => resolveRead("asset_price", { asset: "USDC" }, account)).toThrow();
    expect(() => resolveRead("vanna_borrow", { amount: "1000" }, account)).toThrow();
    expect(() => resolveRead("can_borrow", { asset: "XLM", amount: "10" }, guest)).toThrow();
    expect(() => resolveRead("prices_batch", { assets: ["XLM", "XLM", "XLM", "XLM", "XLM", "XLM", "XLM", "XLM", "BLUSDC"] }, guest)).toThrow();
  });

  it("maps every catalogue tool onto a live MCP surface dispatcher", () => {
    const surfaces = new Set([
      "vanna_oracle", "vanna_protocol_info", "vanna_account", "vanna_margin_status",
      "vanna_margin_trade", "vanna_earn_market", "vanna_earn_position", "vanna_earn_write",
      "vanna_farm_overview", "vanna_farm_blend", "vanna_farm_lp", "vanna_wallet",
      "vanna_sign", "vanna_swap",
    ]);
    expect(toServerCall("vanna_can_withdraw", { smart_account: "C", symbol: "XLM", amount: "100" }))
      .toEqual({ name: "vanna_margin_trade", arguments: { action: "can_withdraw", kwargs: { smart_account: "C", symbol: "XLM", amount: "100" } } });
    expect(toServerCall("vanna_auto_sign_status", { wallet_address: "G" }))
      .toEqual({ name: "vanna_sign", arguments: { action: "session_status", kwargs: { wallet_address: "G" } } });
    for (const entry of CATALOG) {
      const call = toServerCall(entry.tool, { marker: true });
      expect([...surfaces]).toContain(call.name);
      expect(call.arguments).toEqual({ action: expect.any(String), kwargs: { marker: true } });
    }
  });
});
