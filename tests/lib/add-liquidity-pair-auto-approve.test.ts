/**
 * A sized LP pair is not a missing input, so auto-approve must not stop on it.
 *
 * Live, 22 Sep, auto-approve on: "provide 20 XLM and AQUSDC liquidity on aquarius"
 * came back as a card reading `add liquidity PAUSED · NEEDS INPUT / waiting on you`,
 * with BOTH boxes already filled — 20 XLM and the 0.2273 AQUSDC derived from the live
 * pool ratio — and an Enter button. The multi-leg form stopped the same way: "borrow
 * 20 SOUSDC and provide it with XLM as liquidity on soroswap" settled the borrow, then
 * parked on `Add 109.9761 XLM + 20 SOUSDC` waiting for a click.
 *
 * `handle.ts` returned `kind: "clarification"` for that leg unconditionally. The pause
 * is worth having when the switch is off — the two boxes are how a user edits either
 * side — but it never asked whether the user had already armed autonomous signing, so
 * the one op whose second amount is DERIVED was also the one op the switch could not
 * get past. A swap sails through because its amount arrives stated; here derivation
 * was being read as absence.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vi.fn().mockRejectedValue(new Error("no network in test")) };
});

import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

/**
 * One account per case: the same instruction twice from one account is refused by
 * `handle.ts`'s duplicate-write guard, which would mask what is under test here.
 */
const ACCOUNTS = {
  armed: {
    user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
    smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  },
  unarmed: {
    user_id: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
    smart_account: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LBYUHTKWJSRNMFVW",
  },
} as const;

async function addLiquidity(sessionSigning: boolean) {
  process.env.MCP_MODE = "mock";
  resetMcpClient();
  try {
    return (await handleChat({
      ...(sessionSigning ? ACCOUNTS.armed : ACCOUNTS.unarmed),
      tier: "free" as const,
      message: "provide 20 XLM and AQUSDC liquidity on aquarius",
      session_signing: sessionSigning,
    })) as { kind: string; message: string; data?: { lp_input?: unknown } };
  } finally {
    delete process.env.MCP_MODE;
    resetMcpClient();
  }
}

describe("THE LIVE BUG: a sized LP pair stops on 'needs input' with auto-approve armed", () => {
  it("does not ask for input when the switch is on and both sides are sized", async () => {
    const res = await addLiquidity(true);
    expect(res.kind).not.toBe("clarification");
    // The verbatim copy from the card in the screenshot — if this comes back, the
    // armed session is being asked to agree to arithmetic it already authorised.
    expect(res.message ?? "").not.toMatch(/edit either box or sign as-is/i);
  }, 30_000);

  /**
   * The pause itself is not the bug and must survive: with the switch off, the two
   * boxes are the only way to edit either side before signing.
   */
  it("still pauses for the two boxes when the switch is off", async () => {
    const res = await addLiquidity(false);
    expect(res.kind).toBe("clarification");
    expect(res.message).toMatch(/edit either box or sign as-is/i);
    expect(res.data?.lp_input).toBeTruthy();
  }, 30_000);
});
