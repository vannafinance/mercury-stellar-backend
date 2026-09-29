/**
 * The model words the answer; code writes every figure. A composed reply may only say what
 * the reads said — any unread fact, typed digit, markup, or empty citation keeps the
 * deterministic reply, and so does a model that fails or runs late.
 */
import { describe, expect, it, vi } from "vitest";
import { bindBlocks, composable, composablePlans, composeReply, planFacts, plainReply } from "@/lib/copilot/investigation/compose";
import type { ResearchFact, ResearchView } from "@/lib/copilot/investigation/view";

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
    [{ blocks: [{ type: "table", rows: [] }] }, /unknown block/],
    [{ text: "no blocks" }, /no usable blocks/],
  ])("refuses %j", (raw, reason) => {
    const bound = bindBlocks(raw, FACTS);
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.reason).toMatch(reason);
  });
});

describe("composing a reply", () => {
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
    expect(await composeReply(original, new AbortController().signal, async () => { throw new Error("HTTP 503"); })).toBe(original);
    expect(await composeReply(original, new AbortController().signal, async () => ({ blocks: [{ type: "paragraph", text: "It is 2.32." }] }))).toBe(original);
  });

  it("leaves plans, questionnaires, warnings and refusals to their own replies", () => {
    expect(composable(view())).toBe(true);
    expect(composable(view({ warnings: ["note"] }))).toBe(false);
    expect(composable(view({ status: "blocked" }))).toBe(false);
    expect(composable(view({ understanding: { intent: "strategy", objective: "x", constraints: [], borrowing: "unspecified" } }))).toBe(false);
    expect(composable(view({ facts: [] }))).toBe(false);
    expect(composable(view({ proposalCandidateId: "requested_actions" }))).toBe(false);
    // The contract-basis health read keeps its own reply: the composer must never state 1.83.
    expect(composable(view({ facts: [...FACTS, fact("e0:posted_health_factor", "Posted-collateral health factor", "1.83", "HF")] }))).toBe(false);
  });

  it("gives up at its budget even when the model call never listens to the signal", async () => {
    vi.useFakeTimers();
    const original = view();
    const pending = composeReply(original, new AbortController().signal, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(6_001);
    expect(await pending).toBe(original);
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
