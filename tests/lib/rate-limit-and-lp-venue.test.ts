/**
 * 24 Sep, from the dev diagnostics file (#12 XS5, #13 X14):
 *  - every failed read was the MCP's own `rate_limited` 429, which was never retried
 *    because fetch resolves on a 429 and `withRetry` only retries a throw;
 *  - both X14 plans were dropped because the model named the venue on remove_liquidity.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimitTiming, retryRateLimited } from "@/lib/copilot/mcp-client";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { lpPairs, lpVenues } from "@/lib/copilot/registry/assets";

const refused = (code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: code, message: "Too many MCP calls." }), { status: 429, headers });
const ok = () => new Response("{}", { status: 200 });

describe("the MCP's rate-limit refusal", () => {
  const waits: number[] = [];
  const origSleep = rateLimitTiming.sleep;
  rateLimitTiming.sleep = async (ms: number) => { waits.push(ms); };
  afterEach(() => { waits.length = 0; });

  it("is retried until the call goes through", async () => {
    const send = vi.fn().mockResolvedValueOnce(refused("rate_limited")).mockResolvedValueOnce(refused("rate_limited")).mockResolvedValue(ok());
    expect((await retryRateLimited(send)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("is not retried when the 429 means the tool is degraded", async () => {
    const send = vi.fn().mockImplementation(async () => refused("tool_circuit_open"));
    const res = await retryRateLimited(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "tool_circuit_open" });
  });

  it("stops after its retries and hands back a readable refusal", async () => {
    const send = vi.fn().mockImplementation(async () => refused("rate_limited"));
    const res = await retryRateLimited(send);
    expect(send).toHaveBeenCalledTimes(5);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(Math.max(...waits)).toBeLessThanOrEqual(4000);
  });

  it("waits what the server says when it says", async () => {
    const send = vi.fn().mockResolvedValueOnce(refused("rate_limited", { "retry-after": "2" })).mockResolvedValue(ok());
    await retryRateLimited(send);
    expect(waits).toEqual([2000]);
  });

  it("returns the refusal when Retry-After exceeds the bounded retry window", async () => {
    const send = vi.fn().mockResolvedValue(refused("rate_limited", { "retry-after": "5" }));
    const res = await retryRateLimited(send);
    expect(res.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("passes every other status through untouched", async () => {
    const send = vi.fn().mockResolvedValue(new Response("x", { status: 503 }));
    expect((await retryRateLimited(send)).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    rateLimitTiming.sleep = origSleep;
  });
});

describe("a venue named on a one-asset LP leg", () => {
  const decide = (leg: Record<string, unknown>) => parseDecision({
    kind: "research_complete",
    goal: { objective: "Rebalance", constraints: [], borrowing: "forbidden" },
    findings: [{ summary: "LP was read.", evidenceIds: ["e1"] }],
    openQuestions: [],
    plans: [{ title: "Exit LP", rationale: "r", evidenceIds: ["e1"], legs: [leg] }],
  });
  const plansOf = (leg: Record<string, unknown>) => {
    const parsed = decide(leg);
    if (parsed?.kind !== "research_complete") throw new Error("not complete");
    return parsed;
  };
  // Derived from the registry: an asset in exactly one pool, and that pool's venue.
  const [single] = lpPairs().filter((p) => lpPairs().filter((q) => q.tokens.includes(p.tokens[1])).length === 1);
  const other = lpVenues().find((v) => v !== single.venue)!;
  const sizing = { kind: "all_position" };

  it("stands when it is the one pool that holds the asset (X14)", () => {
    const parsed = plansOf({ op: "remove_liquidity", asset: single.tokens[1], sizing, venue: single.venue });
    expect(parsed.plans?.[0].legs).toEqual([{ op: "remove_liquidity", asset: single.tokens[1], sizing: { kind: "all_position" } }]);
  });

  it("is refused when it names a different pool", () => {
    const parsed = plansOf({ op: "remove_liquidity", asset: single.tokens[1], sizing, venue: other });
    expect(parsed.plans ?? []).toEqual([]);
    expect(parsed.droppedPlanReasons?.[0]).toContain(`is not the one pool that holds ${single.tokens[1]}`);
  });

  it("is refused for an asset in several pools, rather than ignored", () => {
    const shared = lpPairs()[0].tokens[0];
    const parsed = plansOf({ op: "remove_liquidity", asset: shared, sizing, venue: single.venue });
    expect(parsed.plans ?? []).toEqual([]);
  });

  it("is still an unknown key on an op that never touches a pool", () => {
    const parsed = plansOf({ op: "lend", asset: single.tokens[1], sizing: { kind: "all_idle" }, venue: single.venue });
    expect(parsed.plans ?? []).toEqual([]);
  });
});
