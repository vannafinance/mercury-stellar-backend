import { describe, expect, it, vi } from "vitest";
import { researchTurn } from "@/lib/copilot/investigation/service";
import type { ResearchTurn } from "@/lib/copilot/investigation/types";
import { researchCodec } from "@/lib/copilot/investigation/continuation";

describe("investigation history window", () => {
  it.each([false, true])("continues an eight-prompt thread with source quotes intact (expired: %s)", async (expired) => {
    const secret = "a".repeat(32), server = "mcp-test";
    const scope = { subject: "guest", trader: null, smartAccount: null, network: "testnet" };
    const clock = expired ? () => Date.now() - 31 * 60_000 : Date.now;
    const codec = researchCodec(secret, server, clock);
    const prompts = ["keep 100 XLM liquid", ...Array.from({ length: 7 }, (_, i) => `earlier requirement ${i}`)];
    const seen: ResearchTurn[] = [];
    const result = await researchTurn({ message: "explain my earlier requirements", wallet: null, continuation: codec.seal(scope, prompts, null) }, {
      subject: "guest", server, network: "testnet", secret, signal: new AbortController().signal,
      mcp: { call: vi.fn(async () => { throw new Error("no MCP"); }) },
      model: async (turn) => { seen.push(turn); return { kind: "research_complete",
        goal: { intent: "answer", objective: "Explain the earlier requirements", constraints: [], borrowing: "unspecified", relation: "refine" },
        findings: [{ summary: "Your earlier requirement keeps 100 XLM liquid.", evidenceIds: [] }], openQuestions: [] }; },
    });
    expect(seen[0]?.task?.messages.some((message) => message.includes("keep 100 XLM liquid"))).toBe(true);
    const renewed = researchCodec(secret, server).open(result.continuation, scope);
    expect(renewed.messages.some((message) => message.includes("keep 100 XLM liquid"))).toBe(true);
    expect(renewed.messages.at(-1)).toBe("explain my earlier requirements");
    expect(result.executionAllowed).toBe(false);
  });
  it("hands the last turns to the model on a follow-up that is not a continuation token", async () => {
    const seen: ResearchTurn[] = [];
    const result = await researchTurn(
      {
        message: "what about my debt?",
        wallet: null,
        continuation: null,
        history: [
          { role: "user", text: "what's my health factor?" },
          { role: "assistant", text: "Your reported health factor is 2.43." },
        ],
      },
      {
        subject: "guest",
        server: "mcp-test",
        network: "testnet",
        secret: "a".repeat(32),
        mcp: { call: vi.fn(async () => { throw new Error("no MCP"); }) },
        signal: new AbortController().signal,
        model: async (turn) => {
          seen.push(turn);
          return {
            kind: "research_complete",
            goal: {
              intent: "answer",
              objective: "Explain debt after the health-factor answer",
              constraints: [],
              borrowing: "unspecified",
            },
            findings: [{ summary: "No live debt figure was read this turn.", evidenceIds: [] }],
            openQuestions: [],
          };
        },
      },
    );
    expect(seen[0]?.history).toEqual([
      { role: "user", text: "what's my health factor?" },
      { role: "assistant", text: "Your reported health factor is 2.43." },
    ]);
    expect(result.executionAllowed).toBe(false);
  });
});
