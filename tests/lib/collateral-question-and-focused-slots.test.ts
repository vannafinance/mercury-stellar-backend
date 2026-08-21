/**
 * Reported live, issue #14: "How much collateral do I have?" — one of the product's
 * own suggested prompts — fell through to the generic capabilities blurb. The fixed
 * phrase list matched "my collateral"/"collateral value" but not this word order.
 *
 * Issue #15: "Why is it showing 'Repay 2 USDC'? When I asked 'How much do I owe?'"
 * The debt/collateral snapshot answer never populated `intent.slots.amount`/`symbol`
 * at all, so the client's follow-up suggestion always fell back to a canned
 * "Repay 2 USDC" placeholder with no relation to the real (multi-asset) total. A
 * question that narrows to exactly one asset should populate real slots so an
 * accurate follow-up can be built; a multi-asset total still has no single figure.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("'How much collateral do I have?' routes to the collateral read", () => {
  it("routes without 'my' or 'value'", () => {
    const r = routeMessage("How much collateral do I have?");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_collateral");
  });

  it("still routes the existing fixed phrasings", () => {
    for (const ask of ["my collateral", "collateral value", "how much have i deposited"]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("read");
      if (r.kind === "read") expect(r.template_id, ask).toBe("query_collateral");
    }
  });
});

const mocks = vi.hoisted(() => ({ computeMarginSnapshot: vi.fn() }));
vi.mock("@/lib/account-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-snapshot")>();
  return { ...actual, computeMarginSnapshot: mocks.computeMarginSnapshot };
});
// query_debt/query_collateral aren't on handleChat's "keywordConfident" allowlist, so a
// real run also asks Vertex to independently confirm the route — a live network call
// this test environment can't make. Rejecting it exercises the documented fallback
// ("vertex route failed, keyword fallback") instead of hanging on a real request.
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vi.fn().mockRejectedValue(new Error("no network in test")) };
});

import { handleChat } from "@/lib/copilot/handle";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

const multiAssetDebtSnapshot = () => ({
  borrowedBalances: {
    AQUSDC: { amount: "157.71", usdValue: "157.86" },
    BLUSDC: { amount: "147.71", usdValue: "147.85" },
    SOUSDC: { amount: "31.47", usdValue: "31.50" },
  },
  collateralBalances: { XLM: { amount: "1105", usdValue: "174.16" } },
  totalBorrowedValue: 337.21,
  grossCollateralValue: 174.16,
  totalValue: 174.16,
  avgHealthFactor: 2.08,
  collateralLeftBeforeLiquidation: 100,
  netAvailableCollateral: 100,
  borrowRate: 0,
  debtLimit: 200,
});

describe("the debt/collateral snapshot answer's follow-up slots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeMarginSnapshot.mockResolvedValue(multiAssetDebtSnapshot());
  });

  it("does NOT populate a fabricated amount/symbol for a multi-asset 'how much do I owe' total", async () => {
    const res = await handleChat({ ...base, message: "how much do I owe" });
    expect(res.kind).toBe("answer");
    expect(res.intent?.slots?.amount).toBeUndefined();
    expect(res.intent?.slots?.symbol).toBeUndefined();
  });

  it("populates the real amount/symbol when the question narrows to one asset", async () => {
    const res = await handleChat({ ...base, message: "how much AQUSDC do I owe" });
    expect(res.kind).toBe("answer");
    expect(res.intent?.slots?.symbol).toBe("AQUSDC");
    expect(res.intent?.slots?.amount).toBeTruthy();
  });
});

/**
 * Reported live — a follow-up to the fix above: "What is my XLM Balance in Margin
 * account?" correctly answered "You have 6,975.1535 XLM ($1078.76) of collateral." in
 * PROSE, but its facts CARD still dumped health factor, debt, net value, both
 * liquidation figures, and every other asset's amount — the exact "gross amount only"
 * violation this session already fixed for named single-figure margin questions. A
 * focused single-asset question must narrow the card the same way it narrows the
 * sentence.
 */
describe("a focused single-asset question narrows the facts card too, not just the prose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeMarginSnapshot.mockResolvedValue({
      borrowedBalances: {
        BLUSDC: { amount: "147.71", usdValue: "147.85" },
      },
      collateralBalances: {
        XLM: { amount: "6995.1535", usdValue: "1078.76" },
        SOUSDC: { amount: "1230.24", usdValue: "1231.23" },
      },
      totalBorrowedValue: 147.85,
      grossCollateralValue: 2309.99,
      totalValue: 2309.99,
      avgHealthFactor: 4.74,
      collateralLeftBeforeLiquidation: 2091.08,
      netAvailableCollateral: 2148.56,
      borrowRate: 0,
      debtLimit: 200,
    });
  });

  it("shows only the asked-about asset's amount — no health factor, debt, or other assets", async () => {
    const res = await handleChat({ ...base, message: "What is my XLM Balance in Margin account?" });
    expect(res.kind).toBe("answer");
    const facts = res.data as Record<string, unknown>;
    const keys = Object.keys(facts).join(" | ").toLowerCase();
    expect(keys).toContain("xlm");
    for (const noise of ["health factor", "debt usd", "net value", "liquidation", "sousdc", "blusdc"]) {
      expect(keys, `unexpected "${noise}" in a focused XLM balance card: ${keys}`).not.toContain(noise);
    }
  });

  it("an unfocused whole-account question still gets the full breakdown", async () => {
    const res = await handleChat({ ...base, message: "how much collateral do I have" });
    expect(res.kind).toBe("answer");
    const facts = res.data as Record<string, unknown>;
    const keys = Object.keys(facts).join(" | ").toLowerCase();
    expect(keys).toContain("health factor");
    expect(keys).toContain("xlm");
    expect(keys).toContain("sousdc");
    expect(res.answer?.headline).toMatch(/Total Collateral/i);
    expect(res.answer?.kicker).toMatch(/detailed stats/i);
  });
});
