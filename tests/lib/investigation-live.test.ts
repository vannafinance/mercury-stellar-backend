import { beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createFlashResearchModel } from "@/lib/copilot/investigation/flash";
import { runInvestigation } from "@/lib/copilot/investigation/runtime";

/**
 * Opt-in PAID Vertex evaluation with synthetic read fixtures, never live MCP/wallets.
 * RUN_FLASH_INVESTIGATION_EVAL=1 VERTEX_MODEL=gemini-3.8-flash
 * npx vitest run tests/lib/investigation-live.test.ts
 * A pass is one model smoke test, not an end-to-end strategy release gate.
 */
describe.skipIf(
  process.env.INVESTIGATION_EVAL_LIVE !== "1" && process.env.RUN_FLASH_INVESTIGATION_EVAL !== "1",
)("live Flash investigation / synthetic MCP", () => {
  beforeAll(() => {
    const envFile = resolve(process.cwd(), ".env.local");
    // Node preserves existing env overrides. Never print credentials or raw provider errors.
    if (existsSync(envFile)) loadEnvFile(envFile);
  });

  // The investigate/action router is gone: every prompt is investigated, and acting is a
  // separate step the caller takes afterwards. Nothing left here to classify.

  it("investigates the owner's open-ended prompt without creating transactions", async () => {
    const called: string[] = [];
    const flash = createFlashResearchModel();
    const fixtureData: Record<string, Record<string, unknown>> = {
      vanna_get_wallet_balance: { balances: [{ symbol: "XLM", balance: "50" }, { symbol: "AQUSDC", balance: "100" }] },
      vanna_get_account_health: { health_factor: 1.46, collateral_usd: "317.14", debt_usd: "217.59" },
      vanna_get_debt: { positions: [{ symbol: "XLM", amount: "1153.215122", value_usd: "217.59" }] },
      vanna_get_collateral: { collateral_usd: "317.14" },
      vanna_get_pool_stats: { supply_apy_pct: "2.0", borrow_apr_pct: "7.0" },
      vanna_get_price: { price_usd: "0.1887" },
      vanna_get_prices_batch: { prices: { XLM: { price_usd: "0.1887" }, USDC: { price_usd: "1.0" } } },
      vanna_get_max_borrow: { max_borrow_human: "250", symbol: "XLM" },
      vanna_list_blend_reserves: { reserves: [{ symbol: "XLM", supply_apy_pct: "1.0", borrow_apr_pct: "6.0" }] },
      vanna_list_aquarius_pools: { pools: [{ pair: "XLM/USDC", apy_pct: "3.0" }] },
      vanna_auto_sign_status: { enabled: false, status: "disabled" },
    };
    const result = await runInvestigation({
      message: "use both usdc and xlm to build a strategy in a way that health factor doesnt go below 1.3. You can use spot and farm markets yourself. You can even take new loans",
      history: [],
      scope: { subject: "synthetic_eval", trader: "G_SYNTHETIC", smartAccount: "C_SYNTHETIC", network: "testnet-fixture" },
    }, {
      model: async (turn, signal) => {
        try {
          return await flash(turn, signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          // Only emit fixed categories or this adapter's body-free HTTP status.
          const category = /^Vertex investigation HTTP \d+$/.test(message) ? message
            : /EPERM|EACCES|not permitted|access.*denied/i.test(message) ? "local permission denied"
            : /access token|credential|invalid_grant|invalid_rapt|google.auth|authentication/i.test(message) ? "authentication unavailable"
            : /fetch|network|ENOTFOUND|ECONN/i.test(message) ? "network unavailable"
            : /JSON|decision|finish|too large/i.test(message) ? "invalid provider response"
            : "unclassified provider failure";
          console.info("Flash research provider check:", category);
          throw error;
        }
      },
      mcp: { call: async (tool, args) => {
        called.push(tool);
        const fixture = fixtureData[tool];
        if (!fixture) throw new Error("Unexpected fixture capability");
        const data = tool === "vanna_get_price" && args.symbol !== "XLM" ? { price_usd: "1.0" } : fixture;
        return structuredClone({ ...data, synthetic_fixture: true });
      } },
    });
    console.info("Flash research smoke:", JSON.stringify({
      model: process.env.VERTEX_MODEL, outcome: result.outcome.kind,
      stopReason: result.outcome.kind === "stopped" ? result.outcome.reason : null,
      called, usage: result.usage,
    }));
    expect(result.executionAllowed).toBe(false);
    expect(called.length).toBeGreaterThan(0);
    expect(called.every((tool) => Object.hasOwn(fixtureData, tool))).toBe(true);
    expect(["clarify", "research_complete"]).toContain(result.outcome.kind);
    if (result.outcome.kind === "research_complete") {
      expect(result.outcome.goal.borrowing).toBe("allowed");
      expect(result.outcome.goal.constraints.join(" ")).toContain("1.3");
    }
  }, 70_000);

  it("investigates a named withdraw amount without killing the run", async () => {
    const called: string[] = [];
    const flash = createFlashResearchModel();
    const fixtureData: Record<string, Record<string, unknown>> = {
      vanna_can_withdraw: { allowed: true, symbol: "XLM", amount: "100" },
      vanna_get_wallet_balance: { balances: [{ symbol: "XLM", balance: "50" }] },
      vanna_get_account_health: { health_factor: 1.46, collateral_usd: "317.14", debt_usd: "217.59" },
      vanna_get_debt: { positions: [{ symbol: "XLM", amount: "1153.215122", value_usd: "217.59" }] },
      vanna_get_collateral: { collateral_usd: "317.14" },
      vanna_get_price: { price_usd: "0.1887" },
      vanna_auto_sign_status: { enabled: false, status: "disabled" },
    };
    const result = await runInvestigation({
      message: "can I withdraw 100 XLM without getting liquidated?",
      history: [],
      scope: { subject: "synthetic_eval", trader: "G_SYNTHETIC", smartAccount: "C_SYNTHETIC", network: "testnet-fixture" },
    }, {
      model: async (turn, signal) => {
        try {
          return await flash(turn, signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const category = /^Vertex investigation HTTP \d+$/.test(message) ? message
            : /access token|credential|invalid_grant|invalid_rapt|google.auth|authentication/i.test(message) ? "authentication unavailable"
            : /fetch|network|ENOTFOUND|ECONN/i.test(message) ? "network unavailable"
            : /JSON|decision|finish|too large/i.test(message) ? "invalid provider response"
            : "unclassified provider failure";
          console.info("Flash withdraw provider check:", category);
          throw error;
        }
      },
      mcp: { call: async (tool) => {
        called.push(tool);
        const fixture = fixtureData[tool];
        if (!fixture) return { error: "fixture_missing" };
        return structuredClone({ ...fixture, synthetic_fixture: true });
      } },
    });
    console.info("Flash withdraw smoke:", JSON.stringify({
      outcome: result.outcome.kind,
      stopReason: result.outcome.kind === "stopped" ? result.outcome.reason : null,
      called,
      capabilities: result.observations.map((observation) => [observation.capability, observation.status]),
      usage: result.usage,
    }));
    expect(result.executionAllowed).toBe(false);
    expect(["clarify", "research_complete", "blocked"]).toContain(result.outcome.kind);
    expect(called.includes("vanna_can_withdraw") || result.observations.some((observation) => observation.capability === "can_withdraw")).toBe(true);
  }, 70_000);
});
