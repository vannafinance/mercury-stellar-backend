/**
 * The model words the answer; code writes every figure. A composed reply may only say what
 * the reads said - any unread fact, typed digit, markup, or empty citation keeps the
 * deterministic reply, and so does a model that fails or runs late.
 */
import { describe, expect, it, vi } from "vitest";
import { bindBlocks, completionFacts, composable, composablePlans, composeBudgetMs, composeCompletion, composeReply, planFacts, plainReply } from "@/lib/copilot/investigation/compose";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { ResearchFact, ResearchView } from "@/lib/copilot/investigation/view";
import { factualAnswer } from "@/lib/copilot/investigation/answer";

const fact = (id: string, label: string, value: string, unit: string, venue: ResearchFact["venue"] = "margin"): ResearchFact =>
  ({ id, label, value, unit, venue, evidenceId: "e0", sourcePath: id.split(":")[1] ?? id, readAt: 1 });
const FACTS = [
  fact("e0:health_factor", "Health factor", "2.3244", "HF"),
  fact("e0:debt_usd", "Margin debt", "2151.93", "USD"),
];

function view(over: Partial<ResearchView> = {}): ResearchView {
  return {
    status: "researched", message: "Your reported health factor is 2.32. Your reported margin debt is $2,151.93.",
    originalRequest: "what's my health factor?", refinements: [],
    understanding: { intent: "answer", objective: "hf", constraints: [], borrowing: "unspecified" },
    question: null, facts: FACTS, checks: [], warnings: [],
    scope: { wallet: "G", smartAccount: "C", network: "testnet" }, continuation: "c", executionAllowed: false,
    ...over,
  } as ResearchView;
}

describe("binding the model's blocks", () => {
  it("keeps required figures in the verified fallback for unseen wording", () => {
    expect(factualAnswer([{ ...FACTS[0], requiredInReply: true }], "Report my present account safety measure")).toContain("2.32");
  });
  it("refuses a reply that drops a required figure while quoting another fact", () => {
    const bound = bindBlocks({ blocks: [{ type: "paragraph", text: "Debt: {{e0:debt_usd}}" }] }, [{ ...FACTS[0], requiredInReply: true }, FACTS[1]]);
    expect(bound.ok).toBe(false);
  });
  it("substitutes audited values and marks them as figures", () => {
    const bound = bindBlocks({ blocks: [
      { type: "paragraph", text: "Your health factor is {{e0:health_factor}}, comfortably above the liquidation line." },
      { type: "bullets", items: ["Debt: {{e0:debt_usd}}"] },
    ] }, FACTS);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(plainReply(bound.blocks)).toBe("Your health factor is 2.32, comfortably above the liquidation line.\n\n• Debt: $2,151.93");
    const first = bound.blocks[0];
    expect(first.type === "paragraph" && first.segments.filter((s) => s.figure).map((s) => s.text)).toEqual(["2.32"]);
  });

  it.each([
    [{ blocks: [{ type: "paragraph", text: "Your health factor is 2.32." }] }, /figure the model wrote/],
    [{ blocks: [{ type: "paragraph", text: "Collateral is {{e0:collateral_usd}}." }] }, /not read/],
    [{ blocks: [{ type: "paragraph", text: "**Healthy**: {{e0:health_factor}}" }] }, /markup/],
    [{ blocks: [{ type: "paragraph", text: "See [docs](x) for {{e0:health_factor}}" }] }, /markup or a link/],
    [{ blocks: [{ type: "paragraph", text: "You look healthy." }] }, /cites no fact/],
    [{ blocks: [{ type: "table", rows: [] }] }, /invalid table/],
    [{ text: "no blocks" }, /no usable blocks/],
  ])("refuses %j", (raw, reason) => {
    const bound = bindBlocks(raw, FACTS);
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.reason).toMatch(reason);
  });
});

describe("composing a reply", () => {
  it("allows a valid model response beyond the former six-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = composeReply(view(), new AbortController().signal, () => new Promise((resolve) => setTimeout(() => resolve({ blocks: [{ type: "paragraph", text: "Health factor: {{e0:health_factor}}." }] }), 7_000)));
      await vi.advanceTimersByTimeAsync(7_001);
      expect((await pending).message).toBe("Health factor: 2.32.");
    } finally { vi.useRealTimers(); }
  });
  it("keeps a failed prose call structured for any supplied row group", async () => {
    const original = view({ originalRequest: "Show positions", facts: [
      { ...fact("e1:collateral[0].balance", "XLM collateral balance", "70.1234567", "XLM"), evidenceId: "e1", sourcePath: "collateral[0].balance", quantity: true },
    ] });
    const out = await composeReply(original, new AbortController().signal, async () => { throw new Error("offline"); });
    expect(out.replyBlocks?.map((block) => block.type)).toEqual(["heading", "bullets"]);
    expect(out.message).toContain("70.12");
    expect(out.facts[0].value).toBe("70.1234567");
  });
  it("replaces the reply with the bound blocks and keeps a plain-text message", async () => {
    const generate = vi.fn(async () => ({ blocks: [{ type: "paragraph", text: "Your health factor is {{e0:health_factor}}." }] }));
    const out = await composeReply(view(), new AbortController().signal, generate);
    expect(out.message).toBe("Your health factor is 2.32.");
    expect(out.replyBlocks).toHaveLength(1);
    // The model sees the facts and the question, and the draft only for meaning.
    const user = JSON.parse((generate.mock.calls[0] as unknown as [string, string])[1]);
    expect(user.question).toBe("what's my health factor?");
    expect(user.facts.map((f: { id: string }) => f.id)).toEqual(FACTS.map((f) => f.id));
    expect(user.facts[1].shown).toBe("$2,151.93");
  });

  it("keeps the deterministic reply when the model fails or writes a figure", async () => {
    const original = view();
    for (const generate of [async () => { throw new Error("HTTP 503"); }, async () => ({ blocks: [{ type: "paragraph", text: "It is 2.32." }] })]) {
      const fallback = await composeReply(original, new AbortController().signal, generate);
      expect(fallback.message).toBe(original.message);
      expect(fallback.replyBlocks?.length).toBeGreaterThan(0);
      expect(fallback.executionAllowed).toBe(false);
    }
  });

  it("leaves plans, questionnaires and refusals to their own replies", () => {
    expect(composable(view())).toBe(true);
    expect(composable(view({ warnings: ["note"] }))).toBe(true);
    expect(composable(view({ status: "blocked" }))).toBe(false);
    expect(composable(view({ understanding: { intent: "strategy", objective: "x", constraints: [], borrowing: "unspecified" } }))).toBe(false);
    expect(composable(view({ facts: [] }))).toBe(false);
    expect(composable(view({ proposalCandidateId: "requested_actions" }))).toBe(false);
    // The contract-basis health read keeps its own reply: the composer must never state 1.83.
    expect(composable(view({ facts: [...FACTS, fact("e0:posted_health_factor", "Posted-collateral health factor", "1.83", "HF")] }))).toBe(false);
  });

  it("answers from available verified rates while retaining failed-read warnings and no execution authority", async () => {
    const original = view({
      originalRequest: "Compare the available lending rates",
      facts: [fact("e0:supply_apr_pct", "Earn supply APR", "17.77", "% APR", "earn")],
      warnings: ["asset price: data was unavailable. No value was assumed."],
    });
    const generate = vi.fn(async () => ({ blocks: [{ type: "paragraph", text: "The observed Earn supply APR is {{e0:supply_apr_pct}}." }] }));
    const out = await composeReply(original, new AbortController().signal, generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.message).toContain("17.77% APR");
    expect(out.warnings).toEqual(original.warnings);
    expect(out.facts).toEqual(original.facts);
    expect(out.executionAllowed).toBe(false);
    const input = JSON.parse((generate.mock.calls[0] as unknown as [string, string])[1]);
    expect(input.context.warnings).toEqual(original.warnings);
    // Venue-local USDC must not imply that every stable variant is eligible.
    expect(input.context.venueAssets.find((row: { venue: string }) => row.venue === "blend").assets).toContain("BLUSDC");
    expect(input.context.venueAssets.find((row: { venue: string }) => row.venue === "blend").assets).not.toContain("SOUSDC");
    expect(input.context.venueUsdc).toContainEqual({ venue: "blend", usdc: "BLUSDC" });
  });

  it("gives up at its budget even when the model call never listens to the signal", async () => {
    vi.useFakeTimers();
    const original = view();
    const pending = composeReply(original, new AbortController().signal, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(composeBudgetMs() + 1);
    expect((await pending).message).toBe(original.message);
    vi.useRealTimers();
  });

  it("is off when the flag says so", async () => {
    process.env.COPILOT_COMPOSED_REPLIES = "off";
    const generate = vi.fn();
    const original = view();
    expect(await composeReply(original, new AbortController().signal, generate)).toBe(original);
    expect(generate).not.toHaveBeenCalled();
    delete process.env.COPILOT_COMPOSED_REPLIES;
  });
});

describe("composing the words above plan cards", () => {
  const plan = (over: Record<string, unknown>) => ({
    id: "x", kind: "lend_idle", borrows: false, venue: "earn", netAprPct: null, legs: [], evidenceIds: [], amountBasis: "stated",
    label: "Lend idle SOUSDC to Earn", asset: "SOUSDC", amountUsd: "1370.21", supplyAprPct: "6.1", supplyApyPct: "6.29",
    finalHealthFactor: "2.3244", initialHealthFactor: "2.3244", ...over,
  });
  const strategy = (over: Partial<ResearchView> = {}) => view({
    understanding: { intent: "strategy", objective: "idle", constraints: [], borrowing: "unspecified" },
    facts: [fact("e0:posted_health_factor", "Posted-collateral health factor", "1.83", "HF")],
    candidates: { feasible: [plan({ decision: { factor: "already_held", reason: "", runnerUpId: null } }), plan({ label: "Repay XLM", repaysAllDebt: true, borrows: false })], rejected: [] },
    ...over,
  } as Partial<ResearchView>);

  it("carries operation destinations and unresolved scope into the plan reply", async () => {
    const original = strategy({ question: "Margin debt prevents full wallet withdrawal.", candidates: {
      feasible: [plan({ steps: [{ op: "redeem", asset: "XLM" }, { op: "blend_withdraw", asset: "XLM" }, { op: "remove_liquidity", asset: "SOUSDC" }] })], rejected: [],
    } } as Partial<ResearchView>);
    const generate = vi.fn(async () => ({ blocks: [{ type: "paragraph", text: "{{planA:name}}." }] }));
    await composeReply(original, new AbortController().signal, generate);
    const payload = JSON.parse((generate.mock.calls[0] as unknown as [string, string])[1]);
    expect(payload.plans[0].movements).toEqual([
      { op: "redeem", from: "earn", to: "wallet" },
      { op: "blend_withdraw", from: "blend", to: "account" },
      { op: "remove_liquidity", from: "lp", to: "account" },
    ]);
    expect(payload.context.openPoint).toBe(original.question);
  });

  it("names the operations the user allowed that no plan uses, and none that a plan does", () => {
    const used = strategy()?.candidates?.feasible?.[0]?.steps?.[0]?.op;
    const view = strategy({ understanding: { objective: "o", constraints: [], borrowing: "allowed", intent: "strategy", venuesAllowed: [{ op: "swap", sourceQuote: "q" }, ...(used ? [{ op: used, sourceQuote: "q" }] : [])] } } as Partial<ResearchView>);
    expect(planFacts(view).notUsed).toEqual(used === "swap" ? [] : [{ operation: "swap", reason: null }]);
    expect(planFacts(strategy()).notUsed).toEqual([]);
  });

  it("offers the model only the plans' own figures, lettered as the cards are", () => {
    const { facts, plans, lead } = planFacts(strategy());
    expect(plans.map((p) => p.plan)).toEqual(["A", "B"]);
    expect(lead).toBe("already_held");
    expect(plans[0].facts.find((f) => f.id === "planA:rate")?.shown).toBe("6.29% APY");
    expect(plans[1].facts.find((f) => f.id === "planB:hf_after")?.shown).toBe("no debt left");
    // The raw reads (here a contract-basis health factor) never reach a plan reply.
    expect(facts.some((f) => f.value === "1.83")).toBe(false);
  });

  it("composes a strategy's plans but leaves a direct action's execution alone", async () => {
    expect(composablePlans(strategy())).toBe(true);
    expect(composablePlans(strategy({ proposalCandidateId: "requested_actions" }))).toBe(false);
    const generate = vi.fn(async () => ({ blocks: [{ type: "paragraph", text: "Plan A leads at {{planA:rate}}; nothing runs until you approve a plan." }] }));
    const out = await composeReply(strategy(), new AbortController().signal, generate);
    expect(out.message).toBe("Plan A leads at 6.29% APY; nothing runs until you approve a plan.");
    // Citing a raw read's id on a plan turn is refused: only plan facts are bindable there.
    const leak = await composeReply(strategy(), new AbortController().signal, async () => ({ blocks: [{ type: "paragraph", text: "Your HF is {{e0:posted_health_factor}}." }] }));
    expect(leak.replyBlocks).toBeUndefined();
  });
});

describe("composing the reply once a run has finished", () => {
  const run = (status: WorkflowView["status"], steps: Array<Record<string, unknown>>) => ({
    id: "11111111-1111-1111-1111-111111111111", revision: 1, digest: "d", status, objective: "supply 5 xlm to blend",
    expiresAt: 0, assumptions: [], constraints: [], message: "", slippageAccepted: false, steps,
  }) as unknown as WorkflowView;
  const settled = { id: "s1", op: "supply_blend", asset: "XLM", amount: "5", label: "Supply 5 XLM to Blend", status: "settled" };
  const comparisons = [{ asset: "XLM", blendSupplyApr: "12" }] as never;

  it("states the settled step in the past tense, its rate, and the health factor read after the run", () => {
    const facts = completionFacts(run("completed", [settled]), comparisons, "2.41");
    const byId = Object.fromEntries(facts.map((f) => [f.id, f.value]));
    expect(byId["stepA:done"]).toBe("Supplied 5 XLM to Blend");
    expect(byId["stepA:amount"]).toBe("5");
    expect(Number(byId["stepA:rate"])).toBeGreaterThan(12); // APY from the read APR
    expect(byId["account:health_now"]).toBe("2.41");
  });

  it("counts only settled steps, and says a stopped run stopped", async () => {
    const generate = vi.fn(async () => ({ blocks: [{ type: "paragraph", text: "{{stepA:done}}; the rest was not submitted." }] }));
    const view = run("blocked", [settled, { ...settled, id: "s2", label: "Lend 5 XLM to Earn", op: "lend", status: "failed" }]);
    const out = await composeCompletion({ view, request: "x", draft: "1 of 2 steps went through.", comparisons, healthNow: null }, new AbortController().signal, generate);
    expect(out?.message).toBe("Supplied 5 XLM to Blend; the rest was not submitted.");
    const user = JSON.parse((generate.mock.calls[0] as unknown as [string, string])[1]);
    expect(user.stopped).toEqual({ status: "blocked" });
    expect(user.facts.some((f: { id: string }) => f.id.startsWith("stepB"))).toBe(false);
  });

  /**
   * 7 Oct, live: the plans reply came back as the deterministic template ("Non-borrowing Farm & Earn: ... deposit
   * 1496.767159 XLM ...") because the model typed a digit once and the whole reply was refused. A refusal now says why,
   * and the model gets one more try with that reason; the template is the fallback only if it fails again.
   */
  it("asks once more, with the validator's reason, when the first reply is refused", async () => {
    const view = run("completed", [settled]);
    const generate = vi.fn()
      .mockResolvedValueOnce({ blocks: [{ type: "paragraph", text: "Supplied 5 XLM." }] })
      .mockResolvedValueOnce({ blocks: [{ type: "paragraph", text: "{{stepA:done}}." }] });
    const out = await composeCompletion({ view, request: "x", draft: "Done.", comparisons, healthNow: null }, new AbortController().signal, generate);
    expect(out?.message).toBe("Supplied 5 XLM to Blend.");
    expect(generate).toHaveBeenCalledTimes(2);
    const retry = JSON.parse((generate.mock.calls[1] as unknown as [string, string])[1]);
    expect(retry.previousReplyRefused).toMatch(/figure the model wrote itself/);
    expect(JSON.parse((generate.mock.calls[0] as unknown as [string, string])[1])).not.toHaveProperty("previousReplyRefused");
  });

  it("gives up after the second refusal, and does not ask a third time", async () => {
    const view = run("completed", [settled]);
    const generate = vi.fn(async () => ({ blocks: [{ type: "paragraph", text: "Supplied 5 XLM." }] }));
    expect(await composeCompletion({ view, request: "x", draft: "Done.", comparisons, healthNow: null }, new AbortController().signal, generate)).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the deterministic reply when the model writes a figure or fails", async () => {
    const view = run("completed", [settled]);
    expect(await composeCompletion({ view, request: "x", draft: "Done.", comparisons, healthNow: null }, new AbortController().signal,
      async () => ({ blocks: [{ type: "paragraph", text: "Supplied 5 XLM." }] }))).toBeNull();
    expect(await composeCompletion({ view, request: "x", draft: "Done.", comparisons, healthNow: null }, new AbortController().signal,
      async () => { throw new Error("503"); })).toBeNull();
  });
});
