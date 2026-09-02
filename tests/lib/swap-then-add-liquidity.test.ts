/**
 * Reported live: "Swap 10 XLM to AQUSDC and add liquidity in Aquarius" executed ONLY
 * the swap — no plan preview, no LP leg. Same class of bug for Soroswap.
 *
 * Root cause (three independent verb/override lists that all missed AMM LP phrases):
 *   1. looksLikeMultiGoal never counted "add liquidity" as a second action
 *   2. tryMultiGoalPlan's multiGoalShape / step-builder same gap
 *   3. handle.ts's Aquarius LP override rewrote any "add liquidity in Aquarius" message
 *      into a SINGLE add_liquidity write, even when a swap clause sat next to it
 *
 * Farm page: LP / Multiple = Aquarius or Soroswap XLM/USDC. The swap feeding an LP
 * leg must use that same venue (AQUSDC → Aquarius, SOUSDC → Soroswap).
 */
import { describe, expect, it, vi } from "vitest";
import { looksLikeMultiGoal, preferMultiGoalPlan } from "@/lib/copilot/plan-sanitize";
import { routeMessage } from "@/lib/copilot/router";
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const vertexSwap = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    kind: "write",
    op: "swap",
    asset: "XLM",
    amount: 10,
    token_a: "XLM",
    token_b: "AQUSDC",
    multi_leg: false,
    requires_account: true,
    requires_amount: true,
    template_id: "swap",
  }),
);
vi.mock("@/lib/copilot/vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/vertex")>();
  return { ...actual, vertexSelectTool: vertexSwap };
});

describe("swap then add liquidity is a two-leg farm LP plan", () => {
  const AQUARIUS = "Swap 10 XLM to AQUSDC and add liquidity in Aquarius";
  const SOROSWAP = "Swap 10 XLM to SOUSDC and add liquidity in Soroswap";

  it("looksLikeMultiGoal recognises swap + add liquidity (any named AMM)", () => {
    expect(looksLikeMultiGoal(AQUARIUS)).toBe(true);
    expect(looksLikeMultiGoal(SOROSWAP)).toBe(true);
    expect(looksLikeMultiGoal("Swap 10 XLM to AQUSDC then provide liquidity on aquarius")).toBe(
      true,
    );
    // A single swap, or a single LP add, is still one action.
    expect(looksLikeMultiGoal("Swap 10 XLM to AQUSDC")).toBe(false);
    expect(looksLikeMultiGoal("add liquidity in Aquarius")).toBe(false);
  });

  it("THE LIVE BUG: routes to a plan, swap then add_liquidity, both on Aquarius", () => {
    const r = routeMessage(AQUARIUS);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const writes = r.steps.filter((s) => s.kind === "write");
    expect(writes.map((s) => s.op)).toEqual(["swap", "add_liquidity"]);
    const swap = writes[0];
    const lp = writes[1];
    expect(swap.amount).toBe(10);
    expect(swap.args?.token_out ?? swap.args?.token_b).toBe("AQUSDC");
    expect(String(swap.args?.venue).toLowerCase()).toBe("aquarius");
    expect(lp.args?.venue).toBe("aquarius");
    expect(lp.args?.token_a).toBe("XLM");
    expect(lp.args?.token_b).toBe("AQUSDC");
  });

  it("the same shape on Soroswap uses SOUSDC and the soroswap venue on BOTH legs", () => {
    const r = routeMessage(SOROSWAP);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const writes = r.steps.filter((s) => s.kind === "write");
    expect(writes.map((s) => s.op)).toEqual(["swap", "add_liquidity"]);
    expect(writes[0].args?.token_out ?? writes[0].args?.token_b).toBe("SOUSDC");
    expect(String(writes[0].args?.venue).toLowerCase()).toBe("soroswap");
    expect(writes[1].args?.venue).toBe("soroswap");
    expect(writes[1].args?.token_b).toBe("SOUSDC");
  });

  it("a named LP venue wins the swap venue even if the swap clause did not repeat it", () => {
    const r = routeMessage("swap 10 XLM to USDC and add liquidity in Soroswap");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const swap = r.steps.find((s) => s.kind === "write" && s.op === "swap");
    const lp = r.steps.find((s) => s.kind === "write" && s.op === "add_liquidity");
    expect(String(swap?.args?.venue).toLowerCase()).toBe("soroswap");
    expect(lp?.args?.venue).toBe("soroswap");
    expect(swap?.args?.token_out ?? swap?.args?.token_b).toBe("SOUSDC");
    expect(lp?.args?.token_b).toBe("SOUSDC");
  });

  it("preferMultiGoalPlan recovers when Vertex collapses the sentence to a single swap", () => {
    const kw = routeMessage(AQUARIUS);
    expect(kw.kind).toBe("plan");
    const collapsed = {
      kind: "write" as const,
      op: "swap",
      asset: "XLM",
      amount: 10,
      token_a: "XLM",
      token_b: "AQUSDC",
      multi_leg: false,
      requires_account: true,
      requires_amount: true,
      template_id: "swap",
    };
    const recovered = preferMultiGoalPlan(collapsed, kw, AQUARIUS);
    expect(recovered.kind).toBe("plan");
    if (recovered.kind !== "plan") return;
    expect(recovered.steps.filter((s) => s.kind === "write").map((s) => s.op)).toEqual([
      "swap",
      "add_liquidity",
    ]);
  });

  it("does not steal a plain single-leg swap or a plain single-leg add_liquidity", () => {
    const swap = routeMessage("swap 10 XLM to AQUSDC");
    expect(swap.kind).toBe("write");
    if (swap.kind === "write") expect(swap.op).toBe("swap");

    const lp = routeMessage("add liquidity in Aquarius");
    expect(lp.kind).toBe("write");
    if (lp.kind === "write") expect(lp.op).toBe("add_liquidity");
  });

  it("Swap 100 XLM into SOUSDC and Add Liquidity in Soroswap Pool is still swap then LP", () => {
    const r = routeMessage("Swap 100 XLM into SOUSDC and Add Liquidity in Soroswap Pool");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const writes = r.steps.filter((s) => s.kind === "write");
    expect(writes.map((s) => s.op)).toEqual(["swap", "add_liquidity"]);
    expect(writes[0].amount).toBe(100);
    expect(writes[0].args?.token_out ?? writes[0].args?.token_b).toBe("SOUSDC");
    expect(writes[1].args?.venue).toBe("soroswap");
    expect(writes[1].args?.token_b).toBe("SOUSDC");
  });

  it("Swap XLM to SOUSDC & Add Liquidity in Soroswap Position is a 2-leg plan even without a size", () => {
    const r = routeMessage("Swap XLM to SOUSDC & Add Liquidity in Soroswap Position");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.steps.filter((s) => s.kind === "write").map((s) => s.op)).toEqual([
      "swap",
      "add_liquidity",
    ]);
  });

  it("handleChat still returns a 2-step plan_preview when Vertex answers with only the swap", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
        smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
        tier: "free",
        surface: "copilot",
        message: AQUARIUS,
      });
      expect(res.kind).toBe("plan_preview");
      expect(res.plan?.steps?.map((s) => s.op)).toEqual(["swap", "add_liquidity"]);
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});
