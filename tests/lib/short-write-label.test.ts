import { describe, expect, it } from "vitest";
import { humanizeStroopCounts, shortWriteLabel } from "@/lib/copilot/execution-copy";
import { routeMessage } from "@/lib/copilot/router";

describe("shortWriteLabel — one sentence on every staged write", () => {
  it("lend is Deposit N ASSET in Lending Pool", () => {
    expect(shortWriteLabel({ op: "lend", amount: 100, asset: "AQUSDC" })).toBe(
      "Deposit 100 AQUSDC in Lending Pool",
    );
  });

  it("borrow / blend supply stay one line", () => {
    expect(shortWriteLabel({ op: "borrow", amount: 100, asset: "BLUSDC" })).toBe("Borrow 100 BLUSDC");
    expect(shortWriteLabel({ op: "deploy_to_blend", amount: 30, asset: "BLUSDC" })).toBe(
      "Supply 30 BLUSDC to Blend",
    );
  });
});

describe("add liquidity in Blend is a Blend supply write, not pool stats", () => {
  it("Can you add 30 BLUSDC Liquidity in Blend Pool → deploy_to_blend 30 BLUSDC", () => {
    const r = routeMessage("Can you add 30 BLUSDC Liquidity in Blend Pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("deploy_to_blend");
    expect(r.amount).toBe(30);
    expect(String(r.asset).toUpperCase()).toBe("BLUSDC");
  });

  it("add liquidity in Aquarius stays AMM add_liquidity", () => {
    const r = routeMessage("add liquidity in Aquarius");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
  });
});

describe("humanizeStroopCounts — Sign Service errors in tokens, not stroops", () => {
  it("rewrites spent_today / amount / max_per_day as XLM", () => {
    const raw =
      "spent_today 752883225 + amount 10000000000 > max_per_day 10000000000";
    const out = humanizeStroopCounts(raw, "XLM");
    expect(out).not.toMatch(/10000000000/);
    expect(out).toContain("75.2883225 XLM");
    expect(out).toContain("1000 XLM");
  });
});
