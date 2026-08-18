/**
 * Reported live, three related fixes:
 *
 * 14. "What is Balance of XLM in my Margin Account" (a word-order variant of an already-
 *     fixed phrasing, "What is my XLM Balance in Margin account?") fell to the generic
 *     capabilities blurb. Both keyword-route to `query_collateral` identically —
 *     `query_collateral`/`query_debt` were simply never added to handleChat's
 *     "keywordConfident" allowlist, so even a correct keyword match still went to Vertex
 *     "to confirm," and Vertex's own guess (not the router's) decided the answer —
 *     non-deterministic by word order.
 * 13. "USDC pool stats" (bare "USDC", no variant named) silently defaulted to the Vanna
 *     Earn pool's own reserve with no indication that BLUSDC/AQUSDC/SOUSDC are three
 *     separate deployments — the same "which USDC variant" ambiguity this session
 *     already resolves for writes (`ambiguousUsdcSlot`), never applied to this read.
 * 15. "Can I borrow 20 BLUSDC?" — one of the product's own suggested prompts — answered
 *     "You cannot borrow 20 BLUSDC from the Vanna earn pool because your collateral
 *     health is insufficient." `vanna_can_borrow`/`vanna_can_withdraw` are margin-only
 *     tools (`collateral_health` is meaningless for an Earn deposit), but this generic
 *     read path has no dedicated handler, so `venue` and the venue's name inside the
 *     prose were both a free-form guess by the formatting model from the tool name
 *     alone, with no venue hint — it guessed "Earn" from the BLUSDC/AQUSDC/SOUSDC
 *     symbols alone.
 */
import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("query_collateral/query_debt are on the keywordConfident allowlist", () => {
  it("both word-order variants of the XLM balance question route identically", () => {
    for (const ask of [
      "What is my XLM Balance in Margin account?",
      "What is Balance of XLM in my Margin Account",
    ]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("read");
      if (r.kind === "read") expect(r.template_id, ask).toBe("query_collateral");
    }
  });
});

describe("bare 'USDC pool stats' shows every Earn pool, not one silent guess", () => {
  it("routes 'USDC pool stats' to the all-pools read", () => {
    const r = routeMessage("USDC pool stats");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_all_earn_pools");
  });

  it("a named variant still gets its own single-pool read", () => {
    for (const [ask, expectedSymbol] of [
      ["BLUSDC pool stats", "BLUSDC"],
      ["AQUSDC pool stats", "AQUSDC"],
    ] as const) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("read");
      if (r.kind === "read") {
        expect(r.template_id, ask).toBe("query_pool_stats");
        expect(r.args, ask).toMatchObject({ symbol: expectedSymbol });
      }
    }
  });

  it("a venue-named question with no ticker is unaffected (existing behaviour)", () => {
    const r = routeMessage("how much liquidity is in the aquarius pool");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_pool_stats");
  });
});

const mocks = vi.hoisted(() => ({ mcpCall: vi.fn(), vertexExplainStructured: vi.fn() }));
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return {
    ...actual,
    vertexSelectTool: vi.fn().mockRejectedValue(new Error("no network in test")),
    vertexExplainStructured: mocks.vertexExplainStructured,
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

describe("the earn-pools listing filters by what was asked and drops the '·'/card clutter", () => {
  it("'USDC pool stats' lists only the USDC-family pools, never XLM", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({ ...base, message: "USDC pool stats" });
      expect(res.intent?.template_id).toBe("query_all_earn_pools");
      expect(res.message).toContain("BLUSDC");
      expect(res.message).toContain("AQUSDC");
      expect(res.message).toContain("SOUSDC");
      expect(res.message).not.toMatch(/\bXLM\b/);
      // No "·" run-on separators, and no redundant raw "winner ..." facts card.
      expect(res.message).not.toContain("·");
      expect(JSON.stringify(res.data ?? {})).not.toMatch(/winner/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 15_000);

  it("a genuine 'list all earn pools' request still includes XLM", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({ ...base, message: "list all earn pools" });
      expect(res.intent?.template_id).toBe("query_all_earn_pools");
      expect(res.message).toMatch(/\bXLM\b/);
      expect(res.message).toContain("BLUSDC");
      expect(res.message).not.toContain("·");
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 15_000);
});

describe("THE LIVE BUG: a borrow-eligibility check is never labelled as the Earn pool", () => {
  it("corrects venue and headline wording for vanna_can_borrow", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    // Simulate the model's own (wrong) guess — this is what it produced live.
    mocks.vertexExplainStructured.mockResolvedValue({
      headline: "You cannot borrow 20 BLUSDC from the Vanna earn pool because your collateral health is insufficient.",
      facts: [{ label: "allowed to borrow", value: "false" }],
      venue: "earn",
    });
    try {
      const res = await handleChat({ ...base, message: "Can I borrow 20 BLUSDC?" });
      expect(res.answer?.venue).toBe("margin");
      expect(res.answer?.headline).not.toMatch(/vanna earn pool/i);
      // Reported live: a second raw-data card underneath duplicated the structured
      // answer's own facts (smart account address, boolean flags, a duplicate "reason"
      // paragraph, full-precision twins of numbers already shown rounded) — dropped
      // entirely now that the structured answer already states everything.
      expect(res.data).toBeUndefined();
      expect(res.answer?.headline).toMatch(/your margin account/i);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  }, 15_000);
});
