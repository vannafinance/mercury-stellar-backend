import { describe, expect, it, vi } from "vitest";
import { researchTurn } from "@/lib/copilot/investigation/service";
import type { ResearchTurn } from "@/lib/copilot/investigation/types";

describe("investigation history window", () => {
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
