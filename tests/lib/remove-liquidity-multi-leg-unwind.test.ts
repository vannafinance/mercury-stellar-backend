/**
 * "Remove everything" — a full account unwind — must not ask for a number by
 * leaving the box blank when the user's own words already gave the answer.
 *
 * Live, 21 Sep: "remove everything: remove my liquidity, exit blend, redeem from
 * earn and repay what I owe" paused on leg 1 of 4:
 *
 *   "Amount missing for 'remove liquidity'. Include a size like '10 BLUSDC' or
 *   '20 XLM'."
 *
 * A confirm-before-removing pause is `handle.ts`'s deliberate design for EVERY
 * `remove_liquidity` call — even a literal "remove 10 LP" pauses once, on the
 * first message, for the same reason a swap review card shows before signing.
 * That pause is not what this fixes.
 *
 * What was broken: "remove my liquidity" named no number, so the pause's input box
 * had nothing to prefill and fell back to a generic "10 BLUSDC"/"20 XLM" placeholder
 * — the user had to type their own exact LP balance from memory. The message
 * "meant all of it" and the pause never read that. See
 * remove-liquidity-all-position.test.ts for the isolated router unit; this is the
 * same fix exercised through the real message-handling pipeline this message
 * actually took, end to end.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserLpBalance: vi.fn(),
}));
vi.mock("@/lib/aquarius-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aquarius-utils")>();
  return {
    ...actual,
    AquariusService: { ...actual.AquariusService, getUserLpBalance: mocks.getUserLpBalance },
  };
});
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vi.fn().mockRejectedValue(new Error("no network in test")) };
});

import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
};

describe("THE LIVE BUG: 'remove my liquidity' prefills the pause with the live balance, not a blank box", () => {
  it("prefills the confirm step with the full live LP amount", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    mocks.getUserLpBalance.mockResolvedValue("42.5");
    try {
      const res = await handleChat({ ...base, message: "remove everything: remove my liquidity" }) as {
        kind: string;
        message: string;
        data?: { lp_input?: { held?: number; amount?: number | null } };
        intent?: { slots?: { lp?: number } };
      };
      // The old failure, named verbatim so a regression here fails loudly: a
      // generic placeholder rather than the account's own balance.
      expect(res.message).not.toMatch(/Include a size like/i);
      expect(res.message).toMatch(/42\.5/);
      // The number is not just mentioned in prose — it prefills the input.
      expect(res.data?.lp_input?.held).toBe(42.5);
      expect(res.data?.lp_input?.amount).toBe(42.5);
      expect(res.intent?.slots?.lp).toBe(42.5);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 30_000);

  it("does not regress: an empty LP position still gets a clear, specific refusal", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    mocks.getUserLpBalance.mockResolvedValue("0");
    try {
      const res = await handleChat({ ...base, message: "remove my liquidity" });
      const text = JSON.stringify(res);
      expect(text).toMatch(/0 LP on this account|nothing to remove/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 30_000);

  it("still refuses to remove more than is actually held, even stated as 'all'", async () => {
    // A live position that shrank between the last read and this one: "all of it"
    // must never be inflated past what the account actually holds.
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    mocks.getUserLpBalance.mockResolvedValue("5.2");
    try {
      const res = await handleChat({ ...base, message: "remove my liquidity" }) as {
        data?: { lp_input?: { held?: number; amount?: number | null } };
      };
      expect(res.data?.lp_input?.held).toBe(5.2);
      expect(res.data?.lp_input?.amount).toBe(5.2);
      expect(res.data?.lp_input?.amount).not.toBeGreaterThan(res.data?.lp_input?.held ?? 0);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 30_000);
});
