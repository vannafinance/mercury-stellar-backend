import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { shouldAutoResume } from "@/components/copilot/resume-policy";

describe("unsized farm add → amount card, not a prose ask", () => {
  it("add liquidity on Aquarius XLM/USDC pool is add_liquidity with no amount", () => {
    const r = routeMessage("Can You Add Liquidity on Aquarius XLM/USDC Pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
    expect(r.amount == null || r.amount === 0).toBe(true);
    expect(String(r.token_b).toUpperCase()).toBe("AQUSDC");
  });

  it("add liquidity in Soroswap pool is add_liquidity SOUSDC, no amount", () => {
    const r = routeMessage("add liquidity in my soroswap pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
    expect(String(r.token_b).toUpperCase()).toBe("SOUSDC");
    expect(r.amount == null || !(r.amount > 0)).toBe(true);
  });

  it("add 100 XLM liquidity in Aquarius is a single write (ratio fill), not a 1-step plan flag", () => {
    const r = routeMessage("Can You Add 100 XLM Liquidity in Aquarius XLM USDC Farm Pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
    expect(r.amount).toBe(100);
    expect(r.multi_leg).toBe(false);
  });

  it("add liquidity in Blend pool is Blend supply, not Aquarius LP", () => {
    const r = routeMessage("add liquidity in my blend pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("deploy_to_blend");
    expect(r.amount == null || !(r.amount > 0)).toBe(true);
  });

  it("unsized blend supply does not auto-resume", () => {
    expect(
      shouldAutoResume({
        complete: false,
        clientTail: [{ op: "deploy_to_blend", amount: null }],
        preferFlag: true,
      }),
    ).toBe(false);
  });
});
