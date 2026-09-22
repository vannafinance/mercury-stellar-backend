/**
 * Reported live, 21 Sep: "provide 20 XLM and AQUSDC liquidity on aquarius" — the
 * catalogue's own documented shape for this write (docs/Vanna_Copilot_Test_Prompt_Catalogue,
 * row L1) — refused with "BLUSDC is the Blend-side USDC SAC... Aquarius AMM LP is a
 * different pool that spends AQUSDC, not BLUSDC", naming a token the user never
 * mentioned.
 *
 * Root cause: `hasAmmLpIntent` and the deterministic LP branch in `routeMessage` both
 * required the verb and "liquidity" to sit ADJACENT as a phrase ("add liquidity",
 * "provide liquidity"). In "provide 20 XLM and AQUSDC liquidity on aquarius" the
 * amounts sit between "provide" and "liquidity", so the phrase never matched, the
 * message fell through to a different branch, and that branch's own fallback resolved
 * the unstated second token to the BLUSDC default — which `staticStepBlocker` then
 * correctly (but confusingly) refused, since BLUSDC is never valid on an AMM.
 *
 * The fix does not touch that fallback or the refusal — both are correct once a
 * message actually reaches them. It stops "provide ... liquidity" from reaching them
 * in the first place, by matching the verb and "liquidity" independently rather than
 * as a fixed phrase.
 */
import { describe, expect, it } from "vitest";
import { hasAmmLpIntent, routeMessage } from "@/lib/copilot/router";

describe("hasAmmLpIntent recognises a non-adjacent verb", () => {
  it("THE LIVE BUG: 'provide 20 XLM and AQUSDC liquidity on aquarius'", () => {
    expect(hasAmmLpIntent("provide 20 XLM and AQUSDC liquidity on aquarius")).toBe(true);
  });

  it("still recognises the adjacent phrases", () => {
    for (const ask of ["add liquidity to aquarius", "provide liquidity on soroswap", "add lp"]) {
      expect(hasAmmLpIntent(ask)).toBe(true);
    }
  });

  it("still recognises 'remove liquidity'", () => {
    expect(hasAmmLpIntent("remove liquidity from aquarius")).toBe(true);
  });

  it("does not fire on an ordinary deposit or lend", () => {
    for (const ask of ["deposit 100 XLM as collateral", "lend 10 SOUSDC", "add 5 XLM to my collateral"]) {
      expect(hasAmmLpIntent(ask)).toBe(false);
    }
  });
});

describe("'provide <amount> <A> and <B> liquidity on <venue>' routes to add_liquidity", () => {
  it("THE LIVE BUG, end to end: names AQUSDC, never BLUSDC", () => {
    const r = routeMessage("provide 20 XLM and AQUSDC liquidity on aquarius");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
    expect(r.token_a).toBe("XLM");
    expect(r.token_b).toBe("AQUSDC");
    expect(r.amount_a).toBe(20);
  });

  it("the Soroswap catalogue row (L2) resolves to SOUSDC, never BLUSDC", () => {
    const r = routeMessage("add 15 XLM and SOUSDC liquidity on soroswap");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
    expect(r.token_a).toBe("XLM");
    expect(r.token_b).toBe("SOUSDC");
    expect(r.amount_a).toBe(15);
  });

  it("a stated pair amount still beats the single-amount path", () => {
    const r = routeMessage("provide 20 XLM and 5 AQUSDC liquidity on aquarius");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("add_liquidity");
    expect(r.amount_a).toBe(20);
    expect(r.amount_b).toBe(5);
  });
});
