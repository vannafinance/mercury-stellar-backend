import { describe, expect, it, vi } from "vitest";

/**
 * The Phase 2.5 prompt: a named withdraw amount must become a can_withdraw
 * observation and a factual answer, even when the first argument shape is bad.
 * A throw from that read used to kill the whole investigation as the generic
 * SSE "couldn't reach the information" error.
 */

const mocks = vi.hoisted(() => ({
  resolveInvestigationScope: vi.fn(),
  computeAccountPosition: vi.fn(),
  computeBorrowCapacity: vi.fn(),
}));

vi.mock("@/lib/copilot/investigation/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/scope")>();
  return { ...actual, resolveInvestigationScope: mocks.resolveInvestigationScope };
});

vi.mock("@/lib/copilot/investigation/capacity", () => ({
  computeAccountPosition: mocks.computeAccountPosition,
  computeBorrowCapacity: mocks.computeBorrowCapacity,
}));

const { researchTurn } = await import("@/lib/copilot/investigation/service");

const SCOPE = {
  subject: "user",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};

const PROMPT = "can I withdraw 100 XLM without getting liquidated?";

describe("withdraw eligibility research", () => {
  it("answers from a can_withdraw read instead of failing the investigation", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    mocks.computeBorrowCapacity.mockResolvedValue(null);

    const mcp = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_can_withdraw") {
          return { allowed: true, symbol: args.symbol, amount: args.amount };
        }
        throw new Error(`Unexpected tool ${tool}`);
      }),
    };
    let turn = 0;
    const result = await researchTurn(
      { message: PROMPT, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: "a".repeat(32),
        mcp, signal: new AbortController().signal,
        model: async () => turn++ === 0
          ? { kind: "inspect", reads: [{ capability: "can_withdraw", args: { asset: "XLM", amount: "100" } }] }
          : {
              kind: "research_complete",
              goal: {
                intent: "answer",
                relation: "new",
                objective: PROMPT,
                constraints: [],
                borrowing: "unspecified",
              },
              findings: [{ summary: "Withdraw 100 XLM is allowed on the current health check.", evidenceIds: ["e1"] }],
              openQuestions: [],
            },
      },
    );

    expect(result.status).toBe("researched");
    expect(result.message).toMatch(/withdraw 100 XLM is allowed on the current health check/);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "withdraw 100 XLM", value: "allowed", sourcePath: "allowed" }),
    ]));
    expect(result.checks.some((check) => check.label === "can withdraw" && check.status === "ok")).toBe(true);
    expect(mcp.call).toHaveBeenCalledWith(
      "vanna_can_withdraw",
      expect.objectContaining({ symbol: "XLM", amount: "100", smart_account: SCOPE.smartAccount }),
      SCOPE.trader,
    );
    expect(result.executionAllowed).toBe(false);
  });

  it("turns a malformed amount into a failed observation and still completes the retry", async () => {
    mocks.resolveInvestigationScope.mockResolvedValue(SCOPE);
    mocks.computeAccountPosition.mockResolvedValue(null);
    mocks.computeBorrowCapacity.mockResolvedValue(null);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const mcp = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_can_withdraw") {
          return { allowed: true, symbol: args.symbol, amount: args.amount };
        }
        throw new Error(`Unexpected tool ${tool}`);
      }),
    };
    const result = await researchTurn(
      { message: PROMPT, wallet: SCOPE.trader, continuation: null },
      {
        subject: SCOPE.subject, server: "mcp-test", network: "testnet", secret: "a".repeat(32),
        mcp, signal: new AbortController().signal,
        model: async (turn) => {
          const failed = turn.observations.find((observation) =>
            observation.capability === "can_withdraw" && observation.status === "error");
          const ok = turn.observations.find((observation) =>
            observation.capability === "can_withdraw" && observation.status === "ok");
          if (!failed && !ok) {
            return { kind: "inspect", reads: [{ capability: "can_withdraw", args: { asset: "XLM", amount: "100 XLM" } }] };
          }
          if (failed && !ok) {
            return { kind: "inspect", reads: [{ capability: "can_withdraw", args: { asset: "XLM", amount: "100" } }] };
          }
          return {
            kind: "research_complete",
            goal: {
              intent: "answer",
              relation: "new",
              objective: PROMPT,
              constraints: [],
              borrowing: "unspecified",
            },
            findings: [{ summary: "Withdraw 100 XLM is allowed.", evidenceIds: [ok!.id] }],
            openQuestions: [],
          };
        },
      },
    );

    expect(result.status).toBe("researched");
    expect(result.message).toMatch(/withdraw 100 XLM is allowed on the current health check/);
    expect(mcp.call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).toMatch(/investigation read rejected/);
    logged.mockRestore();
  });
});
