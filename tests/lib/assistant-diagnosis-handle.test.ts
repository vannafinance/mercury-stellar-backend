/**
 * Failure questions on the Assistant surface must hit the Guide with session
 * events, never the write planner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/copilot/assistant-horizon", () => ({
  lookupAssistantTx: vi.fn(async () => ({
    hash: "a".repeat(64),
    status: "NOT_FOUND",
    detail: "No ledger result yet",
  })),
}));

vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return {
    ...orig,
    vertexGuideAnswer: vi.fn(async (_q: string, ctx: string | null) => ({
      question: "why did my transaction fail",
      summary:
        "The wallet cancelled the signature. Nothing was submitted on chain.",
      sections: [
        {
          heading: "What happened",
          body: ctx?.includes("wallet_rejected")
            ? "You closed the wallet prompt. That is not an on-chain failure."
            : "No session event was provided.",
        },
      ],
      terms: [],
      followUps: ["How do I retry this on Copilot?"],
    })),
    generateText: vi.fn(async () => "fallback"),
    generateWithClientTools: vi.fn(async () => ({ text: "ok", client_tools: [] })),
  };
});

import { handleChat } from "@/lib/copilot/handle";

const base = { user_id: "guest", tier: "free" as const, smart_account: null };

describe("assistant diagnosis lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers a failure question from session events without executing", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "why did my transaction fail",
      session_events: [
        {
          kind: "wallet_rejected",
          message: "Transaction cancelled by user.",
          at: 1,
        },
      ],
    });
    expect(res.kind).toBe("answer");
    expect(res.intent?.template_id).toBe("page_assist");
    expect(res.intent?.slots?.mode).toBe("diagnosis");
    expect(res.kind).not.toBe("executed");
    expect(res.message.toLowerCase()).toMatch(/wallet|cancelled|closed/);
  });

  it("still refuses a write on the same surface", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "deposit 5 XLM as collateral",
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
  });
});
