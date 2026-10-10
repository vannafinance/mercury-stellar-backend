import { expect, it } from "vitest";
import { loadEnvFile } from "node:process";

// Explicit release verification: reads only, never session creation or signing.
it.skipIf(process.env.VANNA_MCP_DEPLOYMENT_LIVE !== "1")("verifies deployed margin measurement fields and public price reads", async () => {
  loadEnvFile(".env.local");
  const endpoint = process.env.VANNA_MCP_DEPLOYMENT_URL;
  const account = process.env.VANNA_HEALTH_READ_ACCOUNT;
  expect(endpoint).toBeTruthy();
  expect(account).toBeTruthy();
  process.env.MCP_BASE_URL = endpoint!;
  process.env.MCP_MODE = "live";
  const { getMcpClient } = await import("@/lib/copilot/mcp-client");
  const client = getMcpClient();
  const started = Date.now();
  const collateral = await client.call("vanna_get_collateral", { smart_account: account });
  expect(collateral.error).toBeUndefined();
  expect(collateral.is_margin_page_snapshot).toBe(false);
  expect(collateral.valuation_basis).toBe("posted_storage_and_verified_tracking_positions");
  const snapshot = await client.call("vanna_get_margin_snapshot", { smart_account: account });
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.health_basis).toBe("contract_risk_engine_not_website_composite");
  const display = snapshot.margin_display as {
    complete: boolean; farm_positions_included: boolean;
    collateral_deposited: Array<{ symbol: string; balance: string; value_usd: string; balance_basis: string }>;
    total_collateral_deposited_usd: string;
  };
  expect(display.complete).toBe(true);
  expect(display.farm_positions_included).toBe(false);
  expect(display.collateral_deposited.length).toBeGreaterThan(0);
  for (const row of display.collateral_deposited) {
    expect(row.balance_basis).toBe("collateral_deposited");
    expect(Number(row.balance)).toBeGreaterThan(0);
    expect(Number(row.value_usd)).toBeGreaterThan(0);
  }
  expect(Number(display.total_collateral_deposited_usd)).toBeCloseTo(
    display.collateral_deposited.reduce((sum, row) => sum + Number(row.value_usd), 0),
  );
  const price = await client.call("vanna_get_price", { symbol: display.collateral_deposited[0].symbol });
  expect(price.error).toBeUndefined();
  expect(Number(price.price_usd)).toBeGreaterThan(0);
  process.stdout.write(JSON.stringify({ endpoint, ms: Date.now() - started, depositedRows: display.collateral_deposited.length, complete: display.complete, healthBasis: snapshot.health_basis }) + "\n");
}, 120_000);
