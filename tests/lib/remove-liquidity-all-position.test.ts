import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

/**
 * "Remove my liquidity" with no number and no "half" is an explicit whole-position
 * removal — the same reading `withdraw_from_blend` already gives "Remove my XLM
 * position from Blend" (handle.ts: "stating the position IS the size, not a request
 * to be asked").
 *
 * Live, 21 Sep: "remove everything: remove my liquidity, exit blend, redeem from
 * earn and repay what I owe" paused on leg 1 asking "Amount missing for 'remove
 * liquidity'. Include a size like '10 BLUSDC' or '20 XLM'" — on a clause that named
 * no size because it meant all of it. The clause that TRIGGERED this branch
 * ("remove my liquidity", already one of the recognised phrases) was never read as
 * an answer to its own question.
 *
 * Two bugs closed together, because fixing either alone leaves the other:
 *   1. router.ts never set `fraction: 1` for a bare removal — only "half"/"50%" set
 *      anything at all.
 *   2. handle.ts's amount resolver explicitly excluded `fraction === 1` from the
 *      live-read-and-multiply every OTHER fraction got (`< 1`, not `<= 1`), so even
 *      a correctly-recognised whole-position removal would have fallen through to
 *      the same clarification. See remove-liquidity-args.test.ts for the final
 *      MCP-argument layer, which already turns `fraction: 1` into `remove_all: true`
 *      and was the one piece already correct.
 */

describe("'remove my liquidity' with no stated size means all of it", () => {
  it("sizes a bare removal to the whole position, not a clarification", () => {
    const r = routeMessage("remove my liquidity");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("remove_liquidity");
    expect(r.fraction).toBe(1);
    expect(r.amount).toBeNull();
    expect(r.requires_amount).toBe(false);
  });

  it("still reads 'half' as a fraction, not all of it", () => {
    const r = routeMessage("remove half my liquidity");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.fraction).toBe(0.5);
    expect(r.requires_amount).toBe(false);
  });

  it("still reads an explicit amount as itself, not all of it", () => {
    const r = routeMessage("remove 10 LP from Aquarius XLM and USDC Pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.amount).toBe(10);
    expect(r.fraction).toBeNull();
    // Unchanged by this fix: an explicit amount always carried `requires_amount: true`
    // here, independently of whether `amount` was already populated.
    expect(r.requires_amount).toBe(true);
  });

  it("reads 'withdraw all my liquidity' the same way", () => {
    const r = routeMessage("withdraw all my liquidity from soroswap");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("remove_liquidity");
    expect(r.fraction).toBe(1);
    expect(r.token_b).toBe("SOUSDC");
  });

  it("names the pool token from the venue even on a whole-position removal", () => {
    const r = routeMessage("remove my liquidity from aquarius");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.token_b).toBe("AQUSDC");
    expect(r.fraction).toBe(1);
  });
});
