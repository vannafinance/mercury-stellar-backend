import { describe, it, expect } from "vitest";
import { verifyApprovedPlan, freezePlan } from "@/lib/copilot/plan-approval";
import { rememberConnectOrigin, resolveConnectOrigin } from "@/lib/copilot/wallet-bind";
import { evaluateWriteRisk } from "@/lib/copilot/risk";
import { writeDedupeKey, claimOnce } from "@/lib/copilot/write-dedupe";

describe("Copilot Brain Audit Fixes Verification", () => {
  it("BRAIN-001: verifyApprovedPlan preserves fraction, token_b, venue, min_hf at top level", () => {
    const frozen = freezePlan(
      {
        kind: "plan",
        template_id: "test_plan",
        steps: [
          {
            kind: "write",
            op: "remove_liquidity",
            asset: "AQUSDC",
            amount: 50,
            token_a: "XLM",
            token_b: "AQUSDC",
            fraction: 0.5,
            venue: "aquarius",
            min_hf: 1.5,
            args: { fraction: 0.5, venue: "aquarius", min_hf: 1.5, token_b: "AQUSDC" },
          },
        ],
      },
      Date.now(),
    );

    const approved = {
      plan_id: frozen.plan_id,
      created_at: frozen.created_at,
      steps: frozen.steps.map((s) => ({
        op: s.op,
        slots: s.slots,
        asset: s.asset,
        amount: s.amount,
      })),
    };

    const check = verifyApprovedPlan(approved, Date.now());
    expect(check.ok).toBe(true);
    if (check.ok) {
      const step = check.plan.steps[0];
      expect(step.kind).toBe("write");
      if (step.kind === "write") {
        expect(step.fraction).toBe(0.5);
        expect(step.token_b).toBe("AQUSDC");
        expect(step.venue).toBe("aquarius");
        expect(step.min_hf).toBe(1.5);
      }
    }
  });

  it("BRAIN-002: cross-asset risk simulation uses borrow asset price", async () => {
    const mockMcp = {
      call: async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vanna_get_price") {
          const sym = String(args.symbol || "").toUpperCase();
          if (sym === "AQUSDC" || sym === "USDC") return { price_usd: 1.0 };
          if (sym === "XLM") return { price_usd: 0.10 };
          return { price_usd: 1.0 };
        }
        if (tool === "vanna_get_account_health") {
          return { collateral_usd: 1000, debt_usd: 0, health_factor: null };
        }
        return {};
      },
    };

    const res = await evaluateWriteRisk(mockMcp as any, {
      action: {
        op: "borrow",
        asset: "XLM",
        amount: 1000, // 1000 XLM @ $0.10 = $100 debt (NOT $1000 debt)
        borrow_asset: "XLM",
        requires_account: true,
      } as any,
      amount: 1000,
      smartAccount: "C_SMART_ACC",
    });

    expect(res.simulation).toBeDefined();
    // 1000 XLM * $0.10 = $100 debt -> Gross Assets = $1000 + $100 = $1100 -> HF = $1100 / $100 debt = 11.0
    expect(res.simulation?.debt_after).toBe(100);
    expect(res.simulation?.hf_after).toBe(11.0);
  });

  it("BRAIN-003: rememberConnectOrigin allows Vanna domains and rejects unknown origins", () => {
    rememberConnectOrigin("req_vanna", "https://vanna.finance/connect");
    expect(resolveConnectOrigin("req_vanna")).toBe("https://vanna.finance");

    rememberConnectOrigin("req_staging", "https://staging.vanna.finance/connect");
    expect(resolveConnectOrigin("req_staging")).toBe("https://staging.vanna.finance");

    rememberConnectOrigin("req_evil", "https://evil-attacker-site.com/connect");
    expect(resolveConnectOrigin("req_evil")).toBeNull();
  });

  it("BRAIN-005: writeDedupeKey distinguishes different stepIndex in multi-leg plans", () => {
    const key1 = writeDedupeKey({ trader: "G_USER", op: "deposit_collateral", asset: "XLM", amount: 10, stepIndex: 1 });
    const key2 = writeDedupeKey({ trader: "G_USER", op: "deposit_collateral", asset: "XLM", amount: 10, stepIndex: 2 });
    expect(key1).not.toBe(key2);

    const now = Date.now();
    expect(claimOnce(key1, now)).toBe(true);
    expect(claimOnce(key2, now)).toBe(true); // both succeed because keys differ by stepIndex
  });
});
