/**
 * Reported live, three related LP bugs:
 *
 * 9.  "Can you add 10 XLM and 10 AqUSDC in Aquarius Pool in farm" staged the two amounts
 *     verbatim with no regard for the pool's live reserve ratio — a real AMM add only
 *     works at the current ratio, and the site's own add-liquidity form never lets a user
 *     set both sides independently for exactly this reason (one side is always derived
 *     from the other via the pool's live spot price).
 * 10. Farm positions showed only the underlying token split for an LP holding ("28.904
 *     XLM + 1.9678 USDC"), never the actual LP share count the user holds.
 * 11. "Can you remove 10 LP from farm Aquarius XLM and USDC Pool" fell through every
 *     deterministic route (the `remove_liquidity` gate only recognised "remove liquidity"
 *     as an adjacent phrase, or a bare "half"/"50%" fraction) and reached an LLM that
 *     free-generated a confused "collateral or check your position?" clarify.
 */
import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("'remove <amount> LP from <venue>' routes to remove_liquidity", () => {
  it("THE LIVE BUG: 'Can you remove 10 LP from farm Aquarius XLM and USDC Pool'", () => {
    const r = routeMessage("Can you remove 10 LP from farm Aquarius XLM and USDC Pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("remove_liquidity");
    expect(r.token_b).toBe("AQUSDC");
    expect(r.amount).toBe(10);
  });

  it("still recognises the existing 'remove liquidity' / half phrasings", () => {
    for (const ask of ["remove liquidity from aquarius", "remove half my soroswap lp"]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("write");
      if (r.kind === "write") expect(r.op, ask).toBe("remove_liquidity");
    }
  });

  it("never steals a real margin collateral withdrawal", () => {
    const r = routeMessage("withdraw 20 XLM collateral");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).not.toBe("remove_liquidity");
  });
});

const mocks = vi.hoisted(() => ({
  getPoolStats: vi.fn(),
  getAquariusPoolStats: vi.fn(),
}));
vi.mock("@/lib/soroswap-utils", () => ({
  SoroswapService: { getPoolStats: mocks.getPoolStats },
}));
vi.mock("@/lib/aquarius-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aquarius-utils")>();
  return {
    ...actual,
    AquariusService: { ...actual.AquariusService, getAquariusPoolStats: mocks.getAquariusPoolStats },
  };
});
// "add 10 XLM and 10 AqUSDC in Aquarius Pool" isn't on handleChat's "keywordConfident"
// allowlist, so a real run also asks Vertex to independently confirm the route — a live
// network call this test environment can't make (and which flaked under full-suite load,
// timing out instead of failing fast). Rejecting it exercises the documented fallback.
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vi.fn().mockRejectedValue(new Error("no network in test")) };
});
vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return {
    ...actual,
    computeMarginSnapshot: vi.fn().mockResolvedValue({
      collateralBalances: { XLM: { amount: "1000", usdValue: "110" } },
      borrowedBalances: {},
      totalBorrowedValue: 0,
      grossCollateralValue: 110,
      totalValue: 110,
      avgHealthFactor: 999,
      collateralLeftBeforeLiquidation: 110,
      netAvailableCollateral: 110,
    }),
  };
});

import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

describe("THE LIVE BUG: add_liquidity sizes to the pool's live ratio, not the stated amounts", () => {
  it("corrects a mismatched AQUSDC amount to match live Aquarius reserves", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    // Pool is 1000 XLM : 14 AQUSDC (a 1:0.014 ratio) — 10 XLM should pair with ~0.14
    // AQUSDC, nowhere near the stated 10 AQUSDC.
    mocks.getAquariusPoolStats.mockResolvedValue({
      reserveA: "1000",
      reserveB: "14",
      totalShares: "1000",
    });
    try {
      const res = await handleChat({
        ...base,
        message: "Can you add 10 XLM and 10 AqUSDC in Aquarius Pool in farm",
      });
      const text = JSON.stringify(res);
      // The corrected pairing shows up somewhere in the response (note or step label) —
      // never the untouched, ratio-blind "10 AQUSDC".
      expect(text).toMatch(/0\.14/);
      expect(text).not.toMatch(/"amount_b":10\b/);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 30_000);
});
