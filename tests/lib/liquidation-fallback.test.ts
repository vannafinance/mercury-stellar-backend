import { describe, expect, it } from "vitest";
import { liquidationObservation } from "@/lib/copilot/investigation/liquidation";
import { healthObservations } from "@/lib/copilot/investigation/fast-path";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import { factualAnswer } from "@/lib/copilot/investigation/answer";
import { composeReply } from "@/lib/copilot/investigation/compose";
import type { MarginSnapshot } from "@/lib/account-snapshot";
import type { ResearchView } from "@/lib/copilot/investigation/view";

/**
 * 24 Oct 2026, live: asked for a liquidation price, twice the reply was a generic health-factor,
 * debt and collateral listing. The facts held the answer; the writing step ran past its budget, and
 * the plain fallback printed everything it knew how to print except the liquidation facts. A
 * fallback may be plainer than the written reply, but it must carry the answer, not a neighbour's.
 */

type Row = { amount: string; usdValue: string };
const row = (amount: number, usd: number): Row => ({ amount: String(amount), usdValue: usd.toFixed(2) });
const SNAPSHOT = {
  collateralBalances: { XLM: row(5173.89, 919.95), AQUSDC: row(103.21, 103.22), BLUSDC: row(0.99, 0.99), BLEND_USDC: row(244.82, 245.11) },
  borrowedBalances: { AQUSDC: row(11.79, 11.8), XLM: row(47.0755, 8.37), BLUSDC: row(3.14, 3.14) },
} as unknown as MarginSnapshot;

// The service marks the health factor as required in the reply on a health answer; mirrored here.
const facts = () => normalizeResearchFacts([
  { ...healthObservations({ grossCollateralUsd: "1916.27", debtUsd: "23.31", healthFactor: "82.2086" })[0], id: "e0" },
  liquidationObservation(SNAPSHOT, 1000),
]).facts.map((fact) => (fact.sourcePath === "health_factor" ? { ...fact, requested: true, requiredInReply: true } : fact));

describe("the plain reply when the written one is unavailable", () => {
  it("carries the liquidation answer as well as the health factor", () => {
    const text = factualAnswer(facts(), "What is my BLUSDC liquidation price?") ?? "";
    expect(text).toContain("Your reported health factor is 82.21");
    expect(text).toContain("XLM liquidation price: none");
    expect(text).toContain("BLUSDC liquidation price: none, a dollar-pegged token");
  });

  it("a read with no liquidation facts adds nothing", () => {
    const only = normalizeResearchFacts([
      { ...healthObservations({ grossCollateralUsd: "1916.27", debtUsd: "23.31", healthFactor: "82.2086" })[0], id: "e0" },
    ]).facts;
    expect(factualAnswer(only, "what is my health factor?")).not.toMatch(/liquidation price/i);
  });

  it("composeReply falls back to it, liquidation answer included, when the model fails", async () => {
    const view = {
      status: "researched", message: "Your reported health factor is 82.21.", originalRequest: "What is my BLUSDC liquidation price?",
      refinements: [], understanding: { intent: "answer", objective: "liquidation", constraints: [], borrowing: "unspecified" },
      question: null, facts: facts(), checks: [], warnings: [],
      scope: { wallet: "G", smartAccount: "C", network: "testnet" }, continuation: "c", executionAllowed: false,
    } as unknown as ResearchView;
    const out = await composeReply(view, new AbortController().signal, async () => { throw new Error("late"); });
    expect(out.message).toContain("BLUSDC liquidation price: none, a dollar-pegged token");
  });

  it("prints any read's declared group under its own name, with no code that knows the read", () => {
    const some = [
      { id: "e9:a", label: "Projected health factor", value: "1.80", unit: "HF", venue: "margin", evidenceId: "e9", sourcePath: "projection.hf", readAt: 1, group: "What-if" },
      { id: "e9:b", label: "Projected leverage", value: "2.5", unit: "x", venue: "margin", evidenceId: "e9", sourcePath: "projection.lev", readAt: 1, group: "What-if" },
    ] as unknown as ResearchView["facts"];
    const text = factualAnswer(some, "if I borrow 300, what happens?") ?? "";
    expect(text).toContain("What-if:\n- Projected health factor: 1.80\n- Projected leverage: 2.50x");
  });
});
