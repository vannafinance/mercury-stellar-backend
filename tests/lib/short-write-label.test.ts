import { describe, expect, it } from "vitest";
import { humanizeStroopCounts, fmtLpAmt, farmAddedLine, shortWriteLabel } from "@/lib/copilot/execution-copy";
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

  it("swap names both legs", () => {
    expect(shortWriteLabel({ op: "swap", amount: 10, asset: "XLM", token_b: "AQUSDC" })).toBe(
      "Swap 10 XLM → AQUSDC",
    );
  });
});

describe("fmtLpAmt — pair titles stay one line", () => {
  it("rounds the derived XLM side and keeps a whole 10 as 10", () => {
    expect(fmtLpAmt(719.0883528077677)).toBe("719.0884");
    expect(fmtLpAmt(10)).toBe("10");
    expect(`Add ${fmtLpAmt(719.0883528077677)} XLM + ${fmtLpAmt(10)} AQUSDC LP`).toBe(
      "Add 719.0884 XLM + 10 AQUSDC LP",
    );
  });

  it("receipt names both sides of an Aquarius add", () => {
    expect(farmAddedLine("Add 72 XLM + 1.0011 AQUSDC LP")).toBe(
      "Added 72 XLM and 1.0011 AQUSDC in Aquarius",
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
