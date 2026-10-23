import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeBudgetAfter, composeBudgetMs, composeReply } from "@/lib/copilot/investigation/compose";
import type { ResearchFact, ResearchView } from "@/lib/copilot/investigation/view";

/**
 * 24 Oct 2026, live: "What is my BLUSDC liquidation price...?" finished its research in 16 s with the
 * right facts, then the step that writes the answer was cut off at its fixed 15 s and the reply fell
 * back to a canned health-factor-and-collateral message - a different answer to a different question.
 * The route has 75 s; research had used 16 of them. The writing step now gets the time research left
 * (up to a cap), so the same call finishes instead of being thrown away: no extra request, no extra
 * tokens, only a longer wait for a call that was already made.
 */

const ROUTE = 75_000;
const fact = (id: string, label: string, value: string, unit: string): ResearchFact =>
  ({ id, label, value, unit, venue: "margin", evidenceId: "e0", sourcePath: id.split(":")[1] ?? id, readAt: 1 });
const FACTS = [fact("e0:health_factor", "Health factor", "81.86", "HF")];
const FALLBACK = "Your reported health factor is 81.86.";
const view = (): ResearchView => ({
  status: "researched", message: FALLBACK, originalRequest: "what is my BLUSDC liquidation price?", refinements: [],
  understanding: { intent: "answer", objective: "liquidation", constraints: [], borrowing: "unspecified" },
  question: null, facts: FACTS, checks: [], warnings: [],
  scope: { wallet: "G", smartAccount: "C", network: "testnet" }, continuation: "c", executionAllowed: false,
}) as ResearchView;

const slowReply = (ms: number) => () => new Promise<unknown>((resolve) => setTimeout(() => resolve({
  blocks: [{ type: "paragraph", segments: [{ type: "text", text: "BLUSDC is dollar-pegged. Your health factor is " }, { type: "fact", factId: "e0:health_factor" }, { type: "text", text: "." }] }],
}), ms));

beforeEach(() => { delete process.env.COPILOT_COMPOSE_BUDGET_MS; vi.useFakeTimers(); });
afterEach(() => { delete process.env.COPILOT_COMPOSE_BUDGET_MS; vi.useRealTimers(); });

describe("the writing step's budget", () => {
  it("a reply that arrives after the old fixed budget is kept when the route has time left", async () => {
    const pending = composeReply(view(), new AbortController().signal, slowReply(20_000), { budgetMs: 40_000 });
    await vi.advanceTimersByTimeAsync(20_001);
    const out = await pending;
    expect(out.message).toContain("dollar-pegged");
    expect(out.message).not.toBe(FALLBACK);
  });

  it("without more time it still gives up at the default budget, as before", async () => {
    expect(composeBudgetMs()).toBe(15_000);
    const pending = composeReply(view(), new AbortController().signal, slowReply(60_000));
    await vi.advanceTimersByTimeAsync(15_001);
    const out = await pending;
    expect(out.message).toBe(FALLBACK);
  });
});

describe("composeBudgetAfter: the time research left, never less than the default", () => {
  it("research that finished early leaves the writing step the most it may have", () => {
    expect(composeBudgetAfter(0, ROUTE)).toBe(45_000);
    expect(composeBudgetAfter(16_000, ROUTE)).toBe(45_000);
  });

  it("late research leaves what the route has left, minus a margin for the response", () => {
    expect(composeBudgetAfter(50_000, ROUTE)).toBe(22_000);
  });

  it("when the route is nearly spent it is the default, not a smaller number", () => {
    expect(composeBudgetAfter(70_000, ROUTE)).toBe(15_000);
    expect(composeBudgetAfter(200_000, ROUTE)).toBe(15_000);
  });

  it("an operator's configured budget is the floor", () => {
    process.env.COPILOT_COMPOSE_BUDGET_MS = "30000";
    expect(composeBudgetAfter(70_000, ROUTE)).toBe(30_000);
  });
});
