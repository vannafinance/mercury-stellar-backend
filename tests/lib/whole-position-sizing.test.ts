import { describe, expect, it, vi } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { isWriteLeg, type RunLeg } from "@/components/copilot/run-execution-card";
import { formatExactDecimalAmount } from "@/lib/utils/format-amount";

describe("F6: whole-position sizing and exit ops consistency", () => {
  describe("router whole-position intent extraction", () => {
    it("redeem all my AQUSDC from earn routes to redeem with fraction 1, not requiring amount", () => {
      const r = routeMessage("redeem all my AQUSDC from earn");
      expect(r.kind).toBe("write");
      if (r.kind !== "write") return;
      expect(r.op).toBe("redeem");
      expect(r.asset).toBe("AQUSDC");
      expect(r.fraction).toBe(1);
      expect(r.requires_amount).toBe(false);
    });

    it("redeem half my XLM from earn routes with fraction 0.5", () => {
      const r = routeMessage("redeem 50% of my XLM from earn");
      expect(r.kind).toBe("write");
      if (r.kind !== "write") return;
      expect(r.op).toBe("redeem");
      expect(r.asset).toBe("XLM");
      expect(r.fraction).toBe(0.5);
      expect(r.requires_amount).toBe(false);
    });

    it("proves whole-position sizing on an un-enumerated asset", () => {
      const r = routeMessage("redeem all my SOUSDC from earn");
      expect(r.kind).toBe("write");
      if (r.kind !== "write") return;
      expect(r.op).toBe("redeem");
      expect(r.asset).toBe("SOUSDC");
      expect(r.fraction).toBe(1);
      expect(r.requires_amount).toBe(false);
    });
  });

  describe("micro-dust rounding and zero refusal", () => {
    it("dust 7e-7 rounds to 0 and formats as 0.0000007 without exponent", () => {
      const formatted = formatExactDecimalAmount(7e-7);
      expect(formatted).toBe("0.0000007");
      expect(formatted).not.toMatch(/[eE]/);
    });

    it("smaller sub-decimal dust 1e-8 rounds to 0", () => {
      const formatted = formatExactDecimalAmount(1e-8);
      expect(formatted).toBe("0");
    });
  });
});

describe("F8b: read leg is not counted as settled on-chain leg in warning", () => {
  it("identifies read tools vs write operations", () => {
    const readLeg1: RunLeg = {
      n: 1,
      venue: "farm",
      op: "vanna_get_farm_overview",
      label: "Farm Overview",
      amount: null,
      asset: null,
      status: "ok",
    };
    expect(isWriteLeg(readLeg1)).toBe(false);

    const readLeg2: RunLeg = {
      n: 1,
      venue: "other",
      op: "vanna_get_account_health",
      label: "Account Health",
      amount: null,
      asset: null,
      status: "ok",
    };
    expect(isWriteLeg(readLeg2)).toBe(false);

    const writeLeg1: RunLeg = {
      n: 1,
      venue: "margin",
      op: "deposit_collateral",
      label: "Deposit 100 XLM",
      amount: "100",
      asset: "XLM",
      status: "ok",
      txHash: "0x1234",
    };
    expect(isWriteLeg(writeLeg1)).toBe(true);

    const writeLeg2: RunLeg = {
      n: 1,
      venue: "farm",
      op: "remove_liquidity",
      label: "Remove LP",
      amount: "1.7",
      asset: "LP",
      status: "ok",
    };
    expect(isWriteLeg(writeLeg2)).toBe(true);
  });

  it("proves on an un-enumerated read tool", () => {
    const customReadLeg: RunLeg = {
      n: 1,
      venue: "other",
      op: "query_oracle_feed_overview",
      label: "Oracle Feed",
      amount: null,
      asset: null,
      status: "ok",
    };
    expect(isWriteLeg(customReadLeg)).toBe(false);
  });
});
